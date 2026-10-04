import type { Context } from "@earendil-works/chord";
import {
  awaitWithContext,
  BACKGROUND_CONTEXT,
} from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type Storage } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { lock } from "proper-lockfile";
import { assertSafeDataPath } from "../config/data-paths";

function privateFile(path: string): boolean {
  assertSafeDataPath(path);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error("Invalid durable storage file");
    chmodSync(path, 0o600);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function openPrivateSqliteStorage(
  path: string,
  context: Context,
  existing: boolean,
  ownership: AbortSignal,
): Promise<Storage> {
  context.abortSignal?.throwIfAborted();
  ownership.throwIfAborted();
  if (existing) {
    if (!privateFile(path) || lstatSync(path).size === 0)
      throw new Error("Durable context is unavailable");
  } else {
    const fd = openSync(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    closeSync(fd);
  }
  for (const suffix of ["-wal", "-shm", "-journal"])
    privateFile(`${path}${suffix}`);
  const database = await openNodeSqliteDatabase(path);
  try {
    await database.exec("PRAGMA synchronous = FULL");
    if (existing) {
      // SqliteStorage.open initializes absent schema. A saved pointer must
      // instead find the original execution store, never an empty replacement.
      const schema = await database.get<{ version: number }>(
        "SELECT version FROM durable_schema WHERE singleton = 1",
      );
      if (
        !schema ||
        !Number.isSafeInteger(schema.version) ||
        schema.version < 1
      )
        throw new Error("Durable context is unavailable");
    }
    // The SDK ignores commit contexts. Preserve exclusive ownership through
    // every transaction and roll back if the lock is lost during its callback.
    const transaction = database.transaction.bind(database);
    database.transaction = (callback) => {
      ownership.throwIfAborted();
      return transaction(async (tx) => {
        ownership.throwIfAborted();
        const result = await callback(tx);
        ownership.throwIfAborted();
        return result;
      });
    };
    const storage = await SqliteStorage.open(database);
    context.abortSignal?.throwIfAborted();
    ownership.throwIfAborted();
    return storage;
  } catch (error) {
    await database.close().catch(() => {});
    throw error;
  }
}

export async function openPrivateDurableStorage(
  assistantDirectory: string,
  id: string,
  context: Context,
  existing = false,
): Promise<{
  storage: Storage;
  signal: AbortSignal;
  release(): Promise<void>;
}> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      id,
    )
  )
    throw new Error("Invalid durable context identity");
  assistantDirectory = resolve(assistantDirectory);
  const directory = resolve(assistantDirectory, "durable", id);
  const sqlite = join(directory, "execution.sqlite");
  const database = privateFile(sqlite);
  if (existing && !database) throw new Error("Durable context is unavailable");
  if (!existing && database) throw new Error("Durable context already exists");
  for (const path of [assistantDirectory, dirname(directory), directory]) {
    assertSafeDataPath(join(path, ".guard"));
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
  const lockPath = `${directory}.lock`;
  const ownership = new AbortController();
  const deadline = Date.now() + 12_000;
  let release!: () => Promise<void>;
  while (true) {
    context.abortSignal?.throwIfAborted();
    try {
      const stat = lstatSync(lockPath);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error("Invalid durable storage lock");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      release = await lock(directory, {
        realpath: false,
        stale: 10_000,
        update: 2000,
        retries: 0,
        onCompromised: () =>
          ownership.abort(new Error("Durable owner changed")),
      });
      break;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ELOCKED" ||
        Date.now() >= deadline
      )
        throw new Error("Durable storage already has an owner", {
          cause: error,
        });
      await awaitWithContext(
        new Promise<void>((resolveWait) => setTimeout(resolveWait, 100)),
        context,
      );
    }
  }
  let storage: Storage | undefined;
  try {
    chmodSync(lockPath, 0o700);
    context.abortSignal?.throwIfAborted();
    ownership.signal.throwIfAborted();
    storage = await openPrivateSqliteStorage(
      sqlite,
      context,
      existing,
      ownership.signal,
    );
    if (
      existing &&
      !(await storage.conversation(ROOT_CONVERSATION_ID, context))
    )
      throw new Error("Durable context is unavailable");
    context.abortSignal?.throwIfAborted();
    ownership.signal.throwIfAborted();
    return { storage, signal: ownership.signal, release };
  } catch (error) {
    await storage?.close(BACKGROUND_CONTEXT).catch(() => {});
    await release().catch(() => {});
    throw error;
  }
}

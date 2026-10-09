import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  Harness,
  ROOT_CONVERSATION_ID,
  UserEntry,
} from "@earendil-works/pi-durable";
import {
  type SqliteDatabase,
  SqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite";
import { expect, jest, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { openPrivateDurableStorage } from "./durable-storage";

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "roamgate-storage-"));
  const id = randomUUID();
  const path = join(directory, "durable", id, "execution.sqlite");
  const owned = await openPrivateDurableStorage(
    directory,
    id,
    BACKGROUND_CONTEXT,
    false,
  );
  const harness = await Harness.open(
    owned.storage,
    {
      registry: createRegistry(),
      models: createModels(),
    },
    BACKGROUND_CONTEXT,
  );
  try {
    const root = await harness.root(BACKGROUND_CONTEXT);
    await root.commit(
      (tx) =>
        tx.appendEntry(root.id, {
          kind: UserEntry.kind,
          model: [
            { role: "user", content: "Preserved original input", timestamp: 0 },
          ],
        }),
      BACKGROUND_CONTEXT,
    );
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    await owned.storage.close(BACKGROUND_CONTEXT);
    await owned.release();
  }
  return {
    directory,
    id,
    path,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("new SQLite stores use WAL/FULL and recover real SDK history with private file permissions", async () => {
  const original = SqliteStorage.open;
  let configured = 0;
  const opening = spyOn(SqliteStorage, "open").mockImplementation(
    async (database) => {
      expect(await database.get("PRAGMA journal_mode")).toEqual({
        journal_mode: "wal",
      });
      expect(await database.get("PRAGMA synchronous")).toEqual({
        synchronous: 2,
      });
      configured++;
      return original(database);
    },
  );
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    f = await fixture();
    const owned = await openPrivateDurableStorage(
      f.directory,
      f.id,
      BACKGROUND_CONTEXT,
      true,
    );
    try {
      expect(configured).toBe(2);
      const harness = await Harness.open(
        owned.storage,
        {
          registry: createRegistry(),
          models: createModels(),
        },
        BACKGROUND_CONTEXT,
      );
      try {
        const root = await harness.root(BACKGROUND_CONTEXT);
        const entries = await root.entries(
          {},
          100,
          undefined,
          BACKGROUND_CONTEXT,
        );
        expect(JSON.stringify(entries)).toContain("Preserved original input");
        expect(
          existsSync(join(f.directory, "durable", f.id, "main.jsonl")),
        ).toBe(false);
        if (process.platform !== "win32") {
          for (const path of [
            f.directory,
            join(f.directory, "durable"),
            join(f.directory, "durable", f.id),
            `${join(f.directory, "durable", f.id)}.lock`,
          ])
            expect(lstatSync(path).mode & 0o777).toBe(0o700);
          const files = readdirSync(join(f.directory, "durable", f.id));
          expect(files).toContain("execution.sqlite-wal");
          expect(files).toContain("execution.sqlite-shm");
          for (const file of files)
            expect(
              lstatSync(join(f.directory, "durable", f.id, file)).mode & 0o777,
            ).toBe(0o600);
        }
      } finally {
        await harness.close(BACKGROUND_CONTEXT);
        await owned.storage.close(BACKGROUND_CONTEXT);
      }
    } finally {
      await owned.release();
    }
  } finally {
    opening.mockRestore();
    f?.cleanup();
  }
});

test.each([
  "missing",
  "corrupt",
  "empty",
  "uninitialized",
  "missing root",
] as const)(
  "saved SQLite pointers reject %s databases without creating a replacement execution",
  async (failure) => {
    const f = await fixture();
    try {
      if (failure === "missing") rmSync(f.path);
      else if (failure === "corrupt")
        writeFileSync(f.path, "This is not a SQLite database");
      else if (failure === "empty") writeFileSync(f.path, "");
      else if (failure === "uninitialized") {
        rmSync(f.path);
        const database = new DatabaseSync(f.path);
        database.exec("CREATE TABLE unrelated (value TEXT)");
        database.close();
      } else {
        const database = new DatabaseSync(f.path);
        database.exec("DELETE FROM conversations");
        database.close();
      }
      await expect(
        openPrivateDurableStorage(f.directory, f.id, BACKGROUND_CONTEXT, true),
      ).rejects.toThrow();
      expect(existsSync(`${join(f.directory, "durable", f.id)}.lock`)).toBe(
        false,
      );
      expect(existsSync(join(f.directory, "durable", f.id, "main.jsonl"))).toBe(
        false,
      );
      if (failure === "missing") expect(existsSync(f.path)).toBe(false);
      else if (failure === "corrupt")
        expect(readFileSync(f.path, "utf8")).toBe(
          "This is not a SQLite database",
        );
      else {
        // Recovery has released its owner and closed the database. An immutable
        // read inspects the checkpointed WAL file without creating sidecars.
        const before = readFileSync(f.path);
        const files = readdirSync(join(f.directory, "durable", f.id)).sort();
        const uri = pathToFileURL(f.path);
        uri.search = "mode=ro&immutable=1";
        const database = new DatabaseSync(uri, { readOnly: true });
        try {
          if (failure === "missing root")
            expect(
              database
                .prepare("SELECT count(*) AS count FROM conversations")
                .get(),
            ).toEqual({ count: 0 });
          else
            expect(
              database
                .prepare(
                  "SELECT name FROM sqlite_master WHERE name = 'durable_schema'",
                )
                .get(),
            ).toBeUndefined();
        } finally {
          database.close();
        }
        expect(readFileSync(f.path)).toEqual(before);
        expect(readdirSync(join(f.directory, "durable", f.id)).sort()).toEqual(
          files,
        );
      }
    } finally {
      f.cleanup();
    }
  },
);

test.each(["", "-wal", "-shm", "-journal"])(
  "SQLite rejects symlinked database%s paths",
  async (suffix) => {
    const f = await fixture();
    try {
      const sentinel = join(f.directory, "sentinel");
      writeFileSync(sentinel, "Do not change");
      rmSync(`${f.path}${suffix}`, { force: true });
      symlinkSync(sentinel, `${f.path}${suffix}`);
      await expect(
        openPrivateDurableStorage(f.directory, f.id, BACKGROUND_CONTEXT, true),
      ).rejects.toThrow();
      expect(readFileSync(sentinel, "utf8")).toBe("Do not change");
    } finally {
      f.cleanup();
    }
  },
);

test("SQLite rejects hardlinked database files", async () => {
  const f = await fixture();
  try {
    const link = join(f.directory, "database-link");
    linkSync(f.path, link);
    await expect(
      openPrivateDurableStorage(f.directory, f.id, BACKGROUND_CONTEXT, true),
    ).rejects.toThrow();
  } finally {
    f.cleanup();
  }
});

test("SQLite retains its live owner lock while a second owner is canceled", async () => {
  const f = await fixture();
  const owned = await openPrivateDurableStorage(
    f.directory,
    f.id,
    BACKGROUND_CONTEXT,
    true,
  );
  try {
    const controller = new AbortController();
    const second = openPrivateDurableStorage(
      f.directory,
      f.id,
      withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
      true,
    );
    controller.abort();
    await expect(second).rejects.toThrow();
    expect(owned.signal.aborted).toBe(false);
    expect(existsSync(`${join(f.directory, "durable", f.id)}.lock`)).toBe(true);
    expect(
      await owned.storage.conversation(
        ROOT_CONVERSATION_ID,
        BACKGROUND_CONTEXT,
      ),
    ).toBeDefined();
  } finally {
    await owned.storage.close(BACKGROUND_CONTEXT);
    await owned.release();
    f.cleanup();
  }
});

test("SQLite rolls back an in-flight transaction and rejects later SDK commits after losing ownership", async () => {
  const f = await fixture();
  const original = SqliteStorage.open;
  let database: SqliteDatabase | undefined;
  const opening = spyOn(SqliteStorage, "open").mockImplementation(
    async (value) => {
      database = value;
      return original(value);
    },
  );
  jest.useFakeTimers();
  let owned: Awaited<ReturnType<typeof openPrivateDurableStorage>> | undefined;
  try {
    owned = await openPrivateDurableStorage(
      f.directory,
      f.id,
      BACKGROUND_CONTEXT,
      true,
    );
    opening.mockRestore();
    const signal = owned.signal;
    const compromised = new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    await expect(
      database!.transaction(async (tx) => {
        await tx.run("DELETE FROM entries");
        rmSync(`${join(f.directory, "durable", f.id)}.lock`, {
          recursive: true,
        });
        jest.advanceTimersByTime(2100);
        await compromised;
      }),
    ).rejects.toThrow("Durable owner changed");
    expect(signal.aborted).toBe(true);
    const entries = await owned.storage.scanEntries(
      { conversationId: ROOT_CONVERSATION_ID },
      100,
      undefined,
      BACKGROUND_CONTEXT,
    );
    expect(JSON.stringify(entries)).toContain("Preserved original input");
    await expect(owned.storage.commit([], BACKGROUND_CONTEXT)).rejects.toThrow(
      "Durable owner changed",
    );
  } finally {
    jest.useRealTimers();
    opening.mockRestore();
    await owned?.storage.close(BACKGROUND_CONTEXT);
    await owned?.release().catch(() => {});
    f.cleanup();
  }
});

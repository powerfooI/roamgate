import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { lockSync } from "proper-lockfile";
import { assertSafeDataPath, dataRoot } from "./data-paths";

const SECRET_PATTERN = /^[a-f0-9]{64}$/;
const LOCK_WAIT_MS = 5_000;
const lockWait = new Int32Array(new SharedArrayBuffer(4));

type SessionSecretState = {
  version: 1;
  secret: string;
  credentialFingerprint: string;
};

function credentialFingerprint(
  secret: string,
  credentials: readonly string[],
): string {
  // Length-delimited JSON avoids concatenation collisions. Order and duplicate
  // credentials do not change the set of credentials that can authenticate.
  return createHmac("sha256", Buffer.from(secret, "hex"))
    .update("roamgate:session-credentials:v1\0")
    .update(JSON.stringify([...new Set(credentials)].sort()))
    .digest("hex");
}

function readSessionSecret(path: string): SessionSecretState | undefined {
  assertSafeDataPath(path);
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) {
      throw new Error(`Invalid session signing state file: ${path}`);
    }
    let state: unknown;
    try {
      state = JSON.parse(readFileSync(fd, "utf8"));
    } catch (error) {
      throw new Error(`Invalid session signing state in ${path}`, {
        cause: error,
      });
    }
    if (
      !state ||
      typeof state !== "object" ||
      Array.isArray(state) ||
      Object.keys(state).length !== 3 ||
      !("version" in state) ||
      state.version !== 1 ||
      !("secret" in state) ||
      typeof state.secret !== "string" ||
      !SECRET_PATTERN.test(state.secret) ||
      !("credentialFingerprint" in state) ||
      typeof state.credentialFingerprint !== "string" ||
      !SECRET_PATTERN.test(state.credentialFingerprint)
    ) {
      throw new Error(`Invalid session signing state in ${path}`);
    }
    fchmodSync(fd, 0o600);
    return state as SessionSecretState;
  } finally {
    closeSync(fd);
  }
}

function acquireSessionLock(path: string): () => void {
  const lockPath = `${path}.lock`;
  const deadline = performance.now() + LOCK_WAIT_MS;
  while (true) {
    assertSafeDataPath(path);
    try {
      const stat = lstatSync(lockPath);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Invalid session signing state lock: ${lockPath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      return lockSync(path, {
        realpath: false,
        retries: 0,
        // This critical section is synchronous and cannot heartbeat during a
        // stalled fsync. Never steal its lock based only on elapsed time.
        stale: Number.POSITIVE_INFINITY,
        update: 1_000,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
      if (performance.now() >= deadline) {
        throw new Error(
          `Session signing state is locked: ${lockPath}; if a startup was interrupted, remove this lock only after stopping all processes sharing this state`,
          { cause: error },
        );
      }
      Atomics.wait(lockWait, 0, 0, 25);
    }
  }
}

function writeSessionSecret(path: string, state: SessionSecretState): void {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.roamgate-session-${randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(
      temporaryPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(fd, `${JSON.stringify(state)}\n`);
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    assertSafeDataPath(path);
    renameSync(temporaryPath, path);
    // Flush the replacement directory entry as well as the file contents.
    // Windows does not support opening directories for fsync this way.
    if (process.platform !== "win32") {
      const directoryFd = openSync(
        directory,
        constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
      );
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporaryPath, { force: true });
  }
}

/** Persist independent signing material, rotating it when login credentials change. */
export function loadOrCreateSessionSecret(
  credentials: readonly string[],
  path = join(dataRoot(), "session-secret.json"),
): string {
  path = resolve(path);
  assertSafeDataPath(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const release = acquireSessionLock(path);
  try {
    chmodSync(`${path}.lock`, 0o700);
    const state = readSessionSecret(path);
    if (
      state &&
      timingSafeEqual(
        Buffer.from(state.credentialFingerprint, "hex"),
        Buffer.from(credentialFingerprint(state.secret, credentials), "hex"),
      )
    ) {
      return state.secret;
    }
    // Never derive a signing key from a password or token. Each rotation is
    // fresh, so changing credentials A -> B -> A cannot revive old cookies.
    const secret = randomBytes(32).toString("hex");
    writeSessionSecret(path, {
      version: 1,
      secret,
      credentialFingerprint: credentialFingerprint(secret, credentials),
    });
    return secret;
  } finally {
    release();
  }
}

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function dataRoot(
  homeDir = homedir(),
  platform: string = process.platform,
  appDataDir = process.env.APPDATA,
): string {
  return join(
    platform === "win32"
      ? (appDataDir ?? join(homeDir, "AppData", "Roaming"))
      : join(homeDir, ".config"),
    "roamgate",
  );
}

export function legacyDataRoot(
  homeDir = homedir(),
  platform: string = process.platform,
  appDataDir = process.env.APPDATA,
): string {
  return join(dirname(dataRoot(homeDir, platform, appDataDir)), "herdr-gui");
}

function statIfPresent(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// Check the configuration parent, product directory and file; never follow a
// legacy symlink, including dangling links. Explicit override paths do not migrate.
export function assertSafeDataPath(path: string): void {
  for (const entry of [dirname(dirname(path)), dirname(path), path]) {
    const stat = statIfPresent(entry);
    if (stat?.isSymbolicLink())
      throw new Error(`data path contains a symlink: ${entry}`);
    if (stat && (entry === path ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error(`data path has an unexpected file type: ${entry}`);
    }
  }
}

/**
 * Write a complete private file through a synced temporary file. Publishing
 * links it and keeps a concurrent winner; replacing renames over the target.
 */
function writeDataFile(
  path: string,
  contents: string | Buffer,
  mode: number,
  replace: boolean,
): void {
  assertSafeDataPath(path);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(directory, `.roamgate-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    writeFileSync(fd, contents);
    fchmodSync(fd, mode);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    assertSafeDataPath(path);
    if (replace) {
      renameSync(temporaryPath, path);
    } else {
      try {
        linkSync(temporaryPath, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        assertSafeDataPath(path);
      }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporaryPath, { force: true });
  }
  // Persist the new directory entry too. Windows cannot open directories, and
  // some filesystems reject directory fsync; the file itself is already synced.
  if (process.platform === "win32") return;
  try {
    const directoryFd = openSync(
      directory,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
    );
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } catch {
    // Best effort, as for the connection registry.
  }
}

/** Publish a complete private file without replacing a concurrent winner. */
export function publishDataFile(
  path: string,
  contents: string | Buffer,
  mode = 0o600,
): void {
  writeDataFile(path, contents, mode, false);
}

/** Atomically replace a private file, unlike publishDataFile which never overwrites. */
export function replaceDataFile(
  path: string,
  contents: string | Buffer,
  mode = 0o600,
): void {
  writeDataFile(path, contents, mode, true);
}

/** Copy only missing files. Originals and concurrent/new values always win. */
export function migrateDataFile(
  path: string,
  legacyPath: string,
  validate?: (contents: Buffer) => void,
): string {
  assertSafeDataPath(path);
  if (statIfPresent(path)) return path;
  assertSafeDataPath(legacyPath);
  if (!statIfPresent(legacyPath)) return path;
  const fd = openSync(
    legacyPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile())
      throw new Error(`legacy data is not a regular file: ${legacyPath}`);
    const contents = readFileSync(fd);
    validate?.(contents);
    publishDataFile(path, contents, stat.mode & 0o600);
  } finally {
    closeSync(fd);
  }
  return path;
}

export function defaultDataFile(
  name: "auth-token" | "settings.json" | "connections.json",
  homeDir = homedir(),
  platform: string = process.platform,
  appDataDir = process.env.APPDATA,
): string {
  // Settings and connections historically used ~/.config on Windows too.
  const legacyRoot =
    name === "auth-token"
      ? legacyDataRoot(homeDir, platform, appDataDir)
      : join(homeDir, ".config", "herdr-gui");
  const path = join(dataRoot(homeDir, platform, appDataDir), name);
  if (name === "connections.json") {
    const cleared = `${path}.legacy-cleared`;
    assertSafeDataPath(cleared);
    if (statIfPresent(cleared)) return path;
  }
  return migrateDataFile(
    path,
    join(legacyRoot, name),
    name === "settings.json"
      ? (contents) => {
          JSON.parse(contents.toString("utf8"));
        }
      : undefined,
  );
}

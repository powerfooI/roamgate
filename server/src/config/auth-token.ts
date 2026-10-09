import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  defaultDataFile,
  publishDataFile,
  assertSafeDataPath,
} from "./data-paths";
import { randomBytes } from "node:crypto";

const AUTH_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
export const MIN_PASSWORD_LENGTH = 15;
export const MAX_PASSWORD_LENGTH = 1024;

export function assertValidAuthPassword(password: string): void {
  const length = Array.from(password).length;
  if (length < MIN_PASSWORD_LENGTH || length > MAX_PASSWORD_LENGTH) {
    throw new Error(
      `Login password must contain at least ${MIN_PASSWORD_LENGTH} characters and at most ${MAX_PASSWORD_LENGTH} characters (--password or ROAMGATE_PASSWORD).`,
    );
  }
}

export function assertValidAuthPin(pin: string): void {
  if (!/^[0-9]{6,12}$/.test(pin)) {
    throw new Error("ROAMGATE_PIN must contain 6 to 12 ASCII digits.");
  }
}

export function defaultAuthTokenPath(
  homeDir = homedir(),
  platform = process.platform,
  appDataDir = process.env.APPDATA,
): string {
  return defaultDataFile("auth-token", homeDir, platform, appDataDir);
}

function readAuthToken(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error(
        `generated auth token path is not a regular file: ${path}`,
      );
    }
    const token = readFileSync(fd, "utf8").trim();
    if (!AUTH_TOKEN_PATTERN.test(token)) {
      throw new Error(
        `invalid generated auth token in ${path}; restore a valid token or replace it with a fresh 64-character lowercase hexadecimal secret`,
      );
    }
    fchmodSync(fd, 0o600);
    return token;
  } finally {
    closeSync(fd);
  }
}

export function loadOrCreateAuthToken(path = defaultAuthTokenPath()): string {
  assertSafeDataPath(path);
  try {
    return readAuthToken(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  publishDataFile(path, `${randomBytes(32).toString("hex")}\n`);
  return readAuthToken(path);
}

import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertValidAuthPassword,
  defaultAuthTokenPath,
  loadOrCreateAuthToken,
} from "./auth-token";

const tempDirs: string[] = [];

function tempHome(): string {
  const path = mkdtempSync(join(tmpdir(), "herdr-gui-auth-token-"));
  tempDirs.push(path);
  return path;
}

function tempAuthTokenPath(homeDir = tempHome()): string {
  return defaultAuthTokenPath(
    homeDir,
    process.platform,
    join(homeDir, "AppData", "Roaming"),
  );
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("generated authentication token", () => {
  test("requires 15 to 1024 Unicode characters for login secrets", () => {
    for (const password of [
      "",
      "a".repeat(14),
      "\u{1f600}".repeat(8),
      "a".repeat(1025),
      "\u{1f600}".repeat(1025),
    ]) {
      expect(() => assertValidAuthPassword(password)).toThrow(
        "at least 15 characters and at most 1024 characters",
      );
    }
    for (const password of [
      "a".repeat(15),
      "\u{1f600}".repeat(15),
      "a".repeat(1024),
      "\u{1f600}".repeat(1024),
    ]) {
      expect(() => assertValidAuthPassword(password)).not.toThrow();
    }
  });

  test("uses APPDATA for the Windows token", () => {
    const home = join("C:", "Users", "tester");
    const appData = join(home, "AppData", "Roaming");
    expect(defaultAuthTokenPath(home, "win32", appData)).toBe(
      join(appData, "roamgate", "auth-token"),
    );
  });

  test("creates a persistent random token with private permissions", () => {
    const path = tempAuthTokenPath();
    const first = loadOrCreateAuthToken(path);
    const second = loadOrCreateAuthToken(path);

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(readFileSync(path, "utf8")).toBe(`${first}\n`);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  test("repairs permissions on an existing valid token", () => {
    if (process.platform === "win32") return;
    const path = tempAuthTokenPath();
    const token = "a".repeat(64);
    loadOrCreateAuthToken(path);
    writeFileSync(path, `${token}\n`);
    chmodSync(path, 0o644);

    expect(loadOrCreateAuthToken(path)).toBe(token);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("rejects a malformed persisted token", () => {
    const path = tempAuthTokenPath();
    loadOrCreateAuthToken(path);
    writeFileSync(path, "not-a-token\n");

    expect(() => loadOrCreateAuthToken(path)).toThrow(
      "invalid generated auth token",
    );
  });

  test("does not follow a generated-token symlink", () => {
    const home = tempHome();
    const path = tempAuthTokenPath(home);
    const target = join(home, "shared-secret");
    loadOrCreateAuthToken(path);
    writeFileSync(target, `${"b".repeat(64)}\n`);
    rmSync(path);
    symlinkSync(target, path);

    expect(() => loadOrCreateAuthToken(path)).toThrow(
      "data path contains a symlink",
    );
  });
});

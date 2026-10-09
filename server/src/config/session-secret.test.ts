import { afterEach, describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dataRoot } from "./data-paths";
import { loadOrCreateSessionSecret } from "./session-secret";

const tempDirs: string[] = [];
const password = "correct horse battery staple";
const pin = "987654";

function tempHome(): string {
  const path = mkdtempSync(join(tmpdir(), "roamgate-session-secret-"));
  tempDirs.push(path);
  return path;
}

function sessionPath(home = tempHome()): string {
  return join(home, "data", "session-secret.json");
}

function storedState(path: string): {
  version: number;
  secret: string;
  credentialFingerprint: string;
} {
  return JSON.parse(readFileSync(path, "utf8"));
}

const childScript = `
  import { loadOrCreateSessionSecret } from ${JSON.stringify(join(import.meta.dir, "session-secret.ts"))};
  console.log(loadOrCreateSessionSecret(JSON.parse(process.argv[2]), process.argv[1]));
`;

async function concurrentSecrets(
  path: string,
  credentials: readonly string[],
): Promise<string[]> {
  const gate = join(tempHome(), "start");
  const script = `
    import { existsSync, writeFileSync } from "node:fs";
    import { loadOrCreateSessionSecret } from ${JSON.stringify(join(import.meta.dir, "session-secret.ts"))};
    writeFileSync(process.argv[3] + "." + process.argv[4], "ready");
    while (!existsSync(process.argv[3])) Bun.sleepSync(5);
    console.log(loadOrCreateSessionSecret(JSON.parse(process.argv[2]), process.argv[1]));
  `;
  const children = Array.from({ length: 8 }, (_, index) =>
    Bun.spawn(
      [
        process.execPath,
        "-e",
        script,
        path,
        JSON.stringify(credentials),
        gate,
        String(index),
      ],
      { stdout: "pipe", stderr: "pipe" },
    ),
  );
  try {
    const deadline = performance.now() + 5_000;
    while (!children.every((_, index) => existsSync(`${gate}.${index}`))) {
      if (performance.now() >= deadline) {
        throw new Error("Session secret subprocesses did not become ready");
      }
      await Bun.sleep(5);
    }
    writeFileSync(gate, "start");
    return await Promise.all(
      children.map(async (child) => {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(stderr).toBe("");
        expect(exitCode).toBe(0);
        const value = stdout.trim();
        expect(value).toMatch(/^[a-f0-9]{64}$/);
        return value;
      }),
    );
  } finally {
    for (const child of children) child.kill();
    await Promise.all(children.map((child) => child.exited));
  }
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("session signing secret", () => {
  test("persists private independent random signing material", () => {
    const path = sessionPath();
    const secret = loadOrCreateSessionSecret([password, pin], path);
    const state = storedState(path);

    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    expect(loadOrCreateSessionSecret([password, pin], path)).toBe(secret);
    expect(loadOrCreateSessionSecret([password, pin], sessionPath())).not.toBe(
      secret,
    );
    expect(secret).not.toBe(password);
    expect(secret).not.toBe(pin);
    expect(secret).not.toBe(
      createHash("sha256").update(password).digest("hex"),
    );
    expect(state).toEqual({
      version: 1,
      secret,
      credentialFingerprint: createHmac("sha256", Buffer.from(secret, "hex"))
        .update("roamgate:session-credentials:v1\0")
        .update(JSON.stringify([pin, password].sort()))
        .digest("hex"),
    });
    expect(readFileSync(path, "utf8")).not.toContain(password);
    expect(readdirSync(dirname(path))).toEqual(["session-secret.json"]);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    }
  });

  test("uses the default data root and survives a separate process restart", async () => {
    const home = tempHome();
    const appData = join(home, "AppData", "Roaming");
    const path = join(
      dataRoot(home, process.platform, appData),
      "session-secret.json",
    );
    const script = `
      import { loadOrCreateSessionSecret } from ${JSON.stringify(join(import.meta.dir, "session-secret.ts"))};
      console.log(loadOrCreateSessionSecret([${JSON.stringify(password)}]));
    `;
    const values: string[] = [];
    for (let index = 0; index < 2; index++) {
      const child = Bun.spawn([process.execPath, "-e", script], {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          APPDATA: appData,
          ROAMGATE_SETTINGS_PATH: undefined,
          HERDR_GUI_SETTINGS_PATH: undefined,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      values.push((await new Response(child.stdout).text()).trim());
      expect(await new Response(child.stderr).text()).toBe("");
      expect(await child.exited).toBe(0);
    }
    expect(values[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(values[1]).toBe(values[0]);
    expect(storedState(path).secret).toBe(values[0]);
  });

  test("isolates signing state by the effective settings path", () => {
    const home = tempHome();
    const appData = join(home, "AppData", "Roaming");
    const root = dataRoot(home, process.platform, appData);
    const settingsA = join(realpathSync(home), "a.json");
    const settingsB = join(realpathSync(home), "b.json");
    const load = (currentPath?: string, legacyPath?: string) => {
      const child = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `import { loadOrCreateSessionSecret } from ${JSON.stringify(join(import.meta.dir, "session-secret.ts"))}; console.log(loadOrCreateSessionSecret([${JSON.stringify(password)}]));`,
        ],
        {
          cwd: home,
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            APPDATA: appData,
            ROAMGATE_SETTINGS_PATH: currentPath,
            HERDR_GUI_SETTINGS_PATH: legacyPath,
          },
        },
      );
      expect(child.stderr.toString()).toBe("");
      expect(child.exitCode).toBe(0);
      return child.stdout.toString().trim();
    };
    const defaultSecret = load();
    const secretA = load("./a.json");
    const secretB = load(settingsB);
    expect(new Set([defaultSecret, secretA, secretB]).size).toBe(3);
    expect(load(settingsA, settingsB)).toBe(secretA);
    expect(load(undefined, settingsA)).toBe(secretA);
    expect(load(settingsB)).toBe(secretB);
    expect(load("", settingsA)).toBe(defaultSecret);
    expect(storedState(join(root, "session-secret.json")).secret).toBe(
      defaultSecret,
    );
    const hash = createHash("sha256").update(settingsA).digest("hex");
    expect(storedState(join(root, `session-secret-${hash}.json`)).secret).toBe(
      secretA,
    );
    expect(readdirSync(root)).toHaveLength(3);
    expect(existsSync(settingsA)).toBeFalse();
  });

  test("fingerprints the credential set without mutating the caller", () => {
    const path = sessionPath();
    const credentials = Object.freeze([password, pin]);
    const secret = loadOrCreateSessionSecret(credentials, path);
    expect(loadOrCreateSessionSecret([pin, password, pin], path)).toBe(secret);
    expect(credentials).toEqual([password, pin]);
  });

  test("rotates on changes, additions, removal and reversion without reviving old keys", () => {
    const path = sessionPath();
    const sets = [
      [password],
      [password, pin],
      [password, "1234"],
      [password],
      [password + " changed"],
      [password],
      [],
      [password],
    ];
    const secrets = sets.map((credentials) => {
      const secret = loadOrCreateSessionSecret(credentials, path);
      expect(loadOrCreateSessionSecret(credentials, path)).toBe(secret);
      expect(storedState(path).secret).toBe(secret);
      return secret;
    });
    expect(new Set(secrets).size).toBe(sets.length);
    expect(readdirSync(dirname(path))).toEqual(["session-secret.json"]);
  });

  test("does not confuse concatenated or escaped credentials", () => {
    const path = sessionPath();
    const sets = [["ab", "c"], ["a", "bc"], ["a\0b"], ["a", "b"], ["a ", "b"]];
    expect(
      new Set(sets.map((value) => loadOrCreateSessionSecret(value, path))).size,
    ).toBe(sets.length);
  });

  test("repairs permissions on existing state and preserves the signing key", () => {
    if (process.platform === "win32") return;
    const path = sessionPath();
    const secret = loadOrCreateSessionSecret([password], path);
    chmodSync(path, 0o644);
    expect(loadOrCreateSessionSecret([password], path)).toBe(secret);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    loadOrCreateSessionSecret([password, pin], path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("rejects malformed or unsupported state without replacing it", () => {
    const path = sessionPath();
    loadOrCreateSessionSecret([password], path);
    const state = storedState(path);
    const invalid = [
      "",
      "{broken",
      "null",
      "[]",
      JSON.stringify({ ...state, version: 2 }),
      JSON.stringify({ ...state, secret: password }),
      JSON.stringify({ ...state, secret: "a".repeat(63) }),
      JSON.stringify({ ...state, secret: "G".repeat(64) }),
      JSON.stringify({ ...state, credentialFingerprint: "not-a-fingerprint" }),
      JSON.stringify({ version: 1, secret: state.secret }),
      JSON.stringify({ ...state, unexpected: true }),
      " ".repeat(4097) + JSON.stringify(state),
    ];
    for (const contents of invalid) {
      writeFileSync(path, contents);
      expect(() => loadOrCreateSessionSecret([password], path)).toThrow(
        "Invalid session signing state",
      );
      expect(() => loadOrCreateSessionSecret(["changed"], path)).toThrow(
        "Invalid session signing state",
      );
      expect(readFileSync(path, "utf8")).toBe(contents);
      expect(readdirSync(dirname(path))).toEqual(["session-secret.json"]);
    }
  });

  test("fails closed on unreadable state", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const path = sessionPath();
    loadOrCreateSessionSecret([password], path);
    const contents = readFileSync(path, "utf8");
    chmodSync(path, 0);
    try {
      expect(() => loadOrCreateSessionSecret(["changed"], path)).toThrow();
    } finally {
      chmodSync(path, 0o600);
    }
    expect(readFileSync(path, "utf8")).toBe(contents);
  });

  test("rejects state-file symlinks, including dangling ones", () => {
    const home = tempHome();
    const path = sessionPath(home);
    loadOrCreateSessionSecret([password], path);
    const target = join(home, "target");
    const contents = readFileSync(path, "utf8");
    writeFileSync(target, contents);
    rmSync(path);
    symlinkSync(target, path);
    expect(() => loadOrCreateSessionSecret([password, pin], path)).toThrow(
      "symlink",
    );
    expect(readFileSync(target, "utf8")).toBe(contents);
    rmSync(target);
    expect(() => loadOrCreateSessionSecret([password], path)).toThrow(
      "symlink",
    );
    expect(existsSync(target)).toBeFalse();
  });

  test("rejects symlinked state directories and non-file state", () => {
    const home = tempHome();
    const target = join(home, "target");
    mkdirSync(target);
    const path = sessionPath(home);
    symlinkSync(target, dirname(path));
    expect(() => loadOrCreateSessionSecret([password], path)).toThrow(
      "symlink",
    );
    expect(readdirSync(target)).toEqual([]);
    rmSync(dirname(path));
    mkdirSync(path, { recursive: true });
    expect(() => loadOrCreateSessionSecret([password], path)).toThrow(
      "file type",
    );
  });

  test("rejects hard-linked signing state", () => {
    const home = tempHome();
    const path = sessionPath(home);
    loadOrCreateSessionSecret([password], path);
    const original = readFileSync(path, "utf8");
    linkSync(path, join(home, "hard-link"));
    expect(() => loadOrCreateSessionSecret([password, pin], path)).toThrow(
      "Invalid session signing state file",
    );
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("rejects symlinked or malformed locks", () => {
    const home = tempHome();
    const path = sessionPath(home);
    const original = loadOrCreateSessionSecret([password], path);
    const target = join(home, "target");
    mkdirSync(target);
    symlinkSync(target, `${path}.lock`);
    expect(() => loadOrCreateSessionSecret([password], path)).toThrow(
      "Invalid session signing state lock",
    );
    rmSync(`${path}.lock`);
    writeFileSync(`${path}.lock`, "not a directory");
    expect(() => loadOrCreateSessionSecret([password], path)).toThrow(
      "Invalid session signing state lock",
    );
    rmSync(`${path}.lock`);
    expect(loadOrCreateSessionSecret([password], path)).toBe(original);
  });

  test("times out safely instead of stealing even an old orphan lock", () => {
    const path = sessionPath();
    loadOrCreateSessionSecret([password], path);
    const original = readFileSync(path, "utf8");
    mkdirSync(`${path}.lock`);
    utimesSync(`${path}.lock`, new Date(0), new Date(0));
    const start = performance.now();
    expect(() => loadOrCreateSessionSecret([password, pin], path)).toThrow(
      "remove this lock only after stopping all processes sharing this state",
    );
    expect(performance.now() - start).toBeLessThan(8_000);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(existsSync(`${path}.lock`)).toBeTrue();
    rmSync(`${path}.lock`, { recursive: true });
    expect(loadOrCreateSessionSecret([password, pin], path)).not.toBe(
      JSON.parse(original).secret,
    );
  }, 10_000);

  test("concurrent first starts converge on one complete random secret", async () => {
    const path = sessionPath();
    const secrets = await concurrentSecrets(path, [password, pin]);
    expect(new Set(secrets).size).toBe(1);
    expect(storedState(path).secret).toBe(secrets[0]);
    expect(loadOrCreateSessionSecret([password, pin], path)).toBe(secrets[0]);
    expect(readdirSync(dirname(path))).toEqual(["session-secret.json"]);
  }, 15_000);

  test("concurrent rotations converge and do not revive a previous signing secret", async () => {
    const path = sessionPath();
    const original = loadOrCreateSessionSecret([password], path);
    const changed = await concurrentSecrets(path, [password, pin]);
    expect(new Set(changed).size).toBe(1);
    expect(changed[0]).not.toBe(original);
    const reverted = await concurrentSecrets(path, [password]);
    expect(new Set(reverted).size).toBe(1);
    expect(reverted[0]).not.toBe(original);
    expect(reverted[0]).not.toBe(changed[0]);
    expect(storedState(path).secret).toBe(reverted[0]);
    expect(readdirSync(dirname(path))).toEqual(["session-secret.json"]);
  }, 15_000);

  test("waits for a live subprocess lock holder before reading or rotating", async () => {
    const path = sessionPath();
    const original = loadOrCreateSessionSecret([password], path);
    const ready = join(tempHome(), "ready");
    const lockModule = import.meta.resolve("proper-lockfile");
    const script = `
      import { lockSync } from ${JSON.stringify(lockModule)};
      import { writeFileSync } from "node:fs";
      const release = lockSync(process.argv[1], {realpath: false, stale: Infinity, update: 1000});
      writeFileSync(process.argv[2], "ready");
      Bun.sleepSync(250);
      release();
    `;
    const holder = Bun.spawn([process.execPath, "-e", script, path, ready], {
      stdout: "ignore",
      stderr: "pipe",
    });
    try {
      const deadline = performance.now() + 5_000;
      while (!existsSync(ready)) {
        if (performance.now() >= deadline)
          throw new Error("Lock holder did not start");
        await Bun.sleep(5);
      }
      const child = Bun.spawn(
        [process.execPath, "-e", childScript, path, JSON.stringify([password])],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect((await new Response(child.stdout).text()).trim()).toBe(original);
      expect(await new Response(child.stderr).text()).toBe("");
      expect(await child.exited).toBe(0);
      expect(await new Response(holder.stderr).text()).toBe("");
      expect(await holder.exited).toBe(0);
      expect(existsSync(`${path}.lock`)).toBeFalse();
    } finally {
      holder.kill();
      await holder.exited;
    }
  }, 10_000);
});

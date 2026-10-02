import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  dataRoot,
  defaultDataFile,
  legacyDataRoot,
  migrateDataFile,
  publishDataFile,
} from "./data-paths";
import { defaultAuthTokenPath, loadOrCreateAuthToken } from "./auth-token";

const roots: string[] = [];
function home() {
  const root = mkdtempSync(join(tmpdir(), "roamgate-data-"));
  roots.push(root);
  return root;
}
function write(path: string, value: string, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, value, { mode });
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("fresh Unix and Windows data roots respect APPDATA", () => {
  const root = home();
  expect(dataRoot(root, "linux")).toBe(join(root, ".config", "roamgate"));
  expect(dataRoot(root, "win32", join(root, "custom"))).toBe(
    join(root, "custom", "roamgate"),
  );
  expect(dataRoot(root, "win32", undefined)).toBe(
    join(root, "AppData", "Roaming", "roamgate"),
  );
  expect(
    existsSync(defaultDataFile("settings.json", root, "linux")),
  ).toBeFalse();
});

for (const platform of ["linux", "win32"]) {
  test(`copies all legacy data without resetting credentials (${platform})`, () => {
    const root = home();
    const appData = join(root, "AppData", "Roaming");
    const token = "c".repeat(64);
    const legacyToken = join(
      legacyDataRoot(root, platform, appData),
      "auth-token",
    );
    write(legacyToken, `${token}\n`, 0o400);
    for (const name of ["settings.json", "connections.json"] as const) {
      const legacy = join(root, ".config", "herdr-gui", name);
      write(legacy, '{"version":1}\n');
      const target = defaultDataFile(name, root, platform, appData);
      expect(target).toBe(join(dataRoot(root, platform, appData), name));
      expect(readFileSync(target, "utf8")).toBe(readFileSync(legacy, "utf8"));
      expect(defaultDataFile(name, root, platform, appData)).toBe(target);
    }
    const target = defaultAuthTokenPath(
      root,
      platform as NodeJS.Platform,
      appData,
    );
    expect(readFileSync(target, "utf8")).toBe(`${token}\n`);
    if (process.platform !== "win32")
      expect(statSync(target).mode & 0o777).toBe(0o400);
    expect(loadOrCreateAuthToken(target)).toBe(token);
    expect(readFileSync(legacyToken, "utf8")).toBe(`${token}\n`);
    if (process.platform !== "win32")
      expect(statSync(legacyToken).mode & 0o777).toBe(0o400);
  });
}

test("new values win, including empty files and malformed data", () => {
  const root = home();
  const legacy = join(root, ".config", "herdr-gui", "settings.json");
  const target = join(dataRoot(root), "settings.json");
  write(legacy, "old");
  write(target, "");
  migrateDataFile(target, legacy);
  expect(readFileSync(target, "utf8")).toBe("");
  write(target, "new");
  migrateDataFile(target, legacy);
  expect(readFileSync(target, "utf8")).toBe("new");
  expect(readFileSync(legacy, "utf8")).toBe("old");
});

test("refuses legacy file/directory symlinks and permits a safe retry", () => {
  const root = home();
  const legacy = join(root, ".config", "herdr-gui", "auth-token");
  const target = join(dataRoot(root), "auth-token");
  const secret = join(root, "secret");
  write(secret, "d".repeat(64));
  mkdirSync(dirname(legacy), { recursive: true });
  symlinkSync(secret, legacy);
  expect(() => migrateDataFile(target, legacy)).toThrow("symlink");
  expect(existsSync(target)).toBeFalse();
  rmSync(legacy);
  write(legacy, "e".repeat(64));
  migrateDataFile(target, legacy);
  expect(readFileSync(target, "utf8")).toBe("e".repeat(64));
  expect(readFileSync(secret, "utf8")).toBe("d".repeat(64));
  const other = join(root, "other", "settings.json");
  symlinkSync(dirname(legacy), dirname(other));
  expect(() =>
    migrateDataFile(join(dataRoot(root), "settings.json"), other),
  ).toThrow("symlink");
});

test("failed publication leaves no partial target and retries without overwriting", () => {
  const root = home();
  const target = join(root, "roamgate", "settings.json");
  write(dirname(target), "not a directory");
  expect(() => publishDataFile(target, "first")).toThrow();
  rmSync(dirname(target));
  publishDataFile(target, "first");
  publishDataFile(target, "second");
  expect(readFileSync(target, "utf8")).toBe("first");
  expect(readdirSync(dirname(target))).toEqual(["settings.json"]);
});

test("concurrent first use publishes one complete legacy token", async () => {
  const root = home();
  const legacy = join(root, ".config", "herdr-gui", "auth-token");
  write(legacy, `${"f".repeat(64)}\n`);
  const script = `import {defaultDataFile} from ${JSON.stringify(join(import.meta.dir, "data-paths.ts"))}; defaultDataFile("auth-token", process.argv[1], "linux");`;
  const children = Array.from({ length: 6 }, () =>
    Bun.spawn([process.execPath, "-e", script, root], {
      stdout: "ignore",
      stderr: "pipe",
    }),
  );
  for (const child of children) expect(await child.exited).toBe(0);
  expect(readFileSync(join(dataRoot(root), "auth-token"), "utf8")).toBe(
    `${"f".repeat(64)}\n`,
  );
  expect(readdirSync(dataRoot(root))).toEqual(["auth-token"]);
});

test("unreadable legacy credentials fail rather than generate a new token", () => {
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  const root = home();
  const legacy = join(legacyDataRoot(root), "auth-token");
  write(legacy, "a".repeat(64));
  chmodSync(legacy, 0);
  try {
    expect(() => defaultDataFile("auth-token", root)).toThrow();
  } finally {
    chmodSync(legacy, 0o600);
  }
  expect(existsSync(join(dataRoot(root), "auth-token"))).toBeFalse();
});

test("invalid legacy settings stop migration without publishing a reset", () => {
  const root = home();
  const legacy = join(root, ".config", "herdr-gui", "settings.json");
  write(legacy, "{broken");
  for (let retry = 0; retry < 2; retry++) {
    expect(() => defaultDataFile("settings.json", root)).toThrow();
    expect(existsSync(join(dataRoot(root), "settings.json"))).toBeFalse();
  }
  expect(readFileSync(legacy, "utf8")).toBe("{broken");
});

test("settings caller migrates and saves privately; clearing profiles stays cleared on next launch", async () => {
  const root = home();
  write(
    join(root, ".config", "herdr-gui", "settings.json"),
    JSON.stringify({ version: 1, custom: { saved: "kept" } }),
  );
  const registry = JSON.stringify({
    version: 1,
    default_connection_id: "one",
    profiles: [
      {
        id: "one",
        label: "Local",
        type: "local",
        control_socket_path: "/tmp/control.sock",
        client_socket_path: "/tmp/client.sock",
        auto_connect: false,
      },
    ],
  });
  write(join(root, ".config", "herdr-gui", "connections.json"), registry);
  const script = `
    import { readGuiSettings, updateGuiSettings, guiSettingsPath } from ${JSON.stringify(join(import.meta.dir, "gui-settings.ts"))};
    import { ConnectionProfileStore } from ${JSON.stringify(join(import.meta.dir, "../connections/profiles.ts"))};
    import { statSync } from "node:fs";
    const settings = await readGuiSettings();
    if (settings.custom.saved !== "kept") throw new Error("lost settings");
    await updateGuiSettings(current => ({...current, custom: {...current.custom, changed: true}}));
    if (process.platform !== "win32" && (statSync(guiSettingsPath()).mode & 0o777) !== 0o600) throw new Error("settings permissions");
    const store = new ConnectionProfileStore();
    if (!store.load()) throw new Error("lost profiles");
    await store.clear();
    if (new ConnectionProfileStore().load() !== null) throw new Error("legacy profiles resurrected");
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      APPDATA: join(root, "AppData", "Roaming"),
      ROAMGATE_CONNECTIONS_PATH: undefined,
      HERDR_GUI_CONNECTIONS_PATH: undefined,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(child.stderr).text();
  expect(stderr).toBe("");
  expect(await child.exited).toBe(0);
  expect(
    readFileSync(
      join(root, ".config", "herdr-gui", "connections.json"),
      "utf8",
    ),
  ).toBe(registry);
});

test("concurrent fresh authentication returns the same complete token", async () => {
  const root = home();
  const target = join(dataRoot(root), "auth-token");
  const script = `import { loadOrCreateAuthToken } from ${JSON.stringify(join(import.meta.dir, "auth-token.ts"))}; console.log(loadOrCreateAuthToken(process.argv[1]));`;
  const children = Array.from({ length: 6 }, () =>
    Bun.spawn([process.execPath, "-e", script, target], {
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const tokens = await Promise.all(
    children.map(async (child) => {
      const value = (await new Response(child.stdout).text()).trim();
      expect(await child.exited).toBe(0);
      expect(value).toMatch(/^[a-f0-9]{64}$/);
      return value;
    }),
  );
  expect(new Set(tokens).size).toBe(1);
  expect(readFileSync(target, "utf8").trim()).toBe(tokens[0]);
  expect(readdirSync(dirname(target))).toEqual(["auth-token"]);
});

test("plugin URL reads legacy files without migrating and prefers new paths", async () => {
  const root = home();
  const appData = join(root, "AppData", "Roaming");
  const legacy = legacyDataRoot(root, process.platform, appData);
  const current = dataRoot(root, process.platform, appData);
  write(join(legacy, "herdr-gui.env"), "HOST=0.0.0.0\nPORT=8890\n");
  write(join(legacy, "auth-token"), `${"c".repeat(64)}\n`);
  const script = `import { computeUrl } from ${JSON.stringify(join(import.meta.dir, "../../..", "scripts/studio-plugin.ts"))}; console.log(computeUrl());`;
  const invoke = async () => {
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, HOME: root, USERPROFILE: root, APPDATA: appData },
      stdout: "pipe",
      stderr: "pipe",
    });
    const value = (await new Response(child.stdout).text()).trim();
    expect(await new Response(child.stderr).text()).toBe("");
    expect(await child.exited).toBe(0);
    return value;
  };
  expect(await invoke()).toBe(`http://localhost:8890/?token=${"c".repeat(64)}`);
  expect(existsSync(current)).toBeFalse();
  write(join(current, "roamgate.env"), "HOST=127.0.0.1\nPORT=8891\n");
  expect(await invoke()).toBe(`http://127.0.0.1:8891/?token=${"c".repeat(64)}`);
  expect(readFileSync(join(legacy, "herdr-gui.env"), "utf8")).toBe(
    "HOST=0.0.0.0\nPORT=8890\n",
  );
});

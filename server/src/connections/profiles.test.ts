import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConnectionProfileStore,
  connectionRecoveryFingerprint,
  type PersistedConnectionRegistry,
  publicConnectionProfile,
  validateConnectionRegistry,
  validateLocalConnectionProfile,
  validateSshConnectionProfile,
} from "./profiles";

const roots: string[] = [];
function tempRoot() {
  const root = join(tmpdir(), `herdr-gui-profiles-${crypto.randomUUID()}`);
  roots.push(root);
  mkdirSync(root, { recursive: true });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function localSocketPath(id: string, client = false): string {
  const name = `${id}${client ? "-client" : ""}.sock`;
  return process.platform === "win32"
    ? `\\\\.\\pipe\\herdr-gui-test-${name}`
    : `/tmp/${name}`;
}

function local(id = "alpha") {
  return {
    id,
    label: id === "alpha" ? "Alpha" : "Beta",
    type: "local" as const,
    control_socket_path: localSocketPath(id),
    client_socket_path: localSocketPath(id, true),
    auto_connect: true,
  };
}

function ssh(id = "remote") {
  return {
    id,
    label: "Remote",
    type: "ssh" as const,
    ssh_destination: "operator@dev-box",
    remote_control_socket_path: "/remote/herdr.sock",
    remote_client_socket_path: "/remote/herdr-client.sock",
    auto_connect: false,
  };
}

function registry(): PersistedConnectionRegistry {
  return {
    version: 1,
    default_connection_id: "alpha",
    profiles: [local("alpha")],
  };
}

describe("connection recovery fingerprints", () => {
  test("preserves persisted local and Unix SSH fingerprints", () => {
    expect(
      connectionRecoveryFingerprint({
        ...local(),
        control_socket_path: "/tmp/alpha.sock",
        client_socket_path: "/tmp/alpha-client.sock",
      }),
    ).toBe("1a7c9e2537a3a96fd4a80d280dc566f68b8c92e3a0dc8508dee2146f86b1551b");
    expect(connectionRecoveryFingerprint(ssh())).toBe(
      "f332d70be95c37f234e1fa0d8876a1be4128960d06e7a83660532da13acd691c",
    );
  });

  test("invalidates Windows recovery when its endpoint changes", () => {
    const profile = {
      ...ssh(),
      remote_control_socket_path: "",
      remote_client_socket_path: "",
      remote_platform: "windows" as const,
      remote_herdr_path: String.raw`C:\Herdr\herdr.exe`,
      remote_session: "default",
    };
    const fingerprint = connectionRecoveryFingerprint(profile);
    for (const changed of [
      { ssh_destination: "other-host" },
      { remote_platform: undefined },
      { remote_herdr_path: String.raw`C:\Other\herdr.exe` },
      { remote_session: "other-session" },
    ]) {
      expect(
        connectionRecoveryFingerprint({ ...profile, ...changed }),
      ).not.toBe(fingerprint);
    }
  });
});

describe("connection profile validation", () => {
  test("accepts the bounded versioned local schema", () => {
    expect(validateConnectionRegistry(registry())).toEqual(registry());
  });

  test("normalizes Windows local profiles to native named pipes", () => {
    const windowsProfile = {
      ...local(),
      control_socket_path: String.raw`C:\Users\tester\AppData\Roaming\herdr\herdr.sock`,
      client_socket_path: String.raw`C:\Users\tester\AppData\Roaming\herdr\herdr-client.sock`,
    };

    expect(validateLocalConnectionProfile(windowsProfile, "win32")).toEqual({
      ...windowsProfile,
      control_socket_path: String.raw`\\.\pipe\C:\Users\tester\AppData\Roaming\herdr\herdr.sock`,
      client_socket_path: String.raw`\\.\pipe\C:\Users\tester\AppData\Roaming\herdr\herdr-client.sock`,
    });
  });

  test("rejects unsupported versions, duplicates, and missing defaults", () => {
    expect(() =>
      validateConnectionRegistry({ ...registry(), version: 3 }),
    ).toThrow("unsupported connection registry version");
    expect(() =>
      validateConnectionRegistry({
        ...registry(),
        profiles: [local("alpha"), local("alpha")],
      }),
    ).toThrow("duplicate connection profile");
    expect(() =>
      validateConnectionRegistry({
        ...registry(),
        default_connection_id: "missing",
      }),
    ).toThrow("default connection profile does not exist");
  });

  test("accepts mixed version-2 profiles and keeps version 1 local-only", () => {
    const mixed: PersistedConnectionRegistry = {
      version: 2,
      default_connection_id: "remote",
      profiles: [local("alpha"), ssh()],
    };
    expect(validateConnectionRegistry(mixed)).toEqual(mixed);
    expect(() =>
      validateConnectionRegistry({
        ...mixed,
        version: 1,
      }),
    ).toThrow();
    expect(publicConnectionProfile(ssh(), false)).toEqual({
      ...ssh(),
      read_only: false,
    });
  });

  test("validates strict SSH destinations, paths, and exact fields", () => {
    expect(validateSshConnectionProfile(ssh())).toEqual(ssh());
    for (const ssh_destination of [
      "-oProxyCommand=touch",
      "host name",
      "ssh://host",
      "host:2222",
      "user@@host",
      "user@host/path",
      "user@host=bad",
      "user@host,bad",
      "",
      "a".repeat(321),
    ]) {
      expect(() =>
        validateSshConnectionProfile({ ...ssh(), ssh_destination }),
      ).toThrow("OpenSSH alias");
    }
    for (const remote_control_socket_path of [
      "relative.sock",
      "/tmp/../secret.sock",
      "/tmp/socket:bad",
      "/tmp/socket path",
      `/tmp/${"x".repeat(100)}`,
    ]) {
      expect(() =>
        validateSshConnectionProfile({
          ...ssh(),
          remote_control_socket_path,
        }),
      ).toThrow("short absolute POSIX socket path");
    }
    expect(() =>
      validateSshConnectionProfile({
        ...ssh(),
        remote_client_socket_path: ssh().remote_control_socket_path,
      }),
    ).toThrow("must differ");
    for (const forbidden of [
      "password",
      "passphrase",
      "private_key",
      "identity_file",
      "command",
      "options",
      "port",
      "control_socket_path",
    ]) {
      expect(() =>
        validateSshConnectionProfile({ ...ssh(), [forbidden]: "secret" }),
      ).toThrow(`unknown field: ${forbidden}`);
    }
  });

  test("accepts empty SSH socket paths for remote home inference", () => {
    const inferred = {
      ...ssh(),
      remote_control_socket_path: "",
      remote_client_socket_path: "",
    };
    expect(validateSshConnectionProfile(inferred)).toEqual(inferred);
    const mixed = { ...ssh(), remote_client_socket_path: "" };
    expect(validateSshConnectionProfile(mixed)).toEqual(mixed);
  });

  test("persists Windows bridge options and rejects ambiguous or unsafe targets", () => {
    const windows = {
      ...ssh(),
      remote_control_socket_path: "",
      remote_client_socket_path: "",
      remote_platform: "windows" as const,
      remote_herdr_path: String.raw`C:\Herdr O'Brien\herdr.exe`,
      remote_session: "isolated-session",
    };
    expect(validateSshConnectionProfile(windows)).toEqual(windows);
    expect(
      publicConnectionProfile(validateSshConnectionProfile(windows)),
    ).toEqual({ ...windows, read_only: false });
    for (const patch of [
      { remote_platform: "linux" },
      { remote_platform: undefined },
      { remote_control_socket_path: "/tmp/herdr.sock" },
      { remote_herdr_path: "herdr.exe --update" },
      { remote_herdr_path: String.raw`\\server\share\herdr.exe` },
      { remote_herdr_path: String.raw`C:\..\herdr.exe` },
      { remote_herdr_path: "C:\\herdr\n.exe" },
      { remote_herdr_path: "C:\\herdr\u0085.exe" },
      { remote_herdr_path: `C:\\${"a".repeat(1024)}.exe` },
      { remote_session: "default --update" },
      { remote_session: "../default" },
    ])
      expect(() =>
        validateSshConnectionProfile({ ...windows, ...patch }),
      ).toThrow();
  });

  test("rejects reserved IDs, control characters, relative/traversal paths, and unknown fields", () => {
    expect(() =>
      validateLocalConnectionProfile({
        ...local("alpha"),
        id: "legacy-default",
      }),
    ).toThrow("reserved");
    expect(() =>
      validateLocalConnectionProfile({ ...local(), label: "bad\nlabel" }),
    ).toThrow("label is invalid");
    expect(() =>
      validateLocalConnectionProfile({
        ...local(),
        control_socket_path: "relative.sock",
      }),
    ).toThrow("absolute socket path");
    expect(() =>
      validateLocalConnectionProfile({
        ...local(),
        control_socket_path:
          process.platform === "win32"
            ? "C:\\tmp\\..\\secret.sock"
            : "/tmp/../secret.sock",
      }),
    ).toThrow("parent traversal");
    expect(() =>
      validateLocalConnectionProfile({ ...local(), command: "ssh evil" }),
    ).toThrow("unknown field");
  });
});

describe("connection profile persistence", () => {
  test("atomically writes mode 0600 under a mode 0700 directory", async () => {
    const path = join(tempRoot(), "private", "connections.json");
    const store = new ConnectionProfileStore({ path });
    await store.save(registry());
    expect(store.load()).toEqual(registry());
    if (process.platform !== "win32") {
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(path, "..")).mode & 0o777).toBe(0o700);
    }
  });

  test("failed replacement preserves the previous complete file", async () => {
    const path = join(tempRoot(), "private", "connections.json");
    const initial = new ConnectionProfileStore({ path });
    await initial.save(registry());
    const before = readFileSync(path, "utf8");
    const failing = new ConnectionProfileStore({
      path,
      beforeRename() {
        throw new Error("simulated persistence failure");
      },
    });
    await expect(
      failing.save({
        version: 1,
        default_connection_id: "beta",
        profiles: [local("beta")],
      }),
    ).rejects.toThrow("simulated persistence failure");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(initial.load()).toEqual(registry());
  });

  test("rejects oversized registries before parsing", () => {
    const parent = join(tempRoot(), "private");
    mkdirSync(parent, { mode: 0o700 });
    const path = join(parent, "connections.json");
    writeFileSync(path, "x".repeat(1024 * 1024 + 1), { mode: 0o600 });
    expect(() => new ConnectionProfileStore({ path }).load()).toThrow(
      "too large",
    );
  });

  test("rejects insecure override permissions without changing them", async () => {
    if (process.platform === "win32") return;
    const root = tempRoot();
    const path = join(root, "connections.json");
    writeFileSync(path, JSON.stringify(registry()), { mode: 0o644 });
    expect(() => new ConnectionProfileStore({ path }).load()).toThrow(
      "permissions must be 0700/0600",
    );
    expect(lstatSync(path).mode & 0o777).toBe(0o644);

    await expect(
      new ConnectionProfileStore({ path }).save(registry()),
    ).rejects.toThrow("parent permissions must be 0700");
  });

  test("does not chmod or write through an existing shared parent", async () => {
    if (process.platform === "win32") return;
    const root = tempRoot();
    expect(lstatSync(root).mode & 0o077).not.toBe(0);
    await expect(
      new ConnectionProfileStore({
        path: join(root, "connections.json"),
      }).save(registry()),
    ).rejects.toThrow("parent permissions must be 0700");
    expect(lstatSync(root).mode & 0o077).not.toBe(0);
  });

  test("never follows a symlink at the registry or parent", async () => {
    const root = tempRoot();
    const real = join(root, "real.json");
    writeFileSync(real, JSON.stringify(registry()));
    const linkedFile = join(root, "linked.json");
    symlinkSync(real, linkedFile);
    expect(() =>
      new ConnectionProfileStore({ path: linkedFile }).load(),
    ).toThrow("symlink");

    const realDir = join(root, "real-dir");
    mkdirSync(realDir);
    const linkedDir = join(root, "linked-dir");
    symlinkSync(realDir, linkedDir);
    await expect(
      new ConnectionProfileStore({
        path: join(linkedDir, "connections.json"),
      }).save(registry()),
    ).rejects.toThrow("symlink");

    const clearTarget = join(realDir, "connections.json");
    writeFileSync(clearTarget, JSON.stringify(registry()), { mode: 0o600 });
    await expect(
      new ConnectionProfileStore({
        path: join(linkedDir, "connections.json"),
      }).clear(),
    ).rejects.toThrow("symlink");
    expect(existsSync(clearTarget)).toBeTrue();
  });
});

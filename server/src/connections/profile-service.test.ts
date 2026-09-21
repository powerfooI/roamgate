import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BinReader, BinWriter, encodeFrame } from "../bridge/bincode";
import { SshTunnelError } from "../bridge/ssh-tunnel";
import {
  ConnectionManager,
  type ConnectionRuntime,
  type ConnectionRuntimeContext,
} from "./manager";
import {
  ConnectionProbeError,
  ConnectionProfileService,
  connectionIdentityForProfile,
  loadConnectionProfileBootstrap,
  type ManagedConnectionProfile,
  type SyntheticLocalProfile,
  testLocalConnectionProfile,
} from "./profile-service";
import {
  ConnectionProfileStore,
  type LocalConnectionProfile,
  type PersistedConnectionRegistry,
  type SshConnectionProfile,
} from "./profiles";

const roots: string[] = [];
const servers: net.Server[] = [];
async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition not reached");
    await Bun.sleep(1);
  }
}

function tempPath() {
  const root = join(
    tmpdir(),
    `herdr-gui-profile-service-${crypto.randomUUID()}`,
  );
  roots.push(root);
  mkdirSync(root, { recursive: true });
  return join(root, "private", "connections.json");
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function localSocketPath(id: string, client = false): string {
  const name = `${id}${client ? "-client" : ""}.sock`;
  return process.platform === "win32"
    ? `\\\\.\\pipe\\herdr-gui-test-${name}`
    : `/tmp/${name}`;
}

function local(id: string, autoConnect = true): LocalConnectionProfile {
  return {
    id,
    label: id.toUpperCase(),
    type: "local",
    control_socket_path: localSocketPath(id),
    client_socket_path: localSocketPath(id, true),
    auto_connect: autoConnect,
  };
}

function ssh(id: string, autoConnect = false): SshConnectionProfile {
  return {
    id,
    label: id.toUpperCase(),
    type: "ssh",
    ssh_destination: `operator@${id}`,
    remote_control_socket_path: `/remote/${id}.sock`,
    remote_client_socket_path: `/remote/${id}-client.sock`,
    auto_connect: autoConnect,
  };
}

const legacy: SyntheticLocalProfile = {
  ...local("ignored"),
  id: "legacy-default",
  label: "Default",
};

type FakeRuntime = ConnectionRuntime & {
  context: ConnectionRuntimeContext;
  stops: number;
};

function runtimeFactory(created: Map<string, FakeRuntime[]>) {
  return (profile: ManagedConnectionProfile) =>
    (context: ConnectionRuntimeContext): FakeRuntime => {
      const runtime: FakeRuntime = {
        identity: {
          id: profile.id,
          label: profile.label,
          source:
            profile.id === "legacy-default"
              ? "legacy-config"
              : profile.type === "ssh"
                ? "ssh-profile"
                : "local-profile",
        },
        context,
        stops: 0,
        async startTransport() {
          if (
            profile.type === "local" &&
            profile.control_socket_path.includes("bad-start")
          ) {
            throw new Error("transport unavailable");
          }
        },
        startBackground() {},
        async stop() {
          runtime.stops += 1;
        },
      };
      const list = created.get(profile.id) ?? [];
      list.push(runtime);
      created.set(profile.id, list);
      return runtime;
    };
}

async function startProbeServers(
  id: string,
  renderMode: "valid" | "malformed" = "valid",
  pingProtocol: unknown = 14,
  welcomeProtocol?: number,
) {
  const key = crypto.randomUUID();
  const root = join(tmpdir(), `herdr-gui-profile-probe-${key}`);
  roots.push(root);
  mkdirSync(root, { recursive: true });
  const controlPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\herdr-gui-profile-probe-${key}-control`
      : join(root, "control.sock");
  const renderPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\herdr-gui-profile-probe-${key}-render`
      : join(root, "render.sock");
  let controlConnections = 0;
  let renderConnections = 0;
  const control = net.createServer((socket) => {
    controlConnections += 1;
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(input.slice(0, newline));
      socket.end(
        `${JSON.stringify({
          id: request.id,
          result: {
            version: `fake-${id}`,
            protocol: pingProtocol,
            workspace_id: "shared-workspace",
            pane_id: "shared-pane",
            terminal_id: "shared-terminal",
          },
        })}\n`,
      );
    });
  });
  const render = net.createServer((socket) => {
    renderConnections += 1;
    let input = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      input = Buffer.concat([input, Buffer.from(chunk)]);
      if (input.length < 4) return;
      const length = input.readUInt32LE(0);
      if (input.length < length + 4) return;
      if (renderMode === "malformed") {
        socket.end(encodeFrame(Buffer.alloc(0)));
        return;
      }
      const reader = new BinReader(input.subarray(4, 4 + length));
      expect(reader.variant()).toBe(0);
      const protocol = reader.varint();
      expect(pingProtocol).toBe(protocol);
      expect(reader.varint()).toBe(80);
      expect(reader.varint()).toBe(24);
      expect(reader.varint()).toBe(0);
      expect(reader.varint()).toBe(0);
      if (protocol === 22) {
        expect(reader.bool()).toBe(false);
      } else {
        reader.varint(); // encoding
        expect(reader.varint()).toBe(0); // keybindings
        expect(reader.varint()).toBe(0); // app
      }
      expect(reader.remaining).toBe(0);
      const writer = new BinWriter();
      writer.variant(0);
      writer.varint(welcomeProtocol ?? protocol);
      writer.varint(1);
      writer.option<string>(undefined, (value) => writer.string(value));
      socket.write(encodeFrame(writer.toBuffer()));
    });
  });
  servers.push(control, render);
  await Promise.all(
    [
      [control, controlPath],
      [render, renderPath],
    ].map(
      ([server, path]) =>
        new Promise<void>((resolve, reject) => {
          (server as net.Server).once("error", reject);
          (server as net.Server).listen(path as string, resolve);
        }),
    ),
  );
  return {
    profile: {
      ...local(id),
      control_socket_path: controlPath,
      client_socket_path: renderPath,
    },
    counts: () => ({ controlConnections, renderConnections }),
  };
}

async function persistedStore(
  registry: PersistedConnectionRegistry,
): Promise<ConnectionProfileStore> {
  const store = new ConnectionProfileStore({ path: tempPath() });
  await store.save(registry);
  return store;
}

describe("connection profile bootstrap", () => {
  test("uses persisted default and profiles when no legacy override exists", async () => {
    const store = await persistedStore({
      version: 1,
      default_connection_id: "beta",
      profiles: [local("alpha", false), local("beta")],
    });
    const bootstrap = loadConnectionProfileBootstrap({
      store,
      legacyProfile: legacy,
      explicitLegacyOverride: false,
    });
    expect(bootstrap.defaultConnectionId).toBe("beta");
    expect(bootstrap.registrations.map(({ profile }) => profile.id)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  test("explicit legacy config remains process default without overwriting persisted registry", async () => {
    const store = await persistedStore({
      version: 1,
      default_connection_id: "alpha",
      profiles: [local("alpha")],
    });
    const before = readFileSync(store.path, "utf8");
    const bootstrap = loadConnectionProfileBootstrap({
      store,
      legacyProfile: legacy,
      explicitLegacyOverride: true,
    });
    expect(bootstrap.defaultConnectionId).toBe("legacy-default");
    expect(bootstrap.registrations.map(({ profile }) => profile.id)).toEqual([
      "legacy-default",
      "alpha",
    ]);
    expect(readFileSync(store.path, "utf8")).toBe(before);
  });

  test("preserves an invalid registry and blocks mutations in degraded fallback", async () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, "{not-json", { mode: 0o600 });
    const store = new ConnectionProfileStore({ path });
    expect(() =>
      loadConnectionProfileBootstrap({
        store,
        legacyProfile: legacy,
        explicitLegacyOverride: false,
      }),
    ).toThrow("not valid JSON");
    const bootstrap = {
      defaultConnectionId: "legacy-default",
      explicitLegacyOverride: false,
      persistedRegistry: null,
      registryLoadError: "connection registry is not valid JSON",
      registrations: [{ profile: legacy, readOnly: true }],
    };
    const manager = new ConnectionManager<FakeRuntime>("legacy-default");
    const service = new ConnectionProfileService({
      manager,
      store,
      bootstrap,
      createRuntime: runtimeFactory(new Map()),
      testProfile: async () => ({ ok: true, version: "test", protocol: 14 }),
    });

    await expect(service.create(local("alpha"))).rejects.toThrow(
      "registry is invalid",
    );
    await expect(service.test({ id: "legacy-default" })).resolves.toMatchObject(
      {
        ok: true,
      },
    );
    expect(readFileSync(path, "utf8")).toBe("{not-json");
  });

  test("synthesizes the local legacy profile when no registry exists", () => {
    const store = new ConnectionProfileStore({ path: tempPath() });
    const bootstrap = loadConnectionProfileBootstrap({
      store,
      legacyProfile: legacy,
      explicitLegacyOverride: false,
    });
    expect(bootstrap.defaultConnectionId).toBe("legacy-default");
    expect(bootstrap.registrations).toEqual([
      { profile: legacy, readOnly: true },
    ]);
  });
});

describe("connection profile service", () => {
  for (const protocol of [20, 22]) {
    test(`probes protocol ${protocol} with a complete Hello/Welcome`, async () => {
      const server = await startProbeServers("tagged", "valid", protocol);
      expect(await testLocalConnectionProfile(server.profile)).toMatchObject({
        ok: true,
        protocol,
      });
      expect(server.counts()).toEqual({
        controlConnections: 1,
        renderConnections: 1,
      });
    });
  }

  for (const protocol of [13, 21, 23, 999, "22", null]) {
    test(`rejects unsupported control probe ${JSON.stringify(protocol)} without opening render socket`, async () => {
      const server = await startProbeServers("unsupported", "valid", protocol);
      await expect(
        testLocalConnectionProfile(server.profile),
      ).rejects.toMatchObject({
        retryable: false,
        message: expect.stringContaining("supports protocols 14-20 and 22"),
      });
      expect(server.counts()).toEqual({
        controlConnections: 1,
        renderConnections: 0,
      });
    });
  }

  for (const protocol of [21, 23, 999]) {
    test(`classifies unsupported binary Welcome ${protocol} as permanent`, async () => {
      const server = await startProbeServers(
        "unsupported-welcome",
        "valid",
        22,
        protocol,
      );
      await expect(
        testLocalConnectionProfile(server.profile),
      ).rejects.toMatchObject({
        retryable: false,
        message: expect.stringContaining(
          `Herdr protocol ${protocol} is not supported`,
        ),
      });
    });
  }

  test("probes two colliding-ID local servers through their own control and render sockets", async () => {
    const alpha = await startProbeServers("alpha");
    const beta = await startProbeServers("beta");

    const [alphaResult, betaResult] = await Promise.all([
      testLocalConnectionProfile(alpha.profile),
      testLocalConnectionProfile(beta.profile),
    ]);

    expect(alphaResult).toEqual({
      ok: true,
      version: "fake-alpha",
      protocol: 14,
    });
    expect(betaResult).toEqual({
      ok: true,
      version: "fake-beta",
      protocol: 14,
    });
    expect(alpha.counts()).toEqual({
      controlConnections: 1,
      renderConnections: 1,
    });
    expect(beta.counts()).toEqual({
      controlConnections: 1,
      renderConnections: 1,
    });
  });

  test("contains missing and malformed render probe failures", async () => {
    const healthyControl = await startProbeServers("missing-render");
    await expect(
      testLocalConnectionProfile({
        ...healthyControl.profile,
        client_socket_path: join(
          dirname(healthyControl.profile.client_socket_path),
          "absent.sock",
        ),
      }),
    ).rejects.toThrow();

    const malformed = await startProbeServers("malformed-render", "malformed");
    await expect(
      testLocalConnectionProfile(malformed.profile),
    ).rejects.toMatchObject({
      retryable: false,
      message: expect.stringContaining("bincode: short read"),
    });
  });

  test("first create persists a restart-consistent default and retires synthetic runtime", async () => {
    const store = new ConnectionProfileStore({ path: tempPath() });
    const bootstrap = loadConnectionProfileBootstrap({
      store,
      legacyProfile: legacy,
      explicitLegacyOverride: false,
    });
    const manager = new ConnectionManager<FakeRuntime>(
      bootstrap.defaultConnectionId,
    );
    const created = new Map<string, FakeRuntime[]>();
    const service = new ConnectionProfileService({
      manager,
      store,
      bootstrap,
      createRuntime: runtimeFactory(created),
    });
    await manager.startDefault();
    const retired = manager.defaultRuntime();

    const result = await service.create(local("alpha"));
    expect(result).toMatchObject({
      id: "alpha",
      is_default: false,
      state: "ready",
    });
    expect(manager.defaultId()).toBe("local");
    expect(manager.has("legacy-default")).toBeFalse();
    expect(retired?.stops).toBe(1);
    expect(store.load()).toEqual({
      version: 2,
      default_connection_id: "local",
      profiles: [
        {
          id: "local",
          label: "Local",
          type: "local",
          control_socket_path: legacy.control_socket_path,
          client_socket_path: legacy.client_socket_path,
          auto_connect: true,
        },
        local("alpha"),
      ],
    });
    // The seeded local profile preserves the default server and is writable.
    expect(service.list().map(({ id }) => id)).toEqual(["local", "alpha"]);
    expect(service.list()[0]).toMatchObject({
      id: "local",
      label: "Local",
      is_default: true,
      state: "ready",
      read_only: false,
    });
  });

  for (const retryable of [false, true]) {
    test(`first failed SSH profile remains removable (retryable: ${retryable})`, async () => {
      const store = new ConnectionProfileStore({ path: tempPath() });
      const bootstrap = loadConnectionProfileBootstrap({
        store,
        legacyProfile: legacy,
        explicitLegacyOverride: false,
      });
      const manager = new ConnectionManager<FakeRuntime>(
        bootstrap.defaultConnectionId,
      );
      const baseFactory = runtimeFactory(new Map());
      const timers: Array<{ cancelled: boolean }> = [];
      const service = new ConnectionProfileService({
        manager,
        store,
        bootstrap,
        createRuntime: (profile) => (context) => {
          const runtime = baseFactory(profile)(context);
          if (profile.type === "ssh") {
            runtime.startTransport = async () => {
              throw new SshTunnelError(
                "SSH connection failed",
                retryable,
                retryable ? "unreachable" : "authentication",
                255,
              );
            };
          }
          return runtime;
        },
        retry: {
          schedule: () => {
            const timer = { cancelled: false };
            timers.push(timer);
            return { cancel: () => (timer.cancelled = true) };
          },
        },
      });
      await service.startConfigured();

      try {
        await expect(
          service.create(ssh("remote", true)),
        ).resolves.toMatchObject({
          id: "remote",
          is_default: false,
          state: retryable ? "reconnecting" : "error",
        });
        expect(manager.status("local")).toMatchObject({
          is_default: true,
          state: "ready",
        });
        expect(store.load()?.default_connection_id).toBe("local");
        await expect(service.remove("remote")).resolves.toEqual({ ok: true });
        expect(manager.has("remote")).toBeFalse();
        expect(timers.every((timer) => timer.cancelled)).toBeTrue();
        const restarted = loadConnectionProfileBootstrap({
          store,
          legacyProfile: legacy,
          explicitLegacyOverride: false,
        });
        expect(restarted.defaultConnectionId).toBe("local");
        expect(
          restarted.registrations.map(({ profile }) => profile.id),
        ).toEqual(["local"]);
      } finally {
        service.stopSupervision();
        await manager.stopAll();
      }
    });
  }

  test("first create named local seeds the default server under a distinct id", async () => {
    const store = new ConnectionProfileStore({ path: tempPath() });
    const bootstrap = loadConnectionProfileBootstrap({
      store,
      legacyProfile: legacy,
      explicitLegacyOverride: false,
    });
    const manager = new ConnectionManager<FakeRuntime>(
      bootstrap.defaultConnectionId,
    );
    const service = new ConnectionProfileService({
      manager,
      store,
      bootstrap,
      createRuntime: runtimeFactory(new Map()),
    });

    await expect(service.create(local("local"))).resolves.toMatchObject({
      id: "local",
      is_default: false,
    });
    expect(manager.defaultId()).toBe("localhost");
    expect(store.load()).toEqual({
      version: 2,
      default_connection_id: "localhost",
      profiles: [
        {
          id: "localhost",
          label: "Local",
          type: "local",
          control_socket_path: legacy.control_socket_path,
          client_socket_path: legacy.client_socket_path,
          auto_connect: true,
        },
        local("local"),
      ],
    });
    expect(service.list().map(({ id }) => id)).toEqual(["localhost", "local"]);
  });

  test("first create cannot leave a failed synthetic cleanup reconnectable", async () => {
    const store = new ConnectionProfileStore({ path: tempPath() });
    const failingLegacy = {
      ...legacy,
      control_socket_path: localSocketPath("bad-stop"),
    };
    const bootstrap = loadConnectionProfileBootstrap({
      store,
      legacyProfile: failingLegacy,
      explicitLegacyOverride: false,
    });
    const manager = new ConnectionManager<FakeRuntime>(
      bootstrap.defaultConnectionId,
    );
    const created = new Map<string, FakeRuntime[]>();
    const baseFactory = runtimeFactory(created);
    const service = new ConnectionProfileService({
      manager,
      store,
      bootstrap,
      createRuntime: (profile) => (context) => {
        const runtime = baseFactory(profile)(context);
        if (profile.id === "legacy-default") {
          runtime.stop = async () => {
            runtime.stops += 1;
            throw new Error("synthetic cleanup failed");
          };
        }
        return runtime;
      },
    });
    await manager.startDefault();

    await expect(service.create(local("alpha"))).resolves.toMatchObject({
      id: "alpha",
      is_default: false,
    });
    expect(manager.has("legacy-default")).toBeFalse();
    expect(service.list().map(({ id }) => id)).toEqual(["local", "alpha"]);
    expect(() => manager.start("legacy-default")).toThrow("unknown connection");
  });

  test("starts default and auto-connect profiles independently and isolates failures", async () => {
    const registry = {
      version: 1 as const,
      default_connection_id: "alpha",
      profiles: [
        local("alpha", false),
        local("bad-start", true),
        local("beta", true),
      ],
    };
    const store = await persistedStore(registry);
    const bootstrap = loadConnectionProfileBootstrap({
      store,
      legacyProfile: legacy,
      explicitLegacyOverride: false,
    });
    const manager = new ConnectionManager<FakeRuntime>(
      bootstrap.defaultConnectionId,
    );
    const service = new ConnectionProfileService({
      manager,
      store,
      bootstrap,
      createRuntime: runtimeFactory(new Map()),
    });

    await service.startConfigured();
    expect(manager.status("alpha").state).toBe("ready");
    expect(manager.status("beta").state).toBe("ready");
    expect(manager.status("bad-start").state).toBe("error");
  });

  test("lists, tests, connects, disconnects, changes default, updates, and removes without crossing runtimes", async () => {
    const store = await persistedStore({
      version: 1,
      default_connection_id: "alpha",
      profiles: [local("alpha", false), local("beta", false)],
    });
    const bootstrap = loadConnectionProfileBootstrap({
      store,
      legacyProfile: legacy,
      explicitLegacyOverride: false,
    });
    const manager = new ConnectionManager<FakeRuntime>(
      bootstrap.defaultConnectionId,
    );
    const created = new Map<string, FakeRuntime[]>();
    const tested: string[] = [];
    const service = new ConnectionProfileService({
      manager,
      store,
      bootstrap,
      createRuntime: runtimeFactory(created),
      testProfile: async (profile) => {
        tested.push(profile.id);
        return { ok: true, version: "test", protocol: 13 };
      },
    });

    expect(service.list()).toEqual([
      expect.objectContaining({ id: "alpha", type: "local", read_only: false }),
      expect.objectContaining({ id: "beta", type: "local", read_only: false }),
    ]);
    await service.connect("alpha");
    expect(manager.readyRuntime("alpha")?.identity.id).toBe("alpha");
    expect(manager.readyRuntime("beta")).toBeNull();
    await service.test({ id: "beta" });
    expect(tested).toEqual(["beta"]);
    await service.disconnect("alpha");
    await expect(service.remove("alpha")).rejects.toThrow(
      "cannot remove the default connection",
    );
    await service.setDefault("beta");
    expect(manager.defaultId()).toBe("beta");
    await service.update("alpha", {
      ...local("alpha", false),
      label: "Alpha edited",
    });
    expect(manager.status("alpha").label).toBe("Alpha edited");
    await service.remove("alpha");
    expect(manager.has("alpha")).toBeFalse();
    expect(manager.has("beta")).toBeTrue();
  });

  test("explicit legacy mode can remove the last persisted non-default profile", async () => {
    const store = await persistedStore({
      version: 1,
      default_connection_id: "alpha",
      profiles: [local("alpha", false)],
    });
    const bootstrap = loadConnectionProfileBootstrap({
      store,
      legacyProfile: legacy,
      explicitLegacyOverride: true,
    });
    const manager = new ConnectionManager<FakeRuntime>(
      bootstrap.defaultConnectionId,
    );
    const service = new ConnectionProfileService({
      manager,
      store,
      bootstrap,
      createRuntime: runtimeFactory(new Map()),
    });

    await expect(service.remove("legacy-default")).rejects.toThrow(
      "connection profile is read-only",
    );
    await service.remove("alpha");
    expect(store.load()).toBeNull();
    expect(manager.defaultId()).toBe("legacy-default");
    expect(manager.has("alpha")).toBeFalse();
  });

  test("remove leaves persistence untouched when unregister rejects", async () => {
    const store = await persistedStore({
      version: 1,
      default_connection_id: "alpha",
      profiles: [local("alpha", false), local("beta", false)],
    });
    const before = readFileSync(store.path, "utf8");
    const bootstrap = loadConnectionProfileBootstrap({
      store,
      legacyProfile: legacy,
      explicitLegacyOverride: false,
    });
    const manager = new ConnectionManager<FakeRuntime>(
      bootstrap.defaultConnectionId,
    );
    const service = new ConnectionProfileService({
      manager,
      store,
      bootstrap,
      createRuntime: runtimeFactory(new Map()),
    });
    manager.unregister = async () => {
      throw new Error("unregister rejected");
    };
    let saveCalls = 0;
    store.save = async () => {
      saveCalls += 1;
      throw new Error("rollback save would fail");
    };

    await expect(service.remove("beta")).rejects.toThrow("unregister rejected");
    expect(saveCalls).toBe(0);
    expect(readFileSync(store.path, "utf8")).toBe(before);
    expect(manager.has("beta")).toBeTrue();
  });

  test("remove restores the old registration when persistence fails", async () => {
    const initial = await persistedStore({
      version: 1,
      default_connection_id: "alpha",
      profiles: [local("alpha", false), local("beta", false)],
    });
    const before = readFileSync(initial.path, "utf8");
    const store = new ConnectionProfileStore({
      path: initial.path,
      beforeRename() {
        throw new Error("remove persistence failed");
      },
    });
    const bootstrap = loadConnectionProfileBootstrap({
      store,
      legacyProfile: legacy,
      explicitLegacyOverride: false,
    });
    const manager = new ConnectionManager<FakeRuntime>(
      bootstrap.defaultConnectionId,
    );
    const service = new ConnectionProfileService({
      manager,
      store,
      bootstrap,
      createRuntime: runtimeFactory(new Map()),
    });
    await manager.start("beta");

    await expect(service.remove("beta")).rejects.toThrow(
      "remove persistence failed",
    );
    expect(readFileSync(store.path, "utf8")).toBe(before);
    expect(manager.has("beta")).toBeTrue();
    expect(manager.status("beta").state).toBe("ready");
    expect(service.list().some(({ id }) => id === "beta")).toBeTrue();
  });

  test("retries transient SSH failures with bounded exponential jitter and generation retirement", async () => {
    const store = await persistedStore({
      version: 2,
      default_connection_id: "remote",
      profiles: [ssh("remote", true)],
    });
    const bootstrap = loadConnectionProfileBootstrap({
      store,
      legacyProfile: legacy,
      explicitLegacyOverride: false,
    });
    const manager = new ConnectionManager<FakeRuntime>("remote");
    const created = new Map<string, FakeRuntime[]>();
    const timers: Array<{
      callback: () => void;
      delayMs: number;
      cancelled: boolean;
    }> = [];
    const service = new ConnectionProfileService({
      manager,
      store,
      bootstrap,
      createRuntime: runtimeFactory(created),
      retry: {
        baseDelayMs: 100,
        maxDelayMs: 1000,
        maxAttempts: 3,
        stableResetMs: 10_000,
        random: () => 0,
        schedule: (callback, delayMs) => {
          const timer = { callback, delayMs, cancelled: false };
          timers.push(timer);
          return { cancel: () => (timer.cancelled = true) };
        },
      },
    });
    await service.startConfigured();
    const first = created.get("remote")![0];
    const oldLease = manager.readyRuntimeLease("remote")!;
    const transient = new SshTunnelError(
      "SSH destination is temporarily unreachable",
      true,
      "unreachable",
      255,
    );

    const reconnecting = service.willRetry("remote", transient);
    first.context.reportError(transient, { reconnecting });
    service.runtimeFailed("remote", transient);
    expect(reconnecting).toBeTrue();
    expect(oldLease.isCurrent()).toBeFalse();
    expect(manager.status("remote").state).toBe("reconnecting");
    await waitUntil(() => manager.currentRuntime("remote") === null);
    expect(timers[0]).toMatchObject({ delayMs: 50, cancelled: false });

    timers[0].callback();
    await waitUntil(() => manager.status("remote").state === "ready");
    expect(created.get("remote")).toHaveLength(2);
    const stableTimer = timers.find((timer) => timer.delayMs === 10_000)!;
    expect(stableTimer.cancelled).toBeFalse();

    const second = created.get("remote")![1];
    second.context.reportError(transient, { reconnecting: true });
    service.runtimeFailed("remote", transient);
    await waitUntil(() => manager.currentRuntime("remote") === null);
    expect(stableTimer.cancelled).toBeTrue();
    expect(timers.at(-1)).toMatchObject({ delayMs: 100, cancelled: false });
    service.stopSupervision();
    expect(timers.at(-1)?.cancelled).toBeTrue();
  });

  test("queues one retry when an exit callback and startup rejection report the same failure", async () => {
    const store = await persistedStore({
      version: 2,
      default_connection_id: "remote",
      profiles: [ssh("remote", false)],
    });
    const bootstrap = loadConnectionProfileBootstrap({
      store,
      legacyProfile: legacy,
      explicitLegacyOverride: false,
    });
    const manager = new ConnectionManager<FakeRuntime>("remote");
    const timers: Array<{
      callback: () => void;
      delayMs: number;
      cancelled: boolean;
    }> = [];
    const transient = new SshTunnelError(
      "SSH destination is temporarily unreachable",
      true,
      "unreachable",
      255,
    );
    function reportStartupExit(
      profileId: string,
      context: ConnectionRuntimeContext,
    ) {
      context.reportError(transient, { reconnecting: true });
      service.runtimeFailed(profileId, transient);
    }
    const service = new ConnectionProfileService({
      manager,
      store,
      bootstrap,
      createRuntime: (profile) => (context) => ({
        identity: connectionIdentityForProfile(profile),
        context,
        stops: 0,
        async startTransport() {
          reportStartupExit(profile.id, context);
          throw transient;
        },
        startBackground() {},
        async stop() {},
      }),
      retry: {
        baseDelayMs: 100,
        maxAttempts: 3,
        random: () => 0,
        schedule: (callback, delayMs) => {
          const timer = { callback, delayMs, cancelled: false };
          timers.push(timer);
          return { cancel: () => (timer.cancelled = true) };
        },
      },
    });

    await expect(service.connect("remote")).rejects.toThrow(
      "temporarily unreachable",
    );

    expect(timers).toHaveLength(1);
    expect(timers[0]).toMatchObject({ delayMs: 50, cancelled: false });
    timers[0].callback();
    await waitUntil(() => timers.length === 2);
    expect(timers.map(({ delayMs }) => delayMs)).toEqual([50, 100]);
    service.stopSupervision();
  });

  test("cancels a fired retry while failed-runtime cleanup is still pending", async () => {
    const store = await persistedStore({
      version: 2,
      default_connection_id: "remote",
      profiles: [ssh("remote", false)],
    });
    const bootstrap = loadConnectionProfileBootstrap({
      store,
      legacyProfile: legacy,
      explicitLegacyOverride: false,
    });
    const manager = new ConnectionManager<FakeRuntime>("remote");
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const created: FakeRuntime[] = [];
    const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
    const service = new ConnectionProfileService({
      manager,
      store,
      bootstrap,
      createRuntime: (profile) => (context) => {
        const runtime: FakeRuntime = {
          identity: connectionIdentityForProfile(profile),
          context,
          stops: 0,
          async startTransport() {},
          startBackground() {},
          async stop() {
            runtime.stops += 1;
            await stopGate;
          },
        };
        created.push(runtime);
        return runtime;
      },
      retry: {
        baseDelayMs: 100,
        random: () => 0,
        schedule: (callback) => {
          const timer = { callback, cancelled: false };
          timers.push(timer);
          return { cancel: () => (timer.cancelled = true) };
        },
      },
    });
    await service.connect("remote");
    const transient = new SshTunnelError(
      "SSH tunnel exited",
      true,
      "exited",
      255,
    );
    created[0].context.reportError(transient, { reconnecting: true });
    service.runtimeFailed("remote", transient);
    await waitUntil(() => timers.length === 1 && created[0].stops === 1);

    timers[0].callback();
    const disconnecting = service.disconnect("remote");
    releaseStop();
    await disconnecting;
    await Bun.sleep(1);

    expect(created).toHaveLength(1);
    expect(manager.status("remote").state).toBe("disconnected");
    expect(timers).toHaveLength(1);
  });

  test("does not double-count a startup exit after its retry timer has fired", async () => {
    const store = await persistedStore({
      version: 2,
      default_connection_id: "remote",
      profiles: [ssh("remote", false)],
    });
    const bootstrap = loadConnectionProfileBootstrap({
      store,
      legacyProfile: legacy,
      explicitLegacyOverride: false,
    });
    const manager = new ConnectionManager<FakeRuntime>("remote");
    let releaseFirstProbe!: () => void;
    const firstProbe = new Promise<void>((resolve) => {
      releaseFirstProbe = resolve;
    });
    const timers: Array<{
      callback: () => void;
      delayMs: number;
      cancelled: boolean;
    }> = [];
    const transient = new SshTunnelError(
      "SSH destination is temporarily unreachable",
      true,
      "unreachable",
      255,
    );
    let createdCount = 0;
    function reportDelayedStartupExit(
      profileId: string,
      context: ConnectionRuntimeContext,
    ) {
      context.reportError(transient, { reconnecting: true });
      service.runtimeFailed(profileId, transient);
    }
    const service = new ConnectionProfileService({
      manager,
      store,
      bootstrap,
      createRuntime: (profile) => (context) => {
        createdCount += 1;
        const ordinal = createdCount;
        return {
          identity: connectionIdentityForProfile(profile),
          context,
          stops: 0,
          async startTransport() {
            if (ordinal !== 1) return;
            reportDelayedStartupExit(profile.id, context);
            await firstProbe;
            throw transient;
          },
          startBackground() {},
          async stop() {},
        };
      },
      retry: {
        baseDelayMs: 100,
        maxAttempts: 3,
        stableResetMs: 10_000,
        random: () => 0,
        schedule: (callback, delayMs) => {
          const timer = { callback, delayMs, cancelled: false };
          timers.push(timer);
          return { cancel: () => (timer.cancelled = true) };
        },
      },
    });

    const connecting = service.connect("remote");
    await waitUntil(() => timers.length === 1);
    timers[0].callback();
    releaseFirstProbe();
    await expect(connecting).rejects.toThrow("temporarily unreachable");
    await waitUntil(() => manager.status("remote").state === "ready");

    expect(createdCount).toBe(2);
    expect(timers.filter(({ delayMs }) => delayMs !== 10_000)).toEqual([
      expect.objectContaining({ delayMs: 50 }),
    ]);
    service.stopSupervision();
  });

  test("bounds repeated SSH startup retries and caps exponential delays", async () => {
    const store = await persistedStore({
      version: 2,
      default_connection_id: "remote",
      profiles: [ssh("remote", true)],
    });
    const bootstrap = loadConnectionProfileBootstrap({
      store,
      legacyProfile: legacy,
      explicitLegacyOverride: false,
    });
    const manager = new ConnectionManager<FakeRuntime>("remote");
    const created = new Map<string, FakeRuntime[]>();
    const baseFactory = runtimeFactory(created);
    const timers: Array<{ callback: () => void; delayMs: number }> = [];
    const transient = new SshTunnelError(
      "SSH destination is temporarily unreachable",
      true,
      "unreachable",
      255,
    );
    const service = new ConnectionProfileService({
      manager,
      store,
      bootstrap,
      createRuntime: (profile) => (context) => {
        const runtime = baseFactory(profile)(context);
        runtime.startTransport = async () => {
          throw transient;
        };
        return runtime;
      },
      retry: {
        baseDelayMs: 100,
        maxDelayMs: 200,
        maxAttempts: 3,
        random: () => 0,
        schedule: (callback, delayMs) => {
          timers.push({ callback, delayMs });
          return { cancel: () => undefined };
        },
      },
    });

    await service.startConfigured();
    expect(timers.map(({ delayMs }) => delayMs)).toEqual([50]);
    timers[0].callback();
    await waitUntil(() => timers.length === 2);
    expect(timers[1].delayMs).toBe(100);
    timers[1].callback();
    await waitUntil(() => timers.length === 3);
    expect(timers[2].delayMs).toBe(100);
    timers[2].callback();
    await waitUntil(() => manager.status("remote").state === "error");
    await Bun.sleep(1);
    expect(timers).toHaveLength(3);
    expect(created.get("remote")).toHaveLength(4);
  });

  test("does not retry permanent SSH failures and disconnect cancels queued retry", async () => {
    const store = await persistedStore({
      version: 2,
      default_connection_id: "remote",
      profiles: [ssh("remote", true)],
    });
    const bootstrap = loadConnectionProfileBootstrap({
      store,
      legacyProfile: legacy,
      explicitLegacyOverride: false,
    });
    const manager = new ConnectionManager<FakeRuntime>("remote");
    const created = new Map<string, FakeRuntime[]>();
    const timers: Array<{
      callback: () => void;
      cancelled: boolean;
    }> = [];
    const service = new ConnectionProfileService({
      manager,
      store,
      bootstrap,
      createRuntime: runtimeFactory(created),
      retry: {
        baseDelayMs: 10,
        maxDelayMs: 20,
        random: () => 0,
        schedule: (callback) => {
          const timer = { callback, cancelled: false };
          timers.push(timer);
          return { cancel: () => (timer.cancelled = true) };
        },
      },
    });
    await service.startConfigured();
    const permanent = new SshTunnelError(
      "SSH authentication failed",
      false,
      "authentication",
      255,
    );
    expect(
      service.willRetry(
        "remote",
        new ConnectionProbeError("unsupported protocol", false),
      ),
    ).toBeFalse();
    expect(
      service.willRetry(
        "remote",
        new SshTunnelError(
          "SSH is unsupported on this platform",
          false,
          "unsupported",
          -1,
        ),
      ),
    ).toBeFalse();
    const first = created.get("remote")![0];
    first.context.reportError(permanent, { reconnecting: false });
    service.runtimeFailed("remote", permanent);
    await waitUntil(() => manager.currentRuntime("remote") === null);
    expect(manager.status("remote").state).toBe("error");
    expect(timers).toHaveLength(0);

    await service.connect("remote");
    const second = created.get("remote")![1];
    const transient = new SshTunnelError(
      "SSH tunnel exited",
      true,
      "exited",
      1,
    );
    second.context.reportError(transient, { reconnecting: true });
    service.runtimeFailed("remote", transient);
    await service.disconnect("remote");
    expect(manager.status("remote").state).toBe("disconnected");
    expect(timers).toHaveLength(1);
    expect(timers[0].cancelled).toBeTrue();
    timers[0].callback();
    await Bun.sleep(1);
    expect(created.get("remote")).toHaveLength(2);
  });

  test("migrates a v1 registry while creating, testing, and connecting an SSH profile", async () => {
    const store = await persistedStore({
      version: 1,
      default_connection_id: "alpha",
      profiles: [local("alpha", false)],
    });
    const bootstrap = loadConnectionProfileBootstrap({
      store,
      legacyProfile: legacy,
      explicitLegacyOverride: false,
    });
    const manager = new ConnectionManager<FakeRuntime>(
      bootstrap.defaultConnectionId,
    );
    const created = new Map<string, FakeRuntime[]>();
    const tested: ManagedConnectionProfile[] = [];
    const service = new ConnectionProfileService({
      manager,
      store,
      bootstrap,
      createRuntime: runtimeFactory(created),
      testProfile: async (profile) => {
        tested.push(profile);
        return { ok: true, version: "remote", protocol: 14 };
      },
    });

    await expect(service.create(ssh("remote"))).resolves.toMatchObject({
      id: "remote",
      type: "ssh",
      state: "disconnected",
      ssh_destination: "operator@remote",
      remote_control_socket_path: "/remote/remote.sock",
      remote_client_socket_path: "/remote/remote-client.sock",
      read_only: false,
    });
    expect(store.load()).toEqual({
      version: 2,
      default_connection_id: "alpha",
      profiles: [local("alpha", false), ssh("remote")],
    });
    await expect(service.test({ id: "remote" })).resolves.toMatchObject({
      version: "remote",
    });
    expect(tested).toEqual([ssh("remote")]);
    await expect(service.connect("remote")).resolves.toMatchObject({
      state: "ready",
      type: "ssh",
    });
    expect(manager.readyRuntime("remote")?.identity.source).toBe("ssh-profile");
  });

  test("failed SSH update rollback cancels replacement retry intent", async () => {
    const oldRemote = ssh("remote", false);
    const store = await persistedStore({
      version: 2,
      default_connection_id: "alpha",
      profiles: [local("alpha", false), oldRemote],
    });
    const bootstrap = loadConnectionProfileBootstrap({
      store,
      legacyProfile: legacy,
      explicitLegacyOverride: false,
    });
    const manager = new ConnectionManager<FakeRuntime>("alpha");
    const created = new Map<string, FakeRuntime[]>();
    const baseFactory = runtimeFactory(created);
    const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
    const transient = new SshTunnelError(
      "SSH destination is temporarily unreachable",
      true,
      "unreachable",
      255,
    );
    const service = new ConnectionProfileService({
      manager,
      store,
      bootstrap,
      createRuntime: (profile) => (context) => {
        const runtime = baseFactory(profile)(context);
        if (profile.type === "ssh" && profile.auto_connect) {
          runtime.startTransport = async () => {
            throw transient;
          };
        }
        return runtime;
      },
      retry: {
        schedule: (callback) => {
          const timer = { callback, cancelled: false };
          timers.push(timer);
          return { cancel: () => (timer.cancelled = true) };
        },
      },
    });

    await expect(
      service.update("remote", { ...oldRemote, auto_connect: true }),
    ).rejects.toThrow("temporarily unreachable");
    expect(store.load()).toEqual({
      version: 2,
      default_connection_id: "alpha",
      profiles: [local("alpha", false), oldRemote],
    });
    expect(manager.status("remote").state).toBe("disconnected");
    expect(timers).toHaveLength(1);
    expect(timers[0].cancelled).toBeTrue();
    timers[0].callback();
    await Bun.sleep(1);
    expect(created.get("remote")).toHaveLength(1);
  });

  test("disables mutations and preserves the durable replacement when rollback persistence fails", async () => {
    const original = local("alpha");
    const store = await persistedStore({
      version: 1,
      default_connection_id: "alpha",
      profiles: [original],
    });
    const bootstrap = loadConnectionProfileBootstrap({
      store,
      legacyProfile: legacy,
      explicitLegacyOverride: false,
    });
    const manager = new ConnectionManager<FakeRuntime>("alpha");
    const created = new Map<string, FakeRuntime[]>();
    const originalSave = store.save.bind(store);
    let saveCalls = 0;
    store.save = async (registry) => {
      saveCalls += 1;
      if (saveCalls === 1) return originalSave(registry);
      throw new Error("rollback persistence failed");
    };
    const service = new ConnectionProfileService({
      manager,
      store,
      bootstrap,
      createRuntime: runtimeFactory(created),
      testProfile: async () => ({ ok: true, version: null, protocol: 14 }),
    });
    await manager.startDefault();
    const replacement = {
      ...original,
      control_socket_path: localSocketPath("bad-start"),
    };

    await expect(service.update("alpha", replacement)).rejects.toThrow(
      "rollback was incomplete",
    );

    expect(store.load()).toEqual({
      version: 2,
      default_connection_id: "alpha",
      profiles: [replacement],
    });
    expect(service.list()[0]).toMatchObject({
      id: "alpha",
      control_socket_path: localSocketPath("bad-start"),
    });
    expect(manager.readyRuntime("alpha")).toBeNull();
    await expect(service.create(local("beta"))).rejects.toThrow(
      "persistence rollback failed",
    );
  });

  test("failed replacement start rolls back the old file, factory, and ready runtime", async () => {
    const store = await persistedStore({
      version: 1,
      default_connection_id: "alpha",
      profiles: [local("alpha")],
    });
    const bootstrap = loadConnectionProfileBootstrap({
      store,
      legacyProfile: legacy,
      explicitLegacyOverride: false,
    });
    const manager = new ConnectionManager<FakeRuntime>(
      bootstrap.defaultConnectionId,
    );
    const created = new Map<string, FakeRuntime[]>();
    const service = new ConnectionProfileService({
      manager,
      store,
      bootstrap,
      createRuntime: runtimeFactory(created),
      testProfile: async () => ({ ok: true, version: "test", protocol: 14 }),
    });
    await service.startConfigured();
    const before = readFileSync(store.path, "utf8");

    await expect(
      service.update("alpha", {
        ...local("alpha"),
        control_socket_path: localSocketPath("bad-start"),
      }),
    ).rejects.toThrow("transport unavailable");
    expect(manager.status("alpha")).toMatchObject({
      label: "ALPHA",
      state: "ready",
    });
    expect(created.get("alpha")).toHaveLength(3);
    expect(readFileSync(store.path, "utf8")).toBe(before);
  });

  test("failed ready-profile validation preserves old runtime and exact persisted file", async () => {
    const store = await persistedStore({
      version: 1,
      default_connection_id: "alpha",
      profiles: [local("alpha")],
    });
    const bootstrap = loadConnectionProfileBootstrap({
      store,
      legacyProfile: legacy,
      explicitLegacyOverride: false,
    });
    const manager = new ConnectionManager<FakeRuntime>(
      bootstrap.defaultConnectionId,
    );
    const created = new Map<string, FakeRuntime[]>();
    const service = new ConnectionProfileService({
      manager,
      store,
      bootstrap,
      createRuntime: runtimeFactory(created),
      testProfile: async () => {
        throw new Error("probe rejected replacement");
      },
    });
    await service.startConfigured();
    const runtime = manager.readyRuntime("alpha");
    const before = readFileSync(store.path, "utf8");

    await expect(
      service.update("alpha", { ...local("alpha"), label: "Unsafe edit" }),
    ).rejects.toThrow("probe rejected replacement");
    expect(manager.readyRuntime("alpha")).toBe(runtime);
    expect(manager.status("alpha").label).toBe("ALPHA");
    expect(readFileSync(store.path, "utf8")).toBe(before);
  });
});

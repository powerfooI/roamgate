import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BinReader, BinWriter, encodeFrame } from "../bridge/bincode";
import type { LocalConnectionProfile } from "./profiles";

const roots: string[] = [];
const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();
const controlCalls = new Map<string, string[]>();

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
  controlCalls.clear();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function trackSocket(socket: net.Socket) {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", (error: NodeJS.ErrnoException) => {
    // The bridge can exit while a background RPC response is being written.
    if (error.code !== "EPIPE" && error.code !== "ECONNRESET") throw error;
  });
}

test("fixture sockets tolerate peer shutdown but surface unexpected errors", () => {
  const socket = new net.Socket();
  trackSocket(socket);
  for (const code of ["EPIPE", "ECONNRESET"])
    expect(() =>
      socket.emit("error", Object.assign(new Error(code), { code })),
    ).not.toThrow();
  const unexpected = Object.assign(new Error("unexpected socket failure"), {
    code: "EINVAL",
  });
  expect(() => socket.emit("error", unexpected)).toThrow(unexpected);
});

async function listen(server: net.Server, path: string): Promise<void> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
}

async function fakeHerdr(
  root: string,
  id: string,
  protocol: unknown = 14,
  welcomeProtocol?: number,
  respond?: (request: {
    method: string;
    params?: Record<string, unknown>;
  }) => unknown,
): Promise<LocalConnectionProfile> {
  const controlPath = join(root, `${id}-control.sock`);
  const renderPath = join(root, `${id}-render.sock`);
  await listen(
    net.createServer((socket) => {
      trackSocket(socket);
      let input = "";
      socket.on("data", async (chunk) => {
        input += chunk.toString();
        const newline = input.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(input.slice(0, newline));
        const calls = controlCalls.get(id) ?? [];
        calls.push(request.method);
        controlCalls.set(id, calls);
        const result =
          (await respond?.(request)) ??
          (request.method === "ping"
            ? { version: `fake-${id}`, protocol }
            : request.method === "workspace.list"
              ? {
                  workspaces: [
                    {
                      workspace_id: "shared-workspace",
                      name: `from-${id}`,
                    },
                  ],
                }
              : {});
        socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
        if (request.method !== "events.subscribe") socket.end();
      });
    }),
    controlPath,
  );
  await listen(
    net.createServer((socket) => {
      trackSocket(socket);
      let input = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        input = Buffer.concat([input, Buffer.from(chunk)]);
        if (input.length < 4) return;
        const length = input.readUInt32LE(0);
        if (input.length < length + 4) return;
        const reader = new BinReader(input.subarray(4, length + 4));
        expect(reader.variant()).toBe(0);
        const protocol = reader.varint();
        const writer = new BinWriter();
        writer.variant(0);
        writer.varint(welcomeProtocol ?? protocol);
        writer.varint(1);
        writer.option<string>(undefined, (value) => writer.string(value));
        socket.write(encodeFrame(writer.toBuffer()));
      });
    }),
    renderPath,
  );
  return {
    id,
    label: id.toUpperCase(),
    type: "local",
    control_socket_path: controlPath,
    client_socket_path: renderPath,
    auto_connect: false,
  };
}

function bridgeListeningPort(stream: ReadableStream<Uint8Array>) {
  let settled = false;
  let resolvePort!: (port: number) => void;
  let rejectPort!: (error: Error) => void;
  const port = new Promise<number>((resolve, reject) => {
    resolvePort = resolve;
    rejectPort = reject;
  });
  void (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let output = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output += decoder.decode(value, { stream: true });
        const match = output.match(
          /\bINFO bridge listening\b[^\r\n]*\burl=http:\/\/[^\s]+:(\d+)\b/,
        );
        if (match && !settled) {
          settled = true;
          resolvePort(Number(match[1]));
        }
        if (output.length > 16_384) output = output.slice(-8_192);
      }
    } catch (error) {
      if (!settled) {
        settled = true;
        rejectPort(error as Error);
      }
    } finally {
      reader.releaseLock();
      if (!settled) {
        settled = true;
        rejectPort(new Error("bridge exited before reporting its port"));
      }
    }
  })();
  return port;
}

async function waitForHealth(port: number): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch {
      // Process may still be binding.
    }
    await Bun.sleep(25);
  }
  throw new Error("profile process fixture did not become healthy");
}

test("production dispatcher isolates two local profiles and profile CRUD", async () => {
  if (process.platform === "win32") return;
  const root = join(
    tmpdir(),
    `herdr-gui-profile-process-${crypto.randomUUID()}`,
  );
  roots.push(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const alpha = await fakeHerdr(root, "alpha", 14, undefined, ({ method }) =>
    method === "workspace.get"
      ? { workspace: { worktree: { checkout_path: root } } }
      : undefined,
  );
  const beta = await fakeHerdr(root, "beta");
  const registryPath = join(root, "connections.json");
  writeFileSync(
    registryPath,
    JSON.stringify({
      version: 1,
      default_connection_id: "alpha",
      profiles: [alpha, beta],
    }),
    { mode: 0o600 },
  );
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: "0",
    HERDR_GUI_CONNECTIONS_PATH: registryPath,
  };
  delete env.HERDR_SOCKET_PATH;
  delete env.HERDR_CLIENT_SOCKET_PATH;
  delete env.HERDR_SSH_HOST;
  delete env.HERDR_SESSION;
  const repositoryRoot = join(import.meta.dir, "../../..");
  const child = Bun.spawn(["bun", "server/src/index.ts"], {
    cwd: repositoryRoot,
    env,
    stdout: "pipe",
    stderr: "ignore",
  });
  let wsA: WebSocket | null = null;
  let wsB: WebSocket | null = null;
  try {
    const port = await bridgeListeningPort(child.stdout);
    await waitForHealth(port);
    const openBrowser = async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error("websocket open failed"));
      });
      return socket;
    };
    wsA = await openBrowser();
    wsB = await openBrowser();
    const rpcFor = (socket: WebSocket, prefix: string) => {
      let sequence = 0;
      const pending = new Map<string, (message: any) => void>();
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (typeof message.id === "string") pending.get(message.id)?.(message);
      };
      const raw = async (
        method: string,
        params: Record<string, unknown> = {},
        connectionId?: string,
        connectionGeneration?: number,
      ) => {
        const id = `${prefix}${++sequence}`;
        let timer!: ReturnType<typeof setTimeout>;
        const reply = new Promise<any>((resolve, reject) => {
          pending.set(id, resolve);
          timer = setTimeout(
            () => reject(new Error(`RPC timeout: ${method}`)),
            5_000,
          );
        });
        socket.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(connectionId ? { connection_id: connectionId } : {}),
            ...(connectionGeneration === undefined
              ? {}
              : { connection_generation: connectionGeneration }),
          }),
        );
        const message = await reply.finally(() => clearTimeout(timer));
        pending.delete(id);
        return message;
      };
      const rpc = async (
        method: string,
        params: Record<string, unknown> = {},
        connectionId?: string,
        connectionGeneration?: number,
      ) => {
        const message = await raw(
          method,
          params,
          connectionId,
          connectionGeneration,
        );
        if (message.error) throw new Error(message.error.message);
        return message.result;
      };
      return { raw, rpc };
    };
    const browserA = rpcFor(wsA, "a");
    const browserB = rpcFor(wsB, "b");
    const rpc = browserA.rpc;

    const catalog = await rpc("connections.list");
    expect(catalog.default_connection_id).toBe("alpha");
    expect(catalog.connections.map(({ id }: { id: string }) => id)).toEqual([
      "alpha",
      "beta",
    ]);
    expect((await rpc("bridge.status")).connections[0]).toMatchObject({
      id: "alpha",
      type: "local",
      read_only: false,
      auto_connect: false,
      control_socket_path: alpha.control_socket_path,
      client_socket_path: alpha.client_socket_path,
    });
    const oldAlphaGeneration = catalog.connections.find(
      ({ id }: { id: string }) => id === "alpha",
    ).generation as number;
    const browserBCatalog = await browserB.rpc("connections.list");
    expect(
      browserBCatalog.connections.find(
        ({ id }: { id: string }) => id === "alpha",
      ).generation,
    ).toBe(oldAlphaGeneration);
    const initialAlpha = await browserA.raw(
      "workspace.list",
      {},
      "alpha",
      oldAlphaGeneration,
    );
    expect(initialAlpha.connection_generation).toBe(oldAlphaGeneration);
    expect(initialAlpha.result.workspaces[0].name).toBe("from-alpha");
    writeFileSync(
      join(root, "page.html"),
      "<h1>HTML marker</h1><script>throw 1</script>",
    );
    const htmlPreview = await fetch(
      `http://127.0.0.1:${port}/api/connections/alpha/file/download?connection_generation=${oldAlphaGeneration}&workspace_id=shared-workspace&path=page.html&inline=1`,
    );
    expect(htmlPreview.status).toBe(200);
    expect(htmlPreview.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(htmlPreview.headers.get("content-disposition")).toStartWith(
      "inline;",
    );
    expect(htmlPreview.headers.get("content-security-policy")).toStartWith(
      "sandbox;",
    );
    expect(htmlPreview.headers.get("X-Herdr-Connection-Id")).toBe("alpha");
    expect(htmlPreview.headers.get("X-Herdr-Connection-Generation")).toBe(
      String(oldAlphaGeneration),
    );
    expect(await htmlPreview.text()).toBe("<h1>HTML marker</h1>");
    expect((await rpc("connections.test", { id: "beta" })).version).toBe(
      "fake-beta",
    );
    await rpc("connections.connect", { id: "beta" });
    const connectedCatalog = await rpc("connections.list");
    const betaGeneration = connectedCatalog.connections.find(
      ({ id }: { id: string }) => id === "beta",
    ).generation as number;
    expect(
      (await rpc("workspace.list", {}, "beta", betaGeneration)).workspaces[0]
        .name,
    ).toBe("from-beta");

    const replacementAlpha = {
      ...beta,
      id: "alpha",
      label: "ALPHA on beta server",
      auto_connect: false,
    };
    await browserB.rpc("connections.update", {
      id: "alpha",
      profile: replacementAlpha,
    });
    const replacedCatalog = await browserB.rpc("connections.list");
    const newAlphaGeneration = replacedCatalog.connections.find(
      ({ id }: { id: string }) => id === "alpha",
    ).generation as number;
    expect(newAlphaGeneration).not.toBe(oldAlphaGeneration);

    const betaPaneCloseCalls = () =>
      (controlCalls.get("beta") ?? []).filter(
        (method) => method === "pane.close",
      ).length;
    const beforeStalePaneClose = betaPaneCloseCalls();
    const staleAction = await browserA.raw(
      "pane.close",
      { pane_id: "shared-pane" },
      "alpha",
      oldAlphaGeneration,
    );
    expect(staleAction).toMatchObject({
      connection_id: "alpha",
      connection_generation: oldAlphaGeneration,
      error: { message: "connection generation changed: alpha" },
    });
    expect(betaPaneCloseCalls()).toBe(beforeStalePaneClose);

    const betaPingCalls = () =>
      (controlCalls.get("beta") ?? []).filter((method) => method === "ping")
        .length;
    const beforeStaleHttp = betaPingCalls();
    const staleHttp = await fetch(
      `http://127.0.0.1:${port}/api/connections/alpha/herdr-info?connection_generation=${oldAlphaGeneration}`,
    );
    expect(staleHttp.status).toBe(409);
    expect(staleHttp.headers.get("X-Herdr-Connection-Id")).toBe("alpha");
    expect(staleHttp.headers.get("X-Herdr-Connection-Generation")).toBe(
      String(oldAlphaGeneration),
    );
    expect(betaPingCalls()).toBe(beforeStaleHttp);

    // Explicitly retain old-client compatibility for both RPC and HTTP while
    // proving generation-bound current requests reach only the replacement.
    const legacySnapshot = await browserA.rpc("workspace.list", {}, "alpha");
    expect(legacySnapshot.workspaces[0].name).toBe("from-beta");
    expect(legacySnapshot.navigation_mode).toBe("shared");
    // The first snapshot also resolves the replacement terminal backend.
    const beforeLegacyHttp = betaPingCalls();
    const legacyHttp = await fetch(
      `http://127.0.0.1:${port}/api/connections/alpha/herdr-info`,
    );
    expect(legacyHttp.status).toBe(200);
    expect(legacyHttp.headers.get("X-Herdr-Connection-Generation")).toBe(
      String(newAlphaGeneration),
    );
    expect(await legacyHttp.json()).toMatchObject({ version: "fake-beta" });
    expect(betaPingCalls()).toBe(beforeLegacyHttp + 1);
    const currentAlpha = await browserB.raw(
      "workspace.list",
      {},
      "alpha",
      newAlphaGeneration,
    );
    expect(currentAlpha.connection_generation).toBe(newAlphaGeneration);
    expect(currentAlpha.result.workspaces[0].name).toBe("from-beta");

    const gamma = {
      ...alpha,
      id: "gamma",
      label: "GAMMA",
      auto_connect: false,
    };
    await rpc("connections.create", { profile: gamma });
    await rpc("connections.update", {
      id: "gamma",
      profile: { ...gamma, label: "Gamma edited" },
    });
    await rpc("connections.remove", { id: "gamma" });

    await rpc("connections.disconnect", { id: "alpha" });
    await rpc("connections.set_default", { id: "beta" });
    expect((await rpc("workspace.list")).workspaces[0].name).toBe("from-beta");
    await rpc("connections.remove", { id: "alpha" });
    const finalCatalog = await rpc("connections.list");
    expect(finalCatalog.default_connection_id).toBe("beta");
    expect(
      finalCatalog.connections.map(({ id }: { id: string }) => id),
    ).toEqual(["beta"]);
  } finally {
    wsA?.close();
    wsB?.close();
    child.kill("SIGTERM");
    await child.exited;
  }
}, 20_000);

for (const { protocol, welcomeProtocol, accepted } of [
  { protocol: 20, accepted: true },
  { protocol: 22, accepted: true },
  { protocol: 21, accepted: false },
  { protocol: 23, accepted: false },
  { protocol: "22", accepted: false },
  { protocol: 22, welcomeProtocol: 23, accepted: false },
]) {
  test(`default local startup validates protocol ${JSON.stringify(protocol)} / Welcome ${welcomeProtocol ?? "same"} before background RPCs`, async () => {
    if (process.platform === "win32") return;
    const root = join(tmpdir(), `h090-default-${crypto.randomUUID()}`);
    roots.push(root);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const profile = await fakeHerdr(root, "test", protocol, welcomeProtocol);
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "0",
      HERDR_GUI_CONNECTIONS_PATH: join(root, "connections.json"),
      HERDR_SOCKET_PATH: profile.control_socket_path,
      HERDR_CLIENT_SOCKET_PATH: profile.client_socket_path,
    };
    delete env.HERDR_SSH_HOST;
    delete env.HERDR_SESSION;
    const child = Bun.spawn(["bun", "server/src/index.ts"], {
      cwd: join(import.meta.dir, "../../.."),
      env,
      stdout: "pipe",
      stderr: "ignore",
    });
    let socket: WebSocket | undefined;
    try {
      const port = await bridgeListeningPort(child.stdout);
      const browser = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      socket = browser;
      await new Promise<void>((resolve, reject) => {
        browser.onopen = () => resolve();
        browser.onerror = () => reject(new Error("websocket open failed"));
      });
      let timer!: ReturnType<typeof setTimeout>;
      const reply = new Promise<any>((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("connect RPC timed out")),
          5_000,
        );
        browser.onmessage = (event) => {
          const message = JSON.parse(String(event.data));
          if (message.id === "connect-default") resolve(message);
        };
      });
      socket.send(
        JSON.stringify({
          id: "connect-default",
          method: "connections.connect",
          params: { id: "legacy-default" },
        }),
      );
      const response = await reply.finally(() => clearTimeout(timer));
      const calls = controlCalls.get("test") ?? [];
      expect(calls[0]).toBe("ping");
      if (accepted) {
        expect(response.error).toBeUndefined();
        expect(response.result.state).toBe("ready");
      } else {
        expect(response.error?.message).toContain("protocol");
        expect(calls.filter((method) => method !== "ping")).toEqual([]);
      }
    } finally {
      socket?.close();
      child.kill("SIGTERM");
      await child.exited;
    }
  }, 10_000);
}

test("production routing bootstraps only a verified empty session and serializes competing browsers", async () => {
  if (process.platform === "win32") return;
  const root = join(tmpdir(), `h110-bootstrap-${crypto.randomUUID()}`);
  roots.push(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let valid = false;
  let workspaces: Array<{ workspace_id: string }> = [];
  const mutations: Record<string, unknown>[] = [];
  const profile = await fakeHerdr(
    root,
    "empty",
    22,
    undefined,
    async (request) => {
      if (request.method === "workspace.list")
        return valid
          ? { type: "workspace_list", workspaces }
          : { workspaces: [] };
      if (request.method === "workspace.create") {
        mutations.push(request.params ?? {});
        await Bun.sleep(20);
        workspaces = [{ workspace_id: "w1" }];
        return {
          type: "workspace_created",
          workspace: workspaces[0],
          tab: { workspace_id: "w1", tab_id: "w1:t1" },
          root_pane: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1" },
        };
      }
    },
  );
  const registryPath = join(root, "connections.json");
  writeFileSync(
    registryPath,
    JSON.stringify({
      version: 1,
      default_connection_id: "empty",
      profiles: [profile],
    }),
    { mode: 0o600 },
  );
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: "0",
    HERDR_GUI_CONNECTIONS_PATH: registryPath,
  };
  for (const key of [
    "HERDR_SOCKET_PATH",
    "HERDR_CLIENT_SOCKET_PATH",
    "HERDR_SSH_HOST",
    "HERDR_SESSION",
  ])
    delete env[key];
  const child = Bun.spawn([process.execPath, "server/src/index.ts"], {
    cwd: join(import.meta.dir, "../../.."),
    env,
    stdout: "pipe",
    stderr: "ignore",
  });
  const browsers: WebSocket[] = [];
  try {
    const port = await bridgeListeningPort(child.stdout);
    await waitForHealth(port);
    for (let i = 0; i < 2; i++) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      browsers.push(ws);
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("socket failed"));
      });
    }
    let seq = 0;
    const rpc = (
      ws: WebSocket,
      method: string,
      params: Record<string, unknown>,
      generation?: number,
    ) =>
      new Promise<any>((resolve, reject) => {
        const id = `bootstrap-${++seq}`;
        const timer = setTimeout(() => {
          ws.removeEventListener("message", receive);
          reject(new Error("bootstrap RPC timed out"));
        }, 4000);
        const receive = (event: MessageEvent) => {
          const result = JSON.parse(String(event.data));
          if (result.id !== id) return;
          clearTimeout(timer);
          ws.removeEventListener("message", receive);
          resolve(result);
        };
        ws.addEventListener("message", receive);
        ws.send(
          JSON.stringify({
            id,
            method,
            connection_id: method === "workspace.create" ? "empty" : undefined,
            ...(generation === undefined
              ? {}
              : { connection_generation: generation }),
            params,
          }),
        );
      });
    // HTTP health only confirms the listener; await the backend handshake too.
    expect(
      await rpc(browsers[0], "connections.connect", { id: "empty" }),
    ).toMatchObject({ result: { state: "ready" } });
    expect(
      (await rpc(browsers[0], "workspace.create", { browser_source: null }))
        .error,
    ).toMatchObject({
      message: "Cannot verify an empty session. Refresh and retry creation.",
    });
    expect(mutations).toHaveLength(0);
    valid = true;
    const results = await Promise.all(
      browsers.map((ws) =>
        rpc(ws, "workspace.create", { browser_source: null, focus: true }),
      ),
    );
    expect(
      results.filter((result) => result.result?.type === "workspace_created"),
      JSON.stringify(results),
    ).toHaveLength(1);
    expect(results.filter((result) => result.error)).toHaveLength(1);
    expect(mutations).toEqual([{ focus: false }]);
    expect(
      (
        await rpc(browsers[0], "workspace.create", {
          browser_source: null,
          cwd: "/wrong",
        })
      ).error,
    ).toBeDefined();
    workspaces = [];
    expect(
      (
        await rpc(browsers[0], "workspace.create", {
          browser_source: null,
          cwd: "/explicit",
          focus: true,
        })
      ).result.type,
    ).toBe("workspace_created");
    expect(mutations[1]).toEqual({ cwd: "/explicit", focus: false });
    workspaces = [];
    expect(
      (
        await rpc(
          browsers[0],
          "workspace.create",
          { browser_source: null },
          99999,
        )
      ).error,
    ).toBeDefined();
    expect(mutations).toHaveLength(2);
  } finally {
    for (const ws of browsers) ws.close();
    child.kill("SIGTERM");
    await child.exited;
  }
}, 15000);

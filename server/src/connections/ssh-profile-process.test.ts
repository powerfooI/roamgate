import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as net from "node:net";
import { join } from "node:path";
import { BinReader, BinWriter, encodeFrame } from "../bridge/bincode";
import type { SshConnectionProfile } from "./profiles";

const password = "profile-test-password";
// Bun supports authentication headers on WebSocket handshakes.
const BrowserSocket = WebSocket as unknown as new (
  url: string,
  options: Bun.WebSocketOptions,
) => WebSocket;

async function login(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: "POST",
    body: JSON.stringify({ password }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie).toBeTruthy();
  return cookie!;
}

const roots: string[] = [];
const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();

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
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
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
  paths?: { controlPath: string; renderPath: string },
) {
  const controlPath = paths?.controlPath ?? join(root, `${id}-control.sock`);
  const renderPath = paths?.renderPath ?? join(root, `${id}-render.sock`);
  await listen(
    net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk.toString();
        const newline = input.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(input.slice(0, newline));
        const result =
          request.method === "ping"
            ? { version: `fake-${id}`, protocol: 14 }
            : request.method === "workspace.list"
              ? {
                  workspaces: [
                    {
                      workspace_id: "shared-workspace",
                      name: `from-${id}`,
                    },
                  ],
                }
              : {};
        socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
        if (request.method !== "events.subscribe") socket.end();
      });
    }),
    controlPath,
  );
  await listen(
    net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
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
        writer.varint(protocol);
        writer.varint(1);
        writer.option<string>(undefined, (value) => writer.string(value));
        socket.write(encodeFrame(writer.toBuffer()));
      });
    }),
    renderPath,
  );
  return { controlPath, renderPath };
}

function sshProfile(
  id: string,
  destination: string,
  remote: { controlPath: string; renderPath: string },
  autoConnect: boolean,
): SshConnectionProfile {
  return {
    id,
    label: id.toUpperCase(),
    type: "ssh",
    ssh_destination: destination,
    remote_control_socket_path: remote.controlPath,
    remote_client_socket_path: remote.renderPath,
    auto_connect: autoConnect,
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

async function waitUntil<T>(read: () => T | null): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await Bun.sleep(20);
  }
  throw new Error("condition not reached");
}

async function waitForHealth(port: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch {
      // The child may still be binding.
    }
    await Bun.sleep(25);
  }
  throw new Error("SSH profile process fixture did not become healthy");
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("production bridge supervises two independent SSH profile tunnels", async () => {
  if (process.platform === "win32") return;
  const root = join("/tmp", `herdr-gui-ssh-process-${crypto.randomUUID()}`);
  roots.push(root);
  const bin = join(root, "bin");
  const state = join(root, "state");
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const alphaRemote = await fakeHerdr(root, "ssh-alpha");
  const betaRemote = await fakeHerdr(root, "ssh-beta");
  const fakeHome = join(
    "/tmp",
    `hgui-legacy-${crypto.randomUUID().slice(0, 8)}`,
  );
  roots.push(fakeHome);
  const legacyConfig = join(fakeHome, ".config", "herdr");
  mkdirSync(legacyConfig, { recursive: true, mode: 0o700 });
  await fakeHerdr(root, "legacy-ssh", {
    controlPath: join(legacyConfig, "herdr.sock"),
    renderPath: join(legacyConfig, "herdr-client.sock"),
  });

  const fakeSshPath = join(bin, "ssh");
  writeFileSync(
    fakeSshPath,
    `#!/usr/bin/env bun
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { join } from "node:path";
const args = process.argv.slice(2);
const separator = args.lastIndexOf("--");
const destination = separator >= 0 ? args[separator + 1] : "unknown";
const stateDir = process.env.HERDR_GUI_FAKE_SSH_STATE_DIR;
if (!stateDir) process.exit(70);
mkdirSync(stateDir, { recursive: true });
if (!args.includes("-L") && (args.at(-1) || "").includes("printf %s")) {
  console.log(process.env.HERDR_GUI_FAKE_SSH_HOME || "");
  process.exit(0);
}
// Background upload cleanup is a one-shot SSH command, not a tunnel.
if (!args.includes("-L") && (args.at(-1) || "").includes("roamgate-uploads-")) {
  process.exit(0);
}
appendFileSync(join(stateDir, destination + ".attempts"), String(process.pid) + "\\n");
if (destination === "auth-fail") {
  console.error("Permission denied (publickey).");
  process.exit(255);
}
const forwards = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] !== "-L") continue;
  const spec = args[index + 1] || "";
  const colon = spec.indexOf(":");
  if (colon <= 0) process.exit(71);
  forwards.push({ local: spec.slice(0, colon), remote: spec.slice(colon + 1) });
}
const servers = [];
const connections = new Set();
for (const forward of forwards) {
  rmSync(forward.local, { force: true });
  const server = net.createServer((client) => {
    const upstream = net.createConnection(forward.remote);
    connections.add(client);
    connections.add(upstream);
    client.on("close", () => connections.delete(client));
    upstream.on("close", () => connections.delete(upstream));
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(forward.local, resolve);
  });
  servers.push(server);
}
writeFileSync(
  join(stateDir, destination + ".json"),
  JSON.stringify({ pid: process.pid, forwards }),
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const connection of connections) connection.destroy();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  for (const forward of forwards) rmSync(forward.local, { force: true });
  process.exit(0);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
`,
    { mode: 0o700 },
  );
  chmodSync(fakeSshPath, 0o700);

  const profiles = [
    sshProfile("ssh-alpha", "alpha-host", alphaRemote, true),
    sshProfile("ssh-beta", "beta-host", betaRemote, true),
    sshProfile("ssh-auth", "auth-fail", alphaRemote, false),
  ];
  const registryPath = join(root, "connections.json");
  writeFileSync(
    registryPath,
    JSON.stringify({
      version: 2,
      default_connection_id: "ssh-alpha",
      profiles,
    }),
    { mode: 0o600 },
  );
  const repositoryRoot = join(import.meta.dir, "../../..");
  const child = Bun.spawn(["bun", "server/src/index.ts"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOST: "127.0.0.1",
      ROAMGATE_PASSWORD: password,
      PORT: "0",
      HERDR_GUI_CONNECTIONS_PATH: registryPath,
      HERDR_GUI_FAKE_SSH_STATE_DIR: state,
      HERDR_GUI_FAKE_SSH_HOME: fakeHome,
      HERDR_SOCKET_PATH: undefined,
      HERDR_CLIENT_SOCKET_PATH: undefined,
      HERDR_SSH_HOST: "legacy-host",
      HERDR_SESSION: undefined,
    },
    stdout: "pipe",
    stderr: "ignore",
  });
  let ws: WebSocket | null = null;
  try {
    const port = await bridgeListeningPort(child.stdout);
    await waitForHealth(port);
    const cookie = await login(port);
    ws = new BrowserSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { cookie },
    });
    await new Promise<void>((resolve, reject) => {
      ws!.onopen = () => resolve();
      ws!.onerror = () => reject(new Error("websocket open failed"));
    });
    let sequence = 0;
    const pending = new Map<string, (message: any) => void>();
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id === "string") pending.get(message.id)?.(message);
    };
    const rawRpc = async (
      method: string,
      params: Record<string, unknown> = {},
      connectionId?: string,
      generation?: number,
    ) => {
      const id = `ssh${++sequence}`;
      let timer!: ReturnType<typeof setTimeout>;
      const reply = new Promise<any>((resolve, reject) => {
        pending.set(id, resolve);
        timer = setTimeout(
          () => reject(new Error(`RPC timeout: ${method}`)),
          5000,
        );
      });
      ws!.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(connectionId ? { connection_id: connectionId } : {}),
          ...(generation === undefined
            ? {}
            : { connection_generation: generation }),
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
      generation?: number,
    ) => {
      const message = await rawRpc(method, params, connectionId, generation);
      if (message.error) throw new Error(message.error.message);
      return message.result;
    };

    let catalog: any;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      catalog = await rpc("connections.list");
      const alpha = catalog.connections.find(
        (item: any) => item.id === "ssh-alpha",
      );
      const beta = catalog.connections.find(
        (item: any) => item.id === "ssh-beta",
      );
      const legacy = catalog.connections.find(
        (item: any) => item.id === "legacy-default",
      );
      if (
        alpha?.state === "ready" &&
        beta?.state === "ready" &&
        legacy?.state === "ready"
      )
        break;
      await Bun.sleep(20);
    }
    const alpha = catalog.connections.find(
      (item: any) => item.id === "ssh-alpha",
    );
    const beta = catalog.connections.find(
      (item: any) => item.id === "ssh-beta",
    );
    const legacy = catalog.connections.find(
      (item: any) => item.id === "legacy-default",
    );
    expect(alpha).toMatchObject({ state: "ready", type: "ssh" });
    expect(beta).toMatchObject({ state: "ready", type: "ssh" });
    expect(legacy).toMatchObject({ state: "ready", type: "local" });
    const alphaGeneration = alpha.generation as number;
    const betaGeneration = beta.generation as number;
    const legacyGeneration = legacy.generation as number;
    expect(
      (await rpc("workspace.list", {}, "ssh-alpha", alphaGeneration))
        .workspaces[0].name,
    ).toBe("from-ssh-alpha");
    expect(
      (await rpc("workspace.list", {}, "ssh-beta", betaGeneration))
        .workspaces[0].name,
    ).toBe("from-ssh-beta");
    expect(
      (await rpc("workspace.list", {}, "legacy-default", legacyGeneration))
        .workspaces[0].name,
    ).toBe("from-legacy-ssh");

    const alphaStatePath = join(state, "alpha-host.json");
    const betaStatePath = join(state, "beta-host.json");
    const firstAlphaState = JSON.parse(readFileSync(alphaStatePath, "utf8"));
    const firstBetaState = JSON.parse(readFileSync(betaStatePath, "utf8"));
    expect(firstAlphaState.pid).not.toBe(firstBetaState.pid);
    expect(firstAlphaState.forwards[0].local).not.toContain("ssh-alpha");
    expect(firstBetaState.forwards[0].local).not.toContain("beta-host");

    process.kill(firstAlphaState.pid, "SIGKILL");
    let sawReconnecting = false;
    let betaRoutedDuringReconnect = false;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      catalog = await rpc("connections.list");
      const nextAlpha = catalog.connections.find(
        (item: any) => item.id === "ssh-alpha",
      );
      const nextBeta = catalog.connections.find(
        (item: any) => item.id === "ssh-beta",
      );
      expect(nextBeta).toMatchObject({
        state: "ready",
        generation: betaGeneration,
      });
      if (nextAlpha?.state === "reconnecting") {
        sawReconnecting = true;
        if (!betaRoutedDuringReconnect) {
          const betaResult = await rpc(
            "workspace.list",
            {},
            "ssh-beta",
            betaGeneration,
          );
          expect(betaResult.workspaces[0].name).toBe("from-ssh-beta");
          betaRoutedDuringReconnect = true;
        }
      }
      if (
        sawReconnecting &&
        nextAlpha?.state === "ready" &&
        nextAlpha.generation !== alphaGeneration
      )
        break;
      await Bun.sleep(20);
    }
    expect(sawReconnecting).toBeTrue();
    expect(betaRoutedDuringReconnect).toBeTrue();
    expect(
      (await rpc("workspace.list", {}, "ssh-beta", betaGeneration))
        .workspaces[0].name,
    ).toBe("from-ssh-beta");
    const finalCatalog = await rpc("connections.list");
    const nextAlpha = finalCatalog.connections.find(
      (item: any) => item.id === "ssh-alpha",
    );
    expect(nextAlpha.state).toBe("ready");
    expect(nextAlpha.generation).not.toBe(alphaGeneration);
    expect(
      (await rpc("workspace.list", {}, "ssh-alpha", nextAlpha.generation))
        .workspaces[0].name,
    ).toBe("from-ssh-alpha");
    const secondAlphaState = JSON.parse(readFileSync(alphaStatePath, "utf8"));
    expect(secondAlphaState.pid).not.toBe(firstAlphaState.pid);
    expect(existsSync(firstAlphaState.forwards[0].local)).toBeFalse();
    expect(existsSync(firstAlphaState.forwards[1].local)).toBeFalse();

    await expect(
      rpc("connections.connect", { id: "ssh-auth" }),
    ).rejects.toThrow("authentication failed");
    await Bun.sleep(1200);
    const authAttempts = readFileSync(join(state, "auth-fail.attempts"), "utf8")
      .trim()
      .split("\n");
    expect(authAttempts).toHaveLength(1);
    expect(
      (await rpc("connections.list")).connections.find(
        (item: any) => item.id === "ssh-auth",
      ).state,
    ).toBe("error");

    const legacyState = JSON.parse(
      readFileSync(join(state, "legacy-host.json"), "utf8"),
    );
    process.kill(legacyState.pid, "SIGKILL");
    let legacyStatus: any;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      legacyStatus = (await rpc("connections.list")).connections.find(
        (item: any) => item.id === "legacy-default",
      );
      if (legacyStatus?.state === "error") break;
      await Bun.sleep(20);
    }
    expect(legacyStatus).toMatchObject({ state: "error" });
    expect(legacyStatus.generation).not.toBe(legacyGeneration);
    await Bun.sleep(1200);
    const legacyAttempts = readFileSync(
      join(state, "legacy-host.attempts"),
      "utf8",
    )
      .trim()
      .split("\n");
    expect(legacyAttempts).toHaveLength(1);

    const livePids = [
      secondAlphaState.pid as number,
      firstBetaState.pid as number,
    ];
    ws.close();
    ws = null;
    child.kill("SIGTERM");
    await child.exited;
    await waitUntil(() =>
      livePids.every((pid) => !processIsAlive(pid)) ? true : null,
    );
    expect(existsSync(secondAlphaState.forwards[0].local)).toBeFalse();
    expect(existsSync(firstBetaState.forwards[0].local)).toBeFalse();
  } finally {
    ws?.close();
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
  }
}, 40_000);

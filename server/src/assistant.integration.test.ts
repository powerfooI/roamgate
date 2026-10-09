import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BinReader, BinWriter, encodeFrame } from "./bridge/bincode";
import type { LocalConnectionProfile } from "./connections/profiles";

const PASSWORD = "assistant-integration-password";
const BrowserSocket = WebSocket as unknown as new (
  url: string,
  options: Bun.WebSocketOptions,
) => WebSocket;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "roamgate-assistant-"));
  const servers: net.Server[] = [];
  const sockets = new Set<net.Socket>();
  const browsers: WebSocket[] = [];
  const calls: string[] = [];
  function track(socket: net.Socket) {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && error.code !== "ECONNRESET") throw error;
    });
  }
  async function listen(server: net.Server, path: string) {
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
  }
  async function herdr(id: string): Promise<LocalConnectionProfile> {
    const control = join(root, `${id}.sock`);
    const render = join(root, `${id}-render.sock`);
    await listen(
      net.createServer((socket) => {
        track(socket);
        let input = "";
        socket.on("data", (chunk) => {
          input += chunk.toString();
          if (!input.includes("\n")) return;
          const request = JSON.parse(input.slice(0, input.indexOf("\n")));
          calls.push(request.method);
          if (id === "broken" && request.method === "workspace.list") {
            socket.end(
              `${JSON.stringify({ id: request.id, error: { code: "error", message: "api_key=PRIVATE_KEY /private/control.sock" } })}\n`,
            );
            return;
          }
          const result =
            request.method === "ping"
              ? { version: "integration", protocol: 14 }
              : request.method === "workspace.list"
                ? {
                    workspaces: [
                      {
                        workspace_id: "w1",
                        label: "Allowed workspace",
                        socket_path: "/private/control.sock",
                        api_key: "PRIVATE_KEY",
                      },
                    ],
                  }
                : request.method === "workspace.get"
                  ? {
                      workspace: {
                        workspace_id: "w1",
                        label: "Allowed workspace",
                        cwd: "/workspace/repo",
                      },
                    }
                  : request.method === "pane.list"
                    ? { panes: [] }
                    : request.method === "agent.list"
                      ? { agents: [] }
                      : {};
          socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
          if (request.method !== "events.subscribe") socket.end();
        });
      }),
      control,
    );
    await listen(
      net.createServer((socket) => {
        track(socket);
        let input = Buffer.alloc(0);
        let welcomed = false;
        socket.on("data", (chunk) => {
          if (welcomed) return;
          input = Buffer.concat([input, Buffer.from(chunk)]);
          if (input.length < 4) return;
          const length = input.readUInt32LE(0);
          if (input.length < length + 4) return;
          const reader = new BinReader(input.subarray(4, length + 4));
          if (reader.variant() !== 0)
            throw new Error("Expected terminal handshake");
          const writer = new BinWriter();
          writer.variant(0);
          writer.varint(reader.varint());
          writer.varint(1);
          writer.option<string>(undefined, (value) => writer.string(value));
          socket.write(encodeFrame(writer.toBuffer()));
          welcomed = true;
        });
      }),
      render,
    );
    return {
      id,
      label: id,
      type: "local",
      control_socket_path: control,
      client_socket_path: render,
      auto_connect: false,
    };
  }
  const profiles = await Promise.all([herdr("healthy"), herdr("broken")]);
  profiles.unshift({
    id: "offline",
    label: "offline",
    type: "local",
    control_socket_path: join(root, "missing.sock"),
    client_socket_path: join(root, "missing-render.sock"),
    auto_connect: false,
  });
  const registry = join(root, "connections.json");
  await writeFile(
    registry,
    JSON.stringify({ version: 1, default_connection_id: "offline", profiles }),
    { mode: 0o600 },
  );
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(ROAMGATE_|HERDR_|PI_)/.test(key) &&
        !/(API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN|SECRET|PASSWORD)$/.test(
          key,
        ),
    ),
  );
  const assistantDirectory = join(root, "ranger");
  await mkdir(assistantDirectory, { mode: 0o700 });
  await writeFile(
    join(assistantDirectory, "state.json"),
    JSON.stringify({
      config: {
        provider: "",
        model: "",
        credential_source: "assistant",
        allowed_workspaces: [],
      },
      messages: [
        {
          id: "saved-question",
          role: "user",
          text: "Saved Ranger question",
          sent_at: "2026-10-04T00:00:00Z",
          tools: [],
          sources: [],
        },
        {
          id: "saved-answer",
          role: "assistant",
          text: "Saved Ranger answer",
          sent_at: "2026-10-04T00:00:01Z",
          tools: [],
          sources: [],
        },
      ],
      entries: [],
      entry_scope: "",
      requests: [],
    }),
    { mode: 0o600 },
  );
  const child = Bun.spawn([process.execPath, "server/src/index.ts"], {
    cwd: join(import.meta.dir, "../.."),
    env: {
      ...environment,
      HOME: root,
      USERPROFILE: root,
      APPDATA: root,
      XDG_CONFIG_HOME: root,
      PI_CODING_AGENT_DIR: join(root, "pi"),
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: "0",
      OPEN_BROWSER: "0",
      ROAMGATE_CONNECTIONS_PATH: registry,
      ROAMGATE_PASSWORD: PASSWORD,
      ROAMGATE_ASSISTANT_DIR: assistantDirectory,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  const listening = Promise.withResolvers<string>();
  const output = (async () => {
    let text = "";
    for await (const chunk of child.stdout) {
      text += new TextDecoder().decode(chunk);
      const port = text.match(/\bINFO bridge listening\b[^\r\n]*:(\d+)\b/)?.[1];
      if (port) listening.resolve(`http://127.0.0.1:${port}`);
      if (text.length > 16_384) text = text.slice(-8192);
    }
    listening.reject(
      new Error(`Bridge exited before listening: ${text}\n${await stderr}`),
    );
  })();
  const timer = setTimeout(
    () =>
      listening.reject(
        new Error("Assistant integration bridge startup timed out"),
      ),
    10_000,
  );
  async function dispose() {
    clearTimeout(timer);
    for (const browser of browsers) browser.close();
    child.kill();
    await child.exited;
    await output;
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    await rm(root, { recursive: true, force: true });
  }
  try {
    const base = await listening.promise;
    clearTimeout(timer);
    return { base, browsers, calls, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function browser(base: string, cookie: string, browsers: WebSocket[]) {
  const socket = new BrowserSocket(`${base.replace("http:", "ws:")}/ws`, {
    headers: { cookie },
  });
  browsers.push(socket);
  const hello = Promise.withResolvers<any>();
  const pushes: any[] = [];
  const pending = new Map<string, (value: any) => void>();
  const pushWaiters = new Set<(value: any) => void>();
  socket.onmessage = (event) => {
    const value = JSON.parse(String(event.data));
    if (value.hello) hello.resolve(value);
    if (typeof value.id === "string") pending.get(value.id)?.(value);
    if (value.assistant) {
      pushes.push(value);
      for (const waiter of pushWaiters) waiter(value);
    }
  };
  socket.onerror = () =>
    hello.reject(new Error("Assistant browser connection failed"));
  const timer = setTimeout(
    () => hello.reject(new Error("WebSocket hello timed out")),
    5000,
  );
  const greeting = await hello.promise.finally(() => clearTimeout(timer));
  let sequence = 0;
  async function rpc(
    method: string,
    params: Record<string, unknown> = {},
    envelope: Record<string, unknown> = {},
  ) {
    const id = `assistant-${++sequence}`;
    const response = Promise.withResolvers<any>();
    pending.set(id, response.resolve);
    const deadline = setTimeout(
      () => response.reject(new Error(`Assistant RPC timed out: ${method}`)),
      5000,
    );
    socket.send(JSON.stringify({ id, method, params, ...envelope }));
    try {
      return await response.promise;
    } finally {
      clearTimeout(deadline);
      pending.delete(id);
    }
  }
  async function nextPush() {
    const response = Promise.withResolvers<any>();
    pushWaiters.add(response.resolve);
    const deadline = setTimeout(
      () => response.reject(new Error("Assistant push timed out")),
      5000,
    );
    try {
      return await response.promise;
    } finally {
      clearTimeout(deadline);
      pushWaiters.delete(response.resolve);
    }
  }
  return { hello: greeting, rpc, pushes, nextPush };
}

test("authenticated bridge-global assistant routes preserve global replies and pushes without a selected connection", async () => {
  if (process.platform === "win32") return; // Unix socket fixture, same boundary as profile-process tests.
  const f = await fixture();
  try {
    const request = (path: string, init?: RequestInit) =>
      fetch(`${f.base}${path}`, { ...init, signal: AbortSignal.timeout(5000) });
    expect((await request("/api/health")).status).toBe(401);
    expect((await request("/ws")).status).toBe(401);
    const unauthenticated = new WebSocket(
      `${f.base.replace("http:", "ws:")}/ws`,
    );
    f.browsers.push(unauthenticated);
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error("Unauthenticated WebSocket was not rejected")),
        5000,
      );
      unauthenticated.onopen = () => {
        clearTimeout(deadline);
        reject(new Error("Unauthenticated WebSocket opened"));
      };
      unauthenticated.onerror = () => {
        clearTimeout(deadline);
        resolve();
      };
    });
    const login = await request("/api/login", {
      method: "POST",
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
    const first = await browser(f.base, cookie, f.browsers);
    const second = await browser(f.base, cookie, f.browsers);
    expect(first.hello).toMatchObject({
      default_connection_id: "offline",
      capabilities: { embedded_assistant: true },
    });
    for (const id of ["healthy", "broken"]) {
      expect(
        (await first.rpc("connections.connect", { id })).result.state,
      ).toBe("ready");
    }
    const context = await first.rpc("bridge.assistant.context");
    expect(context.connection_id).toBeUndefined();
    expect(context.connection_generation).toBeUndefined();
    expect(context.result.workspaces).toEqual([
      {
        connection_id: "healthy",
        workspace_id: "w1",
        connection_label: "healthy",
        label: "Allowed workspace",
        runtime_generation: expect.any(Number),
      },
    ]);
    expect(context.result.errors).toEqual([
      "Connection offline is not ready",
      "Unable to list workspaces for connection broken",
    ]);
    expect(JSON.stringify(context.result)).not.toContain("PRIVATE_KEY");
    expect(JSON.stringify(context.result)).not.toContain(
      "/private/control.sock",
    );
    const forbidden = await first.rpc(
      "bridge.assistant.context",
      {},
      { connection_id: "healthy" },
    );
    expect(forbidden.error.message).toContain(
      "bridge-global method must not include connection identity",
    );
    const state = await first.rpc("bridge.assistant.get");
    expect(state.result).toMatchObject({
      running: false,
      config: { provider: "", model: "", allowed_workspaces: [] },
    });
    expect(
      state.result.providers.every(
        (entry: { configured: boolean }) => !entry.configured,
      ),
    ).toBe(true);
    expect(
      state.result.messages.map((message: { text: string }) => message.text),
    ).toEqual(["Saved Ranger question", "Saved Ranger answer"]);
    const savedSession = state.result.session_id;
    const pushA = first.nextPush();
    const pushB = second.nextPush();
    const reset = await first.rpc("bridge.assistant.new_session");
    const updates = await Promise.all([pushA, pushB]);
    for (const update of updates) {
      expect(Object.keys(update)).toEqual(["assistant"]);
      expect(update.assistant.instance_id).toBe(reset.result.instance_id);
      expect(update.assistant.revision).toBe(reset.result.revision);
    }
    expect(reset.result.messages).toEqual([]);
    expect(reset.result.sessions).toContainEqual(
      expect.objectContaining({
        id: savedSession,
        title: "Saved Ranger question",
        message_count: 2,
      }),
    );
    const restoreA = first.nextPush();
    const restoreB = second.nextPush();
    const restored = await second.rpc("bridge.assistant.select_session", {
      session_id: savedSession,
    });
    expect(restored.result.session_id).toBe(savedSession);
    expect(restored.result.messages).toEqual(state.result.messages);
    for (const update of await Promise.all([restoreA, restoreB])) {
      expect(update.assistant.session_id).toBe(savedSession);
      expect(update.assistant.messages).toEqual(state.result.messages);
    }
    const traversal = await first.rpc("bridge.assistant.select_session", {
      session_id: "../state",
    });
    expect(traversal.error).toBeDefined();
    expect((await first.rpc("bridge.assistant.get")).result.session_id).toBe(
      savedSession,
    );
    const rejected = await first.rpc("bridge.assistant.send", {
      text: "Inspect work",
      request_id: "unconfigured",
    });
    expect(rejected.error.message).toContain(
      "Choose an authorized workspace scope",
    );
    const forbiddenCalls = f.calls.filter((method) =>
      /^(pane\.(send|focus|run|resize|split|close)|workspace\.(create|focus|close)|terminal\.)/.test(
        method,
      ),
    );
    expect(forbiddenCalls).toEqual([]);
  } finally {
    await f.dispose();
  }
}, 25_000);

test("Ranger mention discovery is bridge-global, permission-bound and available before model setup", async () => {
  const f = await fixture();
  try {
    const login = await fetch(`${f.base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
      redirect: "manual",
    });
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
    const client = await browser(f.base, cookie, f.browsers);
    await client.rpc("connections.connect", { id: "healthy" });
    const scope = [{ connection_id: "healthy", workspace_id: "w1" }];
    const denied = await client.rpc("bridge.assistant.mentions", { scope });
    expect(denied.error.message).toContain("authorized");
    const configured = await client.rpc("bridge.assistant.configure", {
      provider: "",
      model: "",
      credential_source: "assistant",
      allowed_workspaces: scope,
    });
    expect(configured.error).toBeUndefined();
    const references = await client.rpc("bridge.assistant.mentions", { scope });
    expect(references.error).toBeUndefined();
    expect(references.connection_id).toBeUndefined();
    expect(references.result.targets).toEqual([
      {
        kind: "workspace",
        connection_id: "healthy",
        workspace_id: "w1",
        connection_label: "healthy",
        workspace_label: "Allowed workspace",
        label: "Allowed workspace",
        runtime_generation: expect.any(Number),
      },
    ]);
    expect(JSON.stringify(references.result)).not.toContain("PRIVATE_KEY");
    expect(JSON.stringify(references.result)).not.toContain(
      "/private/control.sock",
    );
    const wrapped = await client.rpc(
      "bridge.assistant.mentions",
      { scope },
      { connection_id: "healthy" },
    );
    expect(wrapped.error.message).toContain(
      "bridge-global method must not include connection identity",
    );
    const wrong = await client.rpc("bridge.assistant.mentions", {
      scope: [{ connection_id: "healthy", workspace_id: "private" }],
    });
    expect(wrong.error.message).toContain("authorized");
  } finally {
    await f.dispose();
  }
}, 20_000);

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AssistantSnapshot,
  AssistantTaskDetail,
  AssistantTaskInput,
  AssistantTaskNotification,
} from "../../shared/assistant";
import { BinReader, BinWriter, encodeFrame } from "./bridge/bincode";
import type { LocalConnectionProfile } from "./connections/profiles";

const PASSWORD = "assistant-recovery-password";
const PARTIAL = "This interrupted answer must not be kept.";
const ANSWER = "Recovered the workspace status without repeating the read.";
const BrowserSocket = WebSocket as unknown as new (
  url: string,
  options: Bun.WebSocketOptions,
) => WebSocket;

function events(values: Record<string, unknown>[]) {
  return values
    .map((value) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)
    .join("");
}

function start(index: number) {
  return {
    type: "message_start",
    message: {
      id: `recovery-message-${index}`,
      type: "message",
      role: "assistant",
      model: "test-model",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  };
}

function text(value: string) {
  return [
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: value },
    },
  ];
}

function finish(reason: string) {
  return [
    {
      type: "message_delta",
      delta: { stop_reason: reason, stop_sequence: null },
      usage: { output_tokens: 10 },
    },
    { type: "message_stop" },
  ];
}

function tool(name: string, id: string, input: object, index: number) {
  return [
    {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id, name, input: {} },
    },
    {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    },
    { type: "content_block_stop", index },
  ];
}

async function fixture(
  options: {
    interrupt?: boolean;
    propose?: boolean;
    notifications?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "roamgate-recovery-"));
  const assistantDirectory = join(root, "ranger");
  await mkdir(assistantDirectory, { mode: 0o700 });
  await writeFile(
    join(assistantDirectory, "auth.json"),
    JSON.stringify({
      anthropic: { type: "api_key", key: "synthetic-recovery-key" },
    }),
    { mode: 0o600 },
  );
  const servers: net.Server[] = [];
  const sockets = new Set<net.Socket>();
  const browsers: WebSocket[] = [];
  const stopBridges: (() => Promise<void>)[] = [];
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const requests: {
    messages: { role: string; content: unknown }[];
    tools?: { name: string }[];
  }[] = [];
  const requestWaiters = new Set<() => void>();
  const continued = Promise.withResolvers<void>();
  const model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push((await request.json()) as (typeof requests)[number]);
      const index = requests.length;
      for (const waiter of requestWaiters) waiter();
      if (index === 2 && options.interrupt !== false) {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  events([start(index), ...text(PARTIAL)]),
                ),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (index === 3) continued.resolve();
      const notificationIndex = index - 2;
      const response =
        options.notifications && index <= 2
          ? [
              start(index),
              ...(index === 1
                ? [
                    ...tool(
                      "propose_ranger_task",
                      "monitor-task-proposal",
                      {
                        title: "Monitor Agent",
                        prompt:
                          "Inspect the authorized Agent. Notify when verification finishes or the Agent needs input, and stay quiet for an unchanged outcome.",
                        scope: [
                          { connection_id: "healthy", workspace_id: "w1" },
                        ],
                        schedule: {
                          type: "once",
                          at: new Date(Date.now() + 1500).toISOString(),
                        },
                        notification_mode: "agent",
                      },
                      0,
                    ),
                    ...finish("tool_use"),
                  ]
                : [
                    ...text("Confirm the task to enable the Agent check."),
                    { type: "content_block_stop", index: 0 },
                    ...finish("end_turn"),
                  ]),
            ]
          : options.notifications
            ? [
                start(index),
                ...(notificationIndex % 3 === 1
                  ? [
                      ...tool("workspace_status", `status-${index}`, {}, 0),
                      ...finish("tool_use"),
                    ]
                  : notificationIndex % 3 === 2
                    ? [
                        ...tool(
                          "send_user_notification",
                          `notify-${index}`,
                          {
                            event_key:
                              notificationIndex < 7
                                ? "agent-turn-7-completed"
                                : "agent-turn-8-needs-input",
                            kind:
                              notificationIndex < 7 ? "completed" : "attention",
                            title:
                              notificationIndex < 7
                                ? "Agent verification passed"
                                : "Agent needs a decision",
                            body:
                              notificationIndex < 7
                                ? "The Agent's verification finished. Review the result in Ranger."
                                : "The Agent cannot continue until you choose an option.",
                          },
                          0,
                        ),
                        ...finish("tool_use"),
                      ]
                    : [
                        ...text(
                          "Inspected Agent status and notification receipt.",
                        ),
                        { type: "content_block_stop", index: 0 },
                        ...finish("end_turn"),
                      ]),
              ]
            : index === 1
              ? [
                  start(index),
                  ...tool("workspace_status", "completed-status", {}, 0),
                  ...(options.propose === false
                    ? []
                    : tool(
                        "propose_tab_create",
                        "pending-tab",
                        { connection_id: "healthy", workspace_id: "w1" },
                        1,
                      )),
                  ...finish("tool_use"),
                ]
              : [
                  start(index),
                  ...text(ANSWER),
                  { type: "content_block_stop", index: 0 },
                  ...finish("end_turn"),
                ];
      return new Response(events(response), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
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
  const control = join(root, "control.sock");
  const render = join(root, "render.sock");
  const workspace = {
    workspace_id: "w1",
    label: "Recovery workspace",
    cwd: join(root, "workspace"),
    agent_status: "running",
    pane_count: 0,
    tab_count: 0,
  };
  await listen(
    net.createServer((socket) => {
      track(socket);
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk.toString();
        if (!input.includes("\n")) return;
        const request = JSON.parse(input.slice(0, input.indexOf("\n")));
        calls.push({ method: request.method, params: request.params });
        const result =
          request.method === "ping"
            ? { version: "recovery-test", protocol: 22 }
            : request.method === "workspace.list"
              ? { workspaces: [workspace] }
              : request.method === "workspace.get"
                ? { workspace }
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
        const variant = reader.variant();
        const send = (kind: string, data: object) => {
          const writer = new BinWriter();
          writer.variant(20);
          writer.string(kind);
          writer.string(JSON.stringify(data));
          socket.write(encodeFrame(writer.toBuffer()));
        };
        if (variant === 20) {
          expect(reader.string()).toBe("endpoint.hello.v1");
          send("endpoint.welcome.v1", {
            generation: 1,
            server_version: "recovery-test",
            snapshot_codec: "shell.snapshot.v1",
            surface_codec: "shell.surface.v1",
            input_codec: "shell.input.semantic.v1",
            blob_codec: "shell.blob.v1",
            methods: [],
            capabilities: [],
          });
          send("shell.snapshot.v1", {
            boot_id: "same-herdr-boot",
            revision: 1,
          });
        } else {
          expect(variant).toBe(0);
          const writer = new BinWriter();
          writer.variant(0);
          writer.varint(reader.varint());
          writer.varint(1);
          writer.option<string>(undefined, (value) => writer.string(value));
          socket.write(encodeFrame(writer.toBuffer()));
        }
        welcomed = true;
      });
    }),
    render,
  );
  const profile: LocalConnectionProfile = {
    id: "healthy",
    label: "Healthy",
    type: "local",
    control_socket_path: control,
    client_socket_path: render,
    auto_connect: true,
  };
  const registry = join(root, "connections.json");
  await writeFile(
    registry,
    JSON.stringify({
      version: 1,
      default_connection_id: profile.id,
      profiles: [profile],
    }),
    { mode: 0o600 },
  );
  // Keep the real SDK and bridge startup. Redirect only the model transport,
  // and reject external fetches rather than exposing a production test hook.
  const preload = join(root, "model-transport.ts");
  await writeFile(
    preload,
    `
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.hostname !== "api.anthropic.com") throw new Error("Unexpected external fetch in recovery fixture");
  const target = new URL(url.pathname + url.search, ${JSON.stringify(model.url.href)});
  return nativeFetch(new Request(target, request));
};
`,
  );
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        key !== "BUN_OPTIONS" &&
        key !== "NODE_OPTIONS" &&
        !/^(ROAMGATE_|HERDR_|PI_)/.test(key) &&
        !/(API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN|SECRET|PASSWORD)$/.test(
          key,
        ),
    ),
  );
  async function startBridge() {
    const binary = process.env.ROAMGATE_RECOVERY_TEST_BINARY;
    const child = Bun.spawn(
      binary ? [binary] : [process.execPath, "server/src/index.ts"],
      {
        cwd: join(import.meta.dir, "../.."),
        env: {
          ...environment,
          BUN_OPTIONS: `--preload ${pathToFileURL(preload).href}`,
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
      },
    );
    const stderr = new Response(child.stderr).text();
    const listening = Promise.withResolvers<string>();
    const output = (async () => {
      let text = "";
      for await (const chunk of child.stdout) {
        text += new TextDecoder().decode(chunk);
        const port = text.match(
          /\bINFO bridge listening\b[^\r\n]*:(\d+)\b/,
        )?.[1];
        if (port) listening.resolve(`http://127.0.0.1:${port}`);
        if (text.length > 16_384) text = text.slice(-8192);
      }
      await stderr;
      listening.reject(new Error("Recovery bridge exited before listening"));
    })();
    const kill = async (signal: NodeJS.Signals = "SIGKILL") => {
      child.kill(signal);
      await child.exited;
      await output;
    };
    stopBridges.push(kill);
    const deadline = setTimeout(
      () => listening.reject(new Error("Recovery bridge startup timed out")),
      10_000,
    );
    try {
      return { base: await listening.promise, kill };
    } finally {
      clearTimeout(deadline);
    }
  }
  async function saved(
    predicate: (state: any) => boolean,
    filename = "state.json",
  ) {
    const path = join(assistantDirectory, filename);
    const result = Promise.withResolvers<any>();
    const check = async () => {
      try {
        let state;
        if (filename === "tasks.sqlite") {
          const database = new Database(path, { readonly: true });
          try {
            state = database.transaction(() => ({
              tasks: database
                .query<{ id: string; status: string }, []>(
                  "SELECT id, status FROM tasks",
                )
                .all()
                .map((task) => ({
                  task,
                  runs: database
                    .query<{ id: string; status: string }, [string]>(
                      "SELECT id, status FROM runs WHERE task_id = ?",
                    )
                    .all(task.id),
                })),
            }))();
          } finally {
            database.close();
          }
        } else state = JSON.parse(await readFile(path, "utf8"));
        if (predicate(state)) result.resolve(state);
      } catch (error) {
        result.reject(error);
      }
    };
    // SQLite commit visibility can change without a directory event.
    const watcher =
      filename === "tasks.sqlite"
        ? undefined
        : watch(dirname(path), () => void check());
    const poll =
      filename === "tasks.sqlite"
        ? setInterval(() => void check(), 25)
        : undefined;
    const deadline = setTimeout(
      () => result.reject(new Error("Recovered Ranger state was not saved")),
      10_000,
    );
    void check();
    try {
      return await result.promise;
    } finally {
      watcher?.close();
      clearInterval(poll);
      clearTimeout(deadline);
    }
  }
  async function untilRequests(count: number) {
    if (requests.length >= count) return;
    const next = Promise.withResolvers<void>();
    const listener = () => {
      if (requests.length >= count) next.resolve();
    };
    requestWaiters.add(listener);
    const timeout = setTimeout(
      () => next.reject(new Error(`Model request ${count} did not arrive`)),
      25_000,
    );
    try {
      await next.promise;
    } finally {
      clearTimeout(timeout);
      requestWaiters.delete(listener);
    }
  }
  async function dispose() {
    for (const browser of browsers) browser.close();
    await Promise.all(stopBridges.map((stop) => stop()));
    model.stop(true);
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    await rm(root, { recursive: true, force: true });
  }
  return {
    startBridge,
    assistantDirectory,
    browsers,
    calls,
    requests,
    untilRequests,
    continued,
    saved,
    dispose,
  };
}

async function browser(base: string, browsers: WebSocket[]) {
  const login = await fetch(`${base}/api/login`, {
    method: "POST",
    body: JSON.stringify({ password: PASSWORD }),
    signal: AbortSignal.timeout(5000),
  });
  expect(login.status).toBe(200);
  const socket = new BrowserSocket(`${base.replace("http:", "ws:")}/ws`, {
    headers: { cookie: login.headers.get("set-cookie")!.split(";", 1)[0]! },
  });
  browsers.push(socket);
  const hello = Promise.withResolvers<void>();
  const pending = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<any>>
  >();
  const pushes: AssistantSnapshot[] = [];
  const notifications: AssistantTaskNotification[] = [];
  const waiters = new Set<(snapshot: AssistantSnapshot) => void>();
  socket.onmessage = (event) => {
    const value = JSON.parse(String(event.data));
    if (value.hello) hello.resolve();
    if (value.assistant_notification)
      notifications.push(value.assistant_notification);
    if (typeof value.id === "string") pending.get(value.id)?.resolve(value);
    if (value.assistant) {
      pushes.push(value.assistant);
      for (const waiter of waiters) waiter(value.assistant);
    }
  };
  socket.onerror = () =>
    hello.reject(new Error("Recovery browser connection failed"));
  const deadline = setTimeout(
    () => hello.reject(new Error("Recovery WebSocket hello timed out")),
    5000,
  );
  await hello.promise.finally(() => clearTimeout(deadline));
  let sequence = 0;
  async function rpc(method: string, params: Record<string, unknown> = {}) {
    const id = `recovery-${++sequence}`;
    const response = Promise.withResolvers<any>();
    pending.set(id, response);
    const timeout = setTimeout(
      () => response.reject(new Error(`Recovery RPC timed out: ${method}`)),
      5000,
    );
    socket.send(JSON.stringify({ id, method, params }));
    try {
      const value = await response.promise;
      if (value.error) throw new Error(JSON.stringify(value.error));
      return value.result;
    } finally {
      pending.delete(id);
      clearTimeout(timeout);
    }
  }
  async function until(predicate: (snapshot: AssistantSnapshot) => boolean) {
    const existing = pushes.findLast(predicate);
    if (existing) return existing;
    const next = Promise.withResolvers<AssistantSnapshot>();
    const listener = (snapshot: AssistantSnapshot) => {
      if (predicate(snapshot)) next.resolve(snapshot);
    };
    waiters.add(listener);
    const timeout = setTimeout(
      () =>
        next.reject(
          new Error("Ranger did not publish the recovery checkpoint"),
        ),
      10_000,
    );
    try {
      return await next.promise;
    } finally {
      waiters.delete(listener);
      clearTimeout(timeout);
    }
  }
  return { rpc, until, notifications, close: () => socket.close() };
}

async function configureRanger(client: Awaited<ReturnType<typeof browser>>) {
  expect(
    (await client.rpc("connections.connect", { id: "healthy" })).state,
  ).toBe("ready");
  const initial: AssistantSnapshot = await client.rpc("bridge.assistant.get");
  const model = initial.models.find((entry) => entry.provider === "anthropic");
  expect(model).toBeDefined();
  await client.rpc("bridge.assistant.configure", {
    config: {
      provider: "anthropic",
      model: model!.id,
      credential_source: "assistant",
      allowed_workspaces: [{ connection_id: "healthy", workspace_id: "w1" }],
    },
  });
}

async function createTask(
  client: Awaited<ReturnType<typeof browser>>,
  title: string,
  schedule: AssistantTaskInput["schedule"],
) {
  const snapshot: AssistantSnapshot = await client.rpc(
    "bridge.assistant.task.create",
    {
      request_id: randomUUID(),
      title,
      prompt: "Inspect the authorized workspace status.",
      scope: [{ connection_id: "healthy", workspace_id: "w1" }],
      schedule,
    },
  );
  expect(snapshot.messages).toEqual([]);
  const task = snapshot.tasks?.find((task) => task.title === title);
  expect(task).toBeDefined();
  return task!;
}

test("confirmed Ranger proposals schedule custom notifications and deduplicate polling across bridge restart", async () => {
  if (process.platform === "win32") return;
  const f = await fixture({
    interrupt: false,
    notifications: true,
  });
  try {
    const first = await f.startBridge();
    const client = await browser(first.base, f.browsers);
    await configureRanger(client);
    await client.rpc("bridge.assistant.send", {
      text: "Check the Agent shortly. Notify me when verification finishes or the Agent needs input, and stay quiet for an unchanged outcome.",
      request_id: "propose-agent-monitor",
    });
    const proposed = await client.until(
      (snapshot) =>
        !snapshot.running &&
        snapshot.messages.some((message) =>
          message.task_proposals?.some(
            (proposal) => proposal.status === "pending",
          ),
        ),
    );
    const proposal = proposed.messages.flatMap(
      (message) => message.task_proposals ?? [],
    )[0]!;
    expect(proposed.error).toBeNull();
    expect(proposed.tasks).toEqual([]);
    expect(client.notifications).toEqual([]);
    expect(proposal.notification_mode).toBe("agent");
    expect(proposal.scope).toEqual([
      { connection_id: "healthy", workspace_id: "w1" },
    ]);
    expect(proposal.schedule.type).toBe("once");
    expect(f.requests).toHaveLength(2);
    expect(
      f.requests[0]!.tools?.some((tool) => tool.name === "propose_ranger_task"),
    ).toBe(true);
    expect(
      f.requests[0]!.tools?.some(
        (tool) => tool.name === "send_user_notification",
      ),
    ).toBe(false);
    const confirmed: AssistantSnapshot = await client.rpc(
      "bridge.assistant.task.confirm_proposal",
      { proposal_id: proposal.id },
    );
    const task = confirmed.tasks![0]!;
    expect(task).toMatchObject({
      title: proposal.title,
      prompt: proposal.prompt,
      scope: proposal.scope,
      schedule: proposal.schedule,
      notification_mode: "agent",
      status: "active",
    });
    expect(
      confirmed.messages.flatMap((message) => message.task_proposals ?? []),
    ).toContainEqual({
      ...proposal,
      status: "confirmed",
      task_id: task.id,
    });
    // The confirmed deadline starts the first read; no manual run RPC is sent.
    const completed = await client.until(
      (snapshot) =>
        snapshot.tasks?.some(
          (item) =>
            item.id === task.id && item.last_run?.status === "succeeded",
        ) === true,
    );
    const runId = completed.tasks!.find((item) => item.id === task.id)!
      .last_run!.id;
    expect(client.notifications).toEqual([
      {
        task_id: task.id,
        run_id: runId,
        status: "succeeded",
        title: "Agent verification passed",
        body: "The Agent's verification finished. Review the result in Ranger.",
      },
    ]);
    const detail: AssistantTaskDetail = await client.rpc(
      "bridge.assistant.task.get",
      {
        task_id: task.id,
        run_id: runId,
      },
    );
    expect(task.next_run_at).not.toBeNull();
    expect(detail.run?.scheduled_at).toBe(task.next_run_at!);
    const answer = detail.run!.messages.find(
      (message) => message.role === "assistant",
    )!;
    expect(answer.tools.map((tool) => tool.name)).toEqual([
      "workspace_status",
      "send_user_notification",
    ]);
    expect(answer.sources).toHaveLength(1);
    expect(answer.sources[0]).toMatchObject({
      kind: "status",
      connection_id: "healthy",
      workspace_id: "w1",
    });
    expect(
      f.requests[2]!.tools?.some(
        (tool) => tool.name === "send_user_notification",
      ),
    ).toBe(true);
    const receipt = f.requests[4]!.messages.flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    ).find(
      (block) =>
        block.type === "tool_result" && block.tool_use_id === "notify-4",
    );
    expect(JSON.parse(receipt.content)).toEqual({
      accepted: true,
      delivery: "best_effort",
    });
    await first.kill("SIGTERM");
    const second = await f.startBridge();
    const restored = await browser(second.base, f.browsers);
    const saved: AssistantSnapshot = await restored.rpc("bridge.assistant.get");
    expect(
      saved.tasks!.find((item) => item.id === task.id)!.notification_mode,
    ).toBe("agent");
    expect(restored.notifications).toEqual([]);
    await restored.rpc("bridge.assistant.task.run_now", { task_id: task.id });
    const duplicate = await restored.until(
      (snapshot) =>
        snapshot.tasks?.some(
          (item) =>
            item.id === task.id &&
            item.last_run?.status === "succeeded" &&
            item.last_run.id !== runId,
        ) === true,
    );
    const duplicateId = duplicate.tasks!.find((item) => item.id === task.id)!
      .last_run!.id;
    expect(restored.notifications).toEqual([]);
    expect(JSON.stringify(f.requests[5]!.messages)).toContain(
      "agent-turn-7-completed",
    );
    expect(JSON.stringify(f.requests[7]!.messages)).toContain(
      "already_notified",
    );
    await restored.rpc("bridge.assistant.task.run_now", { task_id: task.id });
    const changed = await restored.until(
      (snapshot) =>
        snapshot.tasks?.some(
          (item) =>
            item.id === task.id &&
            item.last_run?.status === "succeeded" &&
            item.last_run.id !== runId &&
            item.last_run.id !== duplicateId,
        ) === true,
    );
    expect(restored.notifications).toEqual([
      {
        task_id: task.id,
        run_id: changed.tasks!.find((item) => item.id === task.id)!.last_run!
          .id,
        status: "waiting",
        title: "Agent needs a decision",
        body: "The Agent cannot continue until you choose an option.",
      },
    ]);
    expect(f.requests).toHaveLength(11);
    expect(
      f.calls.filter(
        (call) =>
          call.method === "pane.list" && call.params?.workspace_id === "w1",
      ),
    ).toHaveLength(3);
  } finally {
    await f.dispose();
  }
}, 60_000);

test.each(["SIGKILL", "SIGTERM"] as const)(
  "Ranger automatically resumes after %s without replaying completed reads or pending actions",
  async (signal) => {
    if (process.platform === "win32") return; // Unix socket fixture, like profile-process tests.
    const f = await fixture();
    try {
      const first = await f.startBridge();
      const client = await browser(first.base, f.browsers);
      await configureRanger(client);
      await client.rpc("bridge.assistant.send", {
        text: "Inspect workspace and propose a tab",
        request_id: "crash-question",
      });
      const interrupted = await client.until(
        (snapshot) =>
          snapshot.running &&
          snapshot.messages.some(
            (message) =>
              message.role === "assistant" && message.text.includes(PARTIAL),
          ),
      );
      const draft = interrupted.messages.find(
        (message) => message.role === "assistant",
      )!;
      expect(draft.tools).toContainEqual({
        id: "completed-status",
        name: "workspace_status",
        status: "completed",
        arguments: "{}",
        output: expect.any(String),
      });
      expect(draft.sources).toHaveLength(1);
      expect(draft.sources[0]).toMatchObject({
        kind: "status",
        connection_id: "healthy",
        workspace_id: "w1",
        read_at: expect.any(String),
      });
      expect(draft.actions).toHaveLength(1);
      expect(draft.actions![0]!.status).toBe("pending");
      const checkpoint = await f.saved(
        (saved) =>
          !!saved.active_run &&
          saved.entries.some(
            (entry: { type?: string }) => entry.type === "ranger-durable",
          ),
      );
      expect(checkpoint.active_run.recovery_targets).toHaveLength(1);
      expect(checkpoint.active_run.recovery_targets[0].herdr_boot_id).toBe(
        "same-herdr-boot",
      );
      const statusReads = () =>
        f.calls.filter(
          (call) =>
            call.method === "pane.list" && call.params?.workspace_id === "w1",
        );
      const reads = statusReads().length;
      expect(reads).toBe(1);
      await first.kill(signal);
      // No browser, get or send call participates in resuming the saved run.
      const second = await f.startBridge();
      const deadline = setTimeout(
        () =>
          f.continued.reject(
            new Error("Bridge startup did not resume the model automatically"),
          ),
        25_000,
      );
      await f.continued.promise.finally(() => clearTimeout(deadline));
      const completed = await f.saved(
        (saved) =>
          !saved.active_run &&
          saved.messages.some((message: { text: string }) =>
            message.text.includes(ANSWER),
          ),
      );
      expect(
        completed.messages.filter(
          (message: { role: string }) => message.role === "user",
        ),
      ).toHaveLength(1);
      const restoredClient = await browser(second.base, f.browsers);
      const restored: AssistantSnapshot = await restoredClient.rpc(
        "bridge.assistant.get",
      );
      expect(restored.running).toBe(false);
      expect(restored.error).toBeNull();
      expect(restored.session_id).toBe(interrupted.session_id);
      expect(restored.messages).toHaveLength(2);
      const answer = restored.messages.find(
        (message) => message.id === draft.id,
      )!;
      expect(answer.text).toContain(ANSWER);
      expect(answer.text).not.toContain(PARTIAL);
      expect(answer.sources).toEqual(draft.sources);
      expect(
        answer.tools.filter((tool) => tool.name === "workspace_status"),
      ).toEqual(draft.tools.filter((tool) => tool.name === "workspace_status"));
      expect(answer.actions).toHaveLength(1);
      expect(answer.actions![0]).toMatchObject({
        id: draft.actions![0]!.id,
        status: "cancelled",
      });
      expect(f.requests).toHaveLength(3);
      const toolResults = (request: (typeof f.requests)[number]) =>
        request.messages
          .flatMap((message) =>
            Array.isArray(message.content) ? message.content : [],
          )
          .filter(
            (block) =>
              block.type === "tool_result" &&
              block.tool_use_id === "completed-status",
          );
      expect(toolResults(f.requests[2]!)).toEqual(toolResults(f.requests[1]!));
      expect(toolResults(f.requests[2]!)).toHaveLength(1);
      expect(JSON.stringify(f.requests[2]!.messages)).toContain(
        draft.sources[0]!.id,
      );
      expect(JSON.stringify(f.requests[2]!.messages)).not.toContain(PARTIAL);
      expect(statusReads()).toHaveLength(reads);
      expect(
        f.calls.filter((call) =>
          /^(tab\.create|pane\.(send|focus|run|resize|split|close)|workspace\.(create|focus|close)|terminal\.)/.test(
            call.method,
          ),
        ),
      ).toEqual([]);
    } finally {
      await f.dispose();
    }
  },
  60_000,
);

test("a scheduled question starts without a browser and resumes its independent run after SIGKILL", async () => {
  if (process.platform === "win32") return;
  const f = await fixture({ propose: false });
  try {
    const first = await f.startBridge();
    const client = await browser(first.base, f.browsers);
    await configureRanger(client);
    const task = await createTask(client, "Automatic status check", {
      type: "once",
      at: new Date(Date.now() + 500).toISOString(),
    });
    client.close();
    // Only the scheduler can start this request: there is no browser or send RPC.
    await f.untilRequests(2);
    const checkpoint = await f.saved(
      (saved) =>
        saved.tasks.some(
          (entry: any) =>
            entry.task.id === task.id && entry.runs[0]?.status === "running",
        ),
      "tasks.sqlite",
    );
    const run = checkpoint.tasks.find((entry: any) => entry.task.id === task.id)
      .runs[0];
    const childPath = join("tasks", task.id, "runs", run.id, "state.json");
    const admitted = await f.saved(
      (saved) =>
        !!saved.active_run && saved.entries[0]?.type === "ranger-durable",
      childPath,
    );
    expect(admitted.active_run.recovery_targets[0].herdr_boot_id).toBe(
      "same-herdr-boot",
    );
    const statusReads = () =>
      f.calls.filter(
        (call) =>
          call.method === "pane.list" && call.params?.workspace_id === "w1",
      );
    expect(statusReads()).toHaveLength(1);
    expect(JSON.stringify(f.requests[1]!.messages)).toContain(
      "completed-status",
    );
    await first.kill("SIGKILL");

    const second = await f.startBridge();
    await f.untilRequests(3);
    await f.saved(
      (saved) =>
        saved.tasks.some(
          (entry: any) =>
            entry.task.id === task.id && entry.runs[0]?.status === "succeeded",
        ),
      "tasks.sqlite",
    );
    const restored = await browser(second.base, f.browsers);
    const detail: AssistantTaskDetail = await restored.rpc(
      "bridge.assistant.task.get",
      {
        task_id: task.id,
        run_id: run.id,
      },
    );
    expect(detail.runs).toHaveLength(1);
    expect(detail.run?.status).toBe("succeeded");
    expect(detail.task.next_run_at).toBeNull();
    expect(
      detail.run?.messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);
    const answer = detail.run!.messages.find(
      (message) => message.role === "assistant",
    )!;
    expect(answer.text).toContain(ANSWER);
    expect(answer.text).not.toContain(PARTIAL);
    expect(answer.sources).toHaveLength(1);
    expect(answer.tools).toContainEqual({
      id: "completed-status",
      name: "workspace_status",
      status: "completed",
      arguments: "{}",
      output: expect.any(String),
    });
    expect(statusReads()).toHaveLength(1);
    expect(f.requests).toHaveLength(3);
    expect(JSON.stringify(f.requests[2]!.messages)).toContain(
      answer.sources[0]!.id,
    );
    const main: AssistantSnapshot = await restored.rpc("bridge.assistant.get");
    expect(main.messages).toEqual([]);
    expect(main.running).toBe(false);
  } finally {
    await f.dispose();
  }
}, 60_000);

test("task RPCs manage paused manual runs and preserve cancellation across restart", async () => {
  if (process.platform === "win32") return;
  const f = await fixture({ interrupt: false, propose: false });
  try {
    const first = await f.startBridge();
    const client = await browser(first.base, f.browsers);
    await configureRanger(client);
    const interval = await createTask(client, "Manual interval check", {
      type: "interval",
      minutes: 1,
    });
    const control = async (method: string, taskId = interval.id) => {
      const snapshot: AssistantSnapshot = await client.rpc(
        `bridge.assistant.task.${method}`,
        {
          task_id: taskId,
        },
      );
      expect(snapshot.messages).toEqual([]);
      return snapshot.tasks!.find((task) => task.id === taskId)!;
    };
    expect((await control("pause")).status).toBe("paused");
    expect(f.requests).toHaveLength(0);
    await control("run_now");
    const completed = await client.until(
      (snapshot) =>
        snapshot.tasks?.some(
          (task) =>
            task.id === interval.id && task.last_run?.status === "succeeded",
        ) === true,
    );
    const finishedTask = completed.tasks!.find(
      (task) => task.id === interval.id,
    )!;
    expect(finishedTask.status).toBe("paused");
    expect(client.notifications).toEqual([
      {
        task_id: interval.id,
        run_id: finishedTask.last_run!.id,
        status: "succeeded",
        title: "Ranger task completed",
        body: "Manual interval check: completed successfully.",
      },
    ]);
    const detail: AssistantTaskDetail = await client.rpc(
      "bridge.assistant.task.get",
      {
        task_id: interval.id,
        run_id: finishedTask.last_run!.id,
      },
    );
    expect(detail.runs).toHaveLength(1);
    expect(
      detail.run?.messages.some((message) => message.text.includes(ANSWER)),
    ).toBe(true);
    expect(
      detail.run?.messages.find((message) => message.role === "assistant")
        ?.sources,
    ).toHaveLength(1);
    expect((await control("resume")).status).toBe("active");
    expect((await control("pause")).status).toBe("paused");
    expect((await control("cancel")).status).toBe("cancelled");
    await expect(control("run_now")).rejects.toThrow("cancelled");

    const at = new Date(Date.now() + 2000).toISOString();
    const cancelled = await createTask(client, "Cancelled before deadline", {
      type: "once",
      at,
    });
    expect((await control("cancel", cancelled.id)).status).toBe("cancelled");
    const sentinel = await createTask(client, "Restart deadline sentinel", {
      type: "once",
      at,
    });
    await first.kill("SIGTERM");
    const second = await f.startBridge();
    // A successful task at the same deadline proves scheduling progressed after
    // restart without sleeping or assuming cancellation merely delays execution.
    await f.untilRequests(3);
    await f.saved(
      (saved) =>
        saved.tasks.some(
          (entry: any) =>
            entry.task.id === sentinel.id &&
            entry.runs[0]?.status === "succeeded",
        ),
      "tasks.sqlite",
    );
    const restored = await browser(second.base, f.browsers);
    const cancelledDetail: AssistantTaskDetail = await restored.rpc(
      "bridge.assistant.task.get",
      { task_id: cancelled.id },
    );
    expect(cancelledDetail.task.status).toBe("cancelled");
    expect(cancelledDetail.task.next_run_at).toBeNull();
    expect(cancelledDetail.runs).toEqual([]);
    const pausedDetail: AssistantTaskDetail = await restored.rpc(
      "bridge.assistant.task.get",
      { task_id: interval.id },
    );
    expect(pausedDetail.task.status).toBe("cancelled");
    expect(pausedDetail.runs).toHaveLength(1);
    expect(f.requests).toHaveLength(3);
    expect((await restored.rpc("bridge.assistant.get")).messages).toEqual([]);
    expect(
      restored.notifications.filter(
        (notification) => notification.task_id === interval.id,
      ),
    ).toEqual([]);
  } finally {
    await f.dispose();
  }
}, 60_000);

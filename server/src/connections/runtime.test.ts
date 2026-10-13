import { expect, test } from "bun:test";
import { createLastStepBaselineStore } from "../workspace/git-diff";
import { createLegacyConnectionRuntime } from "./runtime";

test("legacy runtime exposes and reports its configured connection identity", async () => {
  const events: Array<{ event: unknown; connectionId: string }> = [];
  const errors: Array<{ error: unknown; connectionId: string }> = [];
  const runtime = createLegacyConnectionRuntime({
    identity: { id: "remote-dev", label: "Remote Dev", source: "test" },
    config: {
      socketPath: "/tmp/m3-runtime-control.sock",
      clientSocketPath: "/tmp/m3-runtime-client.sock",
      sshHost: undefined,
      session: undefined,
      hasExplicitSocketPath: true,
      hasExplicitClientSocketPath: true,
    },
    safeSend: () => true,
    clientLabel: () => "browser",
    markRpcError: () => undefined,
    onEvent: (event, identity) => {
      events.push({ event, connectionId: identity.id });
    },
    onError: (error, identity) => {
      errors.push({ error, connectionId: identity.id });
    },
  });

  const event = { event: "workspace.updated", data: { workspace_id: "same" } };
  const error = new Error("downstream failed");
  runtime.herdr.emit("event", event);
  runtime.herdr.emit("error", error);

  expect(runtime.identity).toEqual({
    id: "remote-dev",
    label: "Remote Dev",
    source: "test",
  });
  expect(events).toEqual([{ event, connectionId: "remote-dev" }]);
  expect(errors).toEqual([{ error, connectionId: "remote-dev" }]);
  const stopping = runtime.stop();
  runtime.herdr.emit("event", {
    event: "pane.agent_status_changed",
    data: {
      pane_id: "w1:p1",
      workspace_id: "w1",
      agent_status: "working",
    },
  });
  await stopping;
  expect(events).toEqual([{ event, connectionId: "remote-dev" }]);
});

test("runtime stop drains an in-flight completion and suppresses publication", async () => {
  const tree = "a".repeat(40);
  let snapshotCall = 0;
  let releaseCompletion: () => void = () => undefined;
  let signalCompletion: () => void = () => undefined;
  const completionStarted = new Promise<void>((resolve) => {
    signalCompletion = resolve;
  });
  const completionGate = new Promise<void>((resolve) => {
    releaseCompletion = resolve;
  });
  const baselines = createLastStepBaselineStore({
    shQuote: (value) => `'${value}'`,
    runProcessWithCodeTimeout: async () => {
      snapshotCall += 1;
      if (snapshotCall === 2) {
        signalCompletion();
        await completionGate;
      }
      return { code: 0, stdout: `${tree}\n`, stderr: "" };
    },
  });
  const events: unknown[] = [];
  const runtime = createLegacyConnectionRuntime({
    config: {
      socketPath: "/tmp/m3-runtime-stop-control.sock",
      clientSocketPath: "/tmp/m3-runtime-stop-client.sock",
      sshHost: undefined,
      session: undefined,
      hasExplicitSocketPath: true,
      hasExplicitClientSocketPath: true,
    },
    safeSend: () => true,
    clientLabel: () => "browser",
    markRpcError: () => undefined,
    onEvent: (event) => events.push(event),
    lastStepBaselines: baselines,
    resolveLastStepWorkspaceGitRoot: async () => "/repo",
    lastStepTransitionDebounceMs: 0,
  });

  runtime.herdr.emit("event", {
    event: "pane.agent_status_changed",
    data: {
      pane_id: "w1:p1",
      workspace_id: "w1",
      agent_status: "working",
    },
  });
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
  runtime.herdr.emit("event", {
    event: "pane.agent_status_changed",
    data: {
      pane_id: "w1:p1",
      workspace_id: "w1",
      agent_status: "idle",
    },
  });
  await completionStarted;

  let stopped = false;
  const stopping = runtime.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  releaseCompletion();
  await stopping;

  expect(
    events.some(
      (event) =>
        (event as { event?: unknown }).event ===
        "workspace.last_step_completed",
    ),
  ).toBe(false);
  await expect(
    baselines.captureWorkspace("w1", async () => "/repo"),
  ).rejects.toMatchObject({ code: "LAST_STEP_STORE_DISPOSED" });
});

test("layout subscription ACK and reconnect request browser reconciliation", async () => {
  const events: unknown[] = [];
  const subscriptions: Array<{ ack: () => void; close: () => void }> = [];
  const runtime = createLegacyConnectionRuntime({
    config: {
      socketPath: "/tmp/unused-layout-contract-control.sock",
      clientSocketPath: "/tmp/unused-layout-contract-client.sock",
      hasExplicitSocketPath: true,
      hasExplicitClientSocketPath: true,
    },
    safeSend: () => true,
    clientLabel: () => "test",
    markRpcError: () => undefined,
    onEvent: (event) => events.push(event),
  });
  // No real sockets, settings-driven git operations, or pane processes.
  runtime.workspaceAutoSync.start = () => undefined;
  runtime.herdr.call = async () => ({ panes: [] });
  runtime.herdr.subscribe = (types) => {
    expect(types).toContain("layout.updated");
    let ack!: () => void;
    let close!: () => void;
    const ready = new Promise<void>((resolve) => {
      ack = resolve;
    });
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    subscriptions.push({ ack, close });
    return { ready, closed, close };
  };
  try {
    runtime.startBackground();
    expect(subscriptions).toHaveLength(1);
    expect(events).toEqual([]); // No snapshot invalidation before the ACK.
    subscriptions[0]!.ack();
    await Bun.sleep(10);
    expect(events).toEqual([{ event: "session.resync_required", data: {} }]);
    // Subscription name is dotted; tagged event envelopes use snake_case.
    const layout = {
      event: "layout_updated",
      data: { layout: { tab_id: "tab_1" } },
    };
    runtime.herdr.emit("event", layout);
    expect(events.at(-1)).toEqual(layout);
    subscriptions[0]!.close();
    const deadline = Date.now() + 3000;
    while (subscriptions.length < 2 && Date.now() < deadline)
      await Bun.sleep(10);
    expect(subscriptions).toHaveLength(2);
    expect(events).toHaveLength(2);
    subscriptions[1]!.ack();
    await Bun.sleep(10);
    expect(events.at(-1)).toEqual({
      event: "session.resync_required",
      data: {},
    });
    expect(events).toHaveLength(3);
  } finally {
    await runtime.stop();
  }
});

test("herdr notification source relays SemanticNotification and silences the status tracker", async () => {
  const { BinReader, BinWriter, encodeFrame } = await import(
    "../bridge/bincode"
  );
  const net = await import("node:net");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const control = (kind: string, data: unknown) => {
    const w = new BinWriter();
    w.variant(20);
    w.string(kind);
    w.string(JSON.stringify(data));
    return encodeFrame(w.toBuffer());
  };
  const notification = () => {
    const w = new BinWriter();
    w.variant(14);
    w.variant(1); // Finished
    w.string("claude finished");
    w.option("cvision", (v) => w.string(v));
    w.option(0, (v) => w.variant(v)); // Done
    w.option("claude", (v) => w.string(v));
    w.option("w1", (v) => w.string(v));
    w.option("w1:t1", (v) => w.string(v));
    w.option("w1:p1", (v) => w.string(v));
    w.option(null, () => undefined);
    return encodeFrame(w.toBuffer());
  };
  const hello = Promise.withResolvers<Record<string, unknown>>();
  const clientSocketPath = join(
    tmpdir(),
    `roamgate-notify-${process.pid}-${crypto.randomUUID()}.sock`,
  );
  const sockets = new Set<import("node:net").Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("data", (chunk) => {
      const reader = new BinReader(Buffer.from(chunk).subarray(4));
      reader.variant();
      reader.string();
      hello.resolve(JSON.parse(reader.string()));
      socket.write(
        control("endpoint.welcome.v1", {
          generation: 1,
          server_version: "0.9.1",
          snapshot_codec: "shell.snapshot.v1",
          surface_codec: "shell.surface.v1",
          input_codec: "shell.input.semantic.v1",
          blob_codec: "shell.blob.v1",
          methods: [],
          capabilities: [],
        }),
      );
      socket.write(
        control("shell.snapshot.v1", { boot_id: "boot-1", revision: 1 }),
      );
      socket.write(notification());
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(clientSocketPath, resolve),
  );
  const taskEvents: unknown[] = [];
  const browserEvents: unknown[] = [];
  const relayed = Promise.withResolvers<void>();
  const runtime = createLegacyConnectionRuntime({
    identity: { id: "local", label: "Local", source: "test" },
    config: {
      socketPath: join(tmpdir(), "roamgate-notify-control-missing.sock"),
      clientSocketPath,
      sshHost: undefined,
      session: undefined,
      hasExplicitSocketPath: true,
      hasExplicitClientSocketPath: true,
    },
    taskNotificationSource: "herdr",
    safeSend: () => true,
    clientLabel: () => "browser",
    markRpcError: () => undefined,
    onEvent: (event) => {
      browserEvents.push(event);
      if ((event as { event?: string }).event === "roamgate.task_notification")
        relayed.resolve();
    },
    onTaskEvent: (event) => taskEvents.push(event),
  });
  runtime.workspaceAutoSync.start = () => {};
  runtime.herdr.ping = async () => ({ version: "0.9.1", protocol: 22 });
  runtime.herdr.call = async () => ({ panes: [] });
  runtime.herdr.subscribe = () => {
    const closed = Promise.withResolvers<void>();
    return {
      ready: Promise.resolve(),
      closed: closed.promise,
      close: () => closed.resolve(),
    };
  };
  try {
    expect(runtime.taskNotificationSource).toBe("herdr");
    runtime.startBackground();
    expect((await hello.promise).surface_active).toBe(false);
    await relayed.promise;
    expect(taskEvents).toEqual([
      {
        kind: "completed",
        agent: "claude",
        title: "claude finished",
        body: "cvision",
        workspaceId: "w1",
        tabId: "w1:t1",
        paneId: "w1:p1",
      },
    ]);
    expect(browserEvents).toContainEqual({
      event: "roamgate.task_notification",
      data: {
        type: "roamgate.task_notification",
        kind: "completed",
        agent: "claude",
        title: "claude finished",
        body: "cvision",
        workspace_id: "w1",
        tab_id: "w1:t1",
        pane_id: "w1:p1",
      },
    });
    // Status transitions no longer produce a second notification.
    for (const agent_status of ["working", "idle"]) {
      runtime.herdr.emit("event", {
        event: "pane.agent_status_changed",
        data: { pane_id: "w1:p1", workspace_id: "w1", agent_status },
      });
    }
    expect(taskEvents).toHaveLength(1);
  } finally {
    await runtime.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("herdr notification source falls back to agent status on legacy Herdr", async () => {
  const taskEvents: unknown[] = [];
  const browserEvents: Array<{ event?: string; data?: unknown }> = [];
  const runtime = createLegacyConnectionRuntime({
    identity: { id: "legacy", label: "Legacy", source: "test" },
    config: {
      socketPath: "/tmp/roamgate-legacy-notify-control.sock",
      clientSocketPath: "/tmp/roamgate-legacy-notify-client.sock",
      sshHost: undefined,
      session: undefined,
      hasExplicitSocketPath: true,
      hasExplicitClientSocketPath: true,
    },
    taskNotificationSource: "herdr",
    safeSend: () => true,
    clientLabel: () => "browser",
    markRpcError: () => undefined,
    onEvent: (event) => browserEvents.push(event as never),
    onTaskEvent: (event) => taskEvents.push(event),
  });
  runtime.workspaceAutoSync.start = () => {};
  let pings = 0;
  runtime.herdr.ping = async () => {
    pings++;
    return { version: "0.8.2", protocol: 20 };
  };
  runtime.herdr.call = async (method: string) =>
    method === "workspace.get"
      ? { workspace: { label: "Agents" } }
      : method === "tab.list"
        ? { tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "Peter" }] }
        : { panes: [] };
  runtime.herdr.subscribe = () => {
    const closed = Promise.withResolvers<void>();
    return {
      ready: Promise.resolve(),
      closed: closed.promise,
      close: () => closed.resolve(),
    };
  };
  try {
    runtime.startBackground();
    for (let i = 0; i < 20 && pings === 0; i++) await Bun.sleep(1);
    await Bun.sleep(1);
    for (const agent_status of ["working", "blocked"]) {
      runtime.herdr.emit("event", {
        event: "pane.agent_status_changed",
        data: {
          pane_id: "w1:p1",
          workspace_id: "w1",
          tab_id: "w1:t1",
          agent: "codex",
          agent_status,
        },
      });
    }
    // Labels are resolved asynchronously before publishing.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(taskEvents).toEqual([
      {
        kind: "blocked",
        workspaceId: "w1",
        paneId: "w1:p1",
        tabId: "w1:t1",
        agent: "codex",
        workspaceLabel: "Agents",
        tabLabel: "Peter",
      },
    ]);
    expect(
      browserEvents.filter(
        (event) => event.event === "roamgate.task_notification",
      ),
    ).toEqual([
      {
        event: "roamgate.task_notification",
        data: {
          type: "roamgate.task_notification",
          kind: "blocked",
          agent: "codex",
          title: "Agent needs input",
          body: "Agents \u00b7 Peter",
          workspace_id: "w1",
          tab_id: "w1:t1",
          pane_id: "w1:p1",
        },
      },
    ]);
  } finally {
    await runtime.stop();
  }
});

test("Windows runtimes refuse Unix-only helper groups", async () => {
  const runtime = createLegacyConnectionRuntime({
    config: {
      socketPath: "/tmp/m3-runtime-windows-control.sock",
      clientSocketPath: "/tmp/m3-runtime-windows-client.sock",
      sshHost: "windows-host",
      session: undefined,
      hasExplicitSocketPath: true,
      hasExplicitClientSocketPath: true,
      remotePlatform: "windows",
    },
    safeSend: () => true,
    clientLabel: () => "browser",
    markRpcError: () => undefined,
    onEvent: () => undefined,
  });
  try {
    for (const call of [
      () => runtime.files.resolveWorkspaceGitRoot({ workspace_id: "w1" }),
      () => runtime.files.readGitDiffSummary({ workspace_id: "w1" }),
      () => runtime.worktreeHooks.readWorktreeHooks("/repo"),
      () => runtime.agentSessions.readHistory({ pane_id: "w1:p1" }),
    ])
      expect(call).toThrow("unavailable on Windows");
  } finally {
    await runtime.stop();
  }
});

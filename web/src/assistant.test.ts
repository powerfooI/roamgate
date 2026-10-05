import { afterEach, expect, mock, spyOn, test } from "bun:test";
import {
  type AssistantAction,
  type AssistantSnapshot,
  type AssistantTaskDetail,
  isAssistantSnapshot,
} from "../../shared/assistant";
import { bridge, type ConnectionStatus } from "./api";
import {
  __resetAssistantForTests,
  assistantActionExecuting,
  callAssistant,
  getAssistantTask,
  readAssistantState,
  parseAssistantContext,
  refreshAssistant,
  sendAssistant,
  setAssistantDraft,
  startAssistantClient,
} from "./assistant";

const scope = [{ connection_id: "local", workspace_id: "workspace" }];
function snapshot(revision = 0, instance = "bridge-1"): AssistantSnapshot {
  return {
    instance_id: instance,
    revision,
    config: {
      credential_source: "assistant",
      provider: "provider",
      model: "model",
      allowed_workspaces: scope,
    },
    providers: [
      {
        id: "provider",
        label: "Provider",
        methods: ["api_key"],
        configured: true,
      },
    ],
    models: [{ provider: "provider", id: "model", label: "Model" }],
    messages: [],
    running: false,
    error: null,
    auth: null,
  };
}

const restores: (() => void)[] = [];
const sessionA = "11111111-1111-4111-8111-111111111111";
const sessionB = "22222222-2222-4222-8222-222222222222";
function sessionSnapshot(revision: number, session_id: string) {
  return {
    ...snapshot(revision),
    session_id,
    sessions: [sessionA, sessionB].map((id) => ({
      id,
      title: id === sessionA ? "First question" : "Second question",
      created_at: "2026-10-04T00:00:00Z",
      updated_at: "2026-10-04T00:00:00Z",
      message_count: 2,
    })),
  };
}
afterEach(() => {
  __resetAssistantForTests();
  for (const restore of restores.splice(0).reverse()) restore();
});

test("workspace context validates scope identities and reports partial connection errors", () => {
  const workspace = {
    ...scope[0],
    connection_label: "Local",
    label: "Project",
    runtime_generation: 2,
  };
  expect(
    parseAssistantContext({
      workspaces: [workspace],
      errors: ["Remote unavailable"],
    }),
  ).toEqual({ workspaces: [workspace], errors: ["Remote unavailable"] });
  for (const result of [
    null,
    {},
    { workspaces: [null] },
    { workspaces: [{ ...workspace, runtime_generation: -1 }] },
    { workspaces: [workspace], errors: [1] },
  ])
    expect(() => parseAssistantContext(result)).toThrow(
      "Invalid Ranger workspace list",
    );
});

function installBridge(supported = true) {
  const helloDescriptor = Object.getOwnPropertyDescriptor(bridge, "hello");
  Object.defineProperty(bridge, "hello", {
    configurable: true,
    value: { capabilities: { embedded_assistant: supported } },
  });
  restores.push(() => {
    if (helloDescriptor)
      Object.defineProperty(bridge, "hello", helloDescriptor);
    else Reflect.deleteProperty(bridge, "hello");
  });
  const statuses = new Set<(status: ConnectionStatus) => void>();
  const pushes = new Set<(value: AssistantSnapshot) => void>();
  const offPush = mock(() => {});
  const statusSpy = spyOn(bridge, "onStatus").mockImplementation((callback) => {
    statuses.add(callback);
    callback("connected");
    return () => statuses.delete(callback);
  });
  const pushSpy = spyOn(bridge, "onAssistant").mockImplementation(
    (callback) => {
      pushes.add(callback);
      return () => {
        pushes.delete(callback);
        offPush();
      };
    },
  );
  const call = spyOn(bridge, "call").mockResolvedValue(snapshot());
  restores.push(
    () => statusSpy.mockRestore(),
    () => pushSpy.mockRestore(),
    () => call.mockRestore(),
  );
  return {
    call,
    offPush,
    status(status: ConnectionStatus) {
      for (const callback of statuses) callback(status);
    },
    push(value: AssistantSnapshot) {
      for (const callback of pushes) callback(value);
    },
  };
}

function deferred() {
  let resolve: (value: AssistantSnapshot) => void = () => {};
  const promise = new Promise<AssistantSnapshot>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("snapshots accept tab and split receipts while rejecting unknown operations", () => {
  const action: AssistantAction = {
    ...scope[0],
    id: "layout-action",
    kind: "create_tab",
    status: "succeeded",
    connection_label: "Local",
    workspace_label: "Project",
    runtime_generation: 1,
    created_at: "2026-10-03T00:00:00Z",
    params: { cwd: "/projects/repo" },
    summary: "Create a terminal tab in Project",
    detail: "Created tab tab-new with pane pane-new and terminal terminal-new.",
  };
  const receipt = (entry: unknown) => ({
    ...snapshot(),
    messages: [
      {
        id: "answer",
        role: "assistant",
        text: "",
        sent_at: action.created_at,
        tools: [],
        sources: [],
        actions: [entry],
      },
    ],
  });
  expect(isAssistantSnapshot(receipt(action))).toBe(true);
  expect(
    isAssistantSnapshot(
      receipt({
        ...action,
        kind: "split_pane",
        params: {
          tab_id: "tab-original",
          pane_id: "pane-original",
          terminal_id: "terminal-original",
          direction: "right",
        },
      }),
    ),
  ).toBe(true);
  expect(isAssistantSnapshot(receipt({ ...action, kind: "close_tab" }))).toBe(
    false,
  );
  expect(
    isAssistantSnapshot(receipt({ ...action, params: { direction: 1 } })),
  ).toBe(false);
});

test("hidden panel shares subscription and delayed snapshots never undo streaming or a restart", async () => {
  const server = installBridge();
  const initial = deferred();
  server.call.mockReturnValueOnce(initial.promise);
  const closeRoot = startAssistantClient();
  const closePanel = startAssistantClient();
  expect(server.call).toHaveBeenCalledTimes(1);
  server.push(snapshot(4));
  initial.resolve(snapshot(1));
  await initial.promise;
  expect(readAssistantState().snapshot?.revision).toBe(4);

  let rejectGet: (error: Error) => void = () => {};
  server.call.mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      rejectGet = reject;
    }),
  );
  const failingRefresh = refreshAssistant();
  server.push(snapshot(5));
  rejectGet(new Error("Stale fetch failed"));
  await expect(failingRefresh).rejects.toThrow("Stale fetch failed");
  expect(readAssistantState().error).toBeNull();

  const oldBridge = deferred();
  server.call.mockReturnValueOnce(oldBridge.promise);
  const refreshing = refreshAssistant();
  server.push(snapshot(0, "bridge-2"));
  oldBridge.resolve(snapshot(99));
  await refreshing;
  server.push(snapshot(100));
  expect(readAssistantState().snapshot?.instance_id).toBe("bridge-2");

  setAssistantDraft("Keep while switching workspace");
  closePanel();
  expect(server.offPush).not.toHaveBeenCalled();
  server.push({ ...snapshot(2, "bridge-2"), running: true });
  expect(readAssistantState().snapshot?.running).toBe(true);
  expect(readAssistantState().draft).toBe("Keep while switching workspace");
  closeRoot();
  expect(server.offPush).toHaveBeenCalledTimes(1);
});

test("socket recovery only fetches state and manual retry retains its request id and new draft", async () => {
  const server = installBridge();
  startAssistantClient();
  await refreshAssistant();
  setAssistantDraft("Explain these changes");
  server.call.mockRejectedValueOnce(new Error("Acknowledgement lost"));
  await expect(sendAssistant("Explain these changes", scope)).rejects.toThrow(
    "Acknowledgement lost",
  );
  const failedRequest =
    server.call.mock.calls[server.call.mock.calls.length - 1]?.[1];
  expect(readAssistantState().draft).toBe("Explain these changes");

  server.status("disconnected");
  server.status("connected");
  await refreshAssistant();
  expect(
    server.call.mock.calls.filter(
      ([method]) => method === "bridge.assistant.send",
    ),
  ).toHaveLength(1);

  const reply = deferred();
  server.call.mockReturnValueOnce(reply.promise);
  const retry = sendAssistant("Explain these changes", scope);
  expect(
    server.call.mock.calls[server.call.mock.calls.length - 1]?.[1]?.request_id,
  ).toBe(failedRequest?.request_id);
  setAssistantDraft("Next question");
  server.push({ ...snapshot(1), running: true });
  reply.resolve({ ...snapshot(1), running: true });
  await retry;
  expect(readAssistantState().draft).toBe("Next question");
  expect(readAssistantState().snapshot?.running).toBe(true);
});

test("old bridges make no assistant requests and malformed state is surfaced", async () => {
  const oldServer = installBridge(false);
  startAssistantClient();
  expect(oldServer.call).not.toHaveBeenCalled();
  await expect(callAssistant("get")).rejects.toThrow("does not support");
  __resetAssistantForTests();
  const server = installBridge();
  server.call.mockResolvedValue({ revision: 1 });
  startAssistantClient();
  await expect(refreshAssistant()).rejects.toThrow("Invalid Ranger state");
  expect(readAssistantState().snapshot).toBeNull();
  expect(readAssistantState().error).toContain("Invalid Ranger state");
  expect(readAssistantState().loading).toBe(false);
});

test("history switching preserves each draft and stale snapshots cannot switch chats back", async () => {
  const server = installBridge();
  startAssistantClient();
  await refreshAssistant();
  setAssistantDraft("Draft before the session was loaded");
  server.push(sessionSnapshot(1, sessionA));
  expect(readAssistantState().draft).toBe(
    "Draft before the session was loaded",
  );
  server.push(sessionSnapshot(2, sessionB));
  expect(readAssistantState().draft).toBe("");
  setAssistantDraft("Second chat draft");
  server.push(sessionSnapshot(3, sessionA));
  expect(readAssistantState().draft).toBe(
    "Draft before the session was loaded",
  );
  server.push(sessionSnapshot(2, sessionB));
  expect(readAssistantState().snapshot?.session_id).toBe(sessionA);
  expect(readAssistantState().draft).toBe(
    "Draft before the session was loaded",
  );
  server.push(sessionSnapshot(4, sessionB));
  expect(readAssistantState().draft).toBe("Second chat draft");
});

test("sends identify their chat and delayed acknowledgements only clear the originating draft", async () => {
  const server = installBridge();
  startAssistantClient();
  await refreshAssistant();
  server.push(sessionSnapshot(1, sessionA));
  setAssistantDraft("Same question");
  const reply = deferred();
  server.call.mockReturnValueOnce(reply.promise);
  const sending = sendAssistant("Same question", scope);
  const first = server.call.mock.calls[server.call.mock.calls.length - 1]?.[1];
  expect(first?.session_id).toBe(sessionA);
  server.push(sessionSnapshot(3, sessionB));
  setAssistantDraft("Same question");
  reply.resolve(sessionSnapshot(2, sessionA));
  await sending;
  expect(readAssistantState().snapshot?.session_id).toBe(sessionB);
  expect(readAssistantState().draft).toBe("Same question");
  server.push(sessionSnapshot(4, sessionA));
  expect(readAssistantState().draft).toBe("");

  setAssistantDraft("Retry question");
  server.call.mockRejectedValueOnce(new Error("Reply lost"));
  await expect(sendAssistant("Retry question", scope)).rejects.toThrow(
    "Reply lost",
  );
  const retryA = server.call.mock.calls[server.call.mock.calls.length - 1]?.[1];
  server.push(sessionSnapshot(5, sessionB));
  server.call.mockRejectedValueOnce(new Error("Reply lost"));
  await expect(sendAssistant("Retry question", scope)).rejects.toThrow(
    "Reply lost",
  );
  const retryB = server.call.mock.calls[server.call.mock.calls.length - 1]?.[1];
  expect(retryB?.session_id).toBe(sessionB);
  expect(retryB?.request_id).not.toBe(retryA?.request_id);
});

test("confirmed actions block further mutations and reconnect never confirms again", async () => {
  const server = installBridge();
  startAssistantClient();
  await refreshAssistant();
  const action: AssistantAction = {
    ...scope[0],
    id: "proposal",
    kind: "send_prompt",
    status: "pending",
    connection_label: "Local",
    workspace_label: "Project",
    runtime_generation: 1,
    created_at: "2026-10-03T00:00:00Z",
    params: { pane_id: "pane", prompt: "Review these changes" },
    summary: "Ask the project agent to review",
    detail: "",
  };
  const withAction = (revision: number, status: AssistantAction["status"]) => ({
    ...snapshot(revision),
    messages: [
      {
        id: "answer",
        role: "assistant" as const,
        sent_at: action.created_at,
        text: "Proposed next step",
        tools: [],
        sources: [],
        actions: [{ ...action, status }],
      },
    ],
  });
  server.push({ ...withAction(1, "pending"), running: true });
  const beforeConfirm = server.call.mock.calls.length;
  await expect(
    callAssistant("action.confirm", { action_id: action.id }),
  ).rejects.toThrow("finish before confirming");
  await expect(
    callAssistant("action.cancel", { action_id: action.id }),
  ).rejects.toThrow("finish before confirming");
  expect(server.call).toHaveBeenCalledTimes(beforeConfirm);
  expect(assistantActionExecuting(readAssistantState().snapshot)).toBe(false);

  server.push(withAction(2, "pending"));
  server.call.mockResolvedValue(withAction(3, "executing"));
  await callAssistant("action.confirm", { action_id: action.id });
  expect(assistantActionExecuting(readAssistantState().snapshot)).toBe(true);
  setAssistantDraft("Keep this draft");
  await sendAssistant("Keep this draft", scope);
  for (const mutation of [
    "send",
    "configure",
    "new_session",
    "select_session",
    "auth.start",
    "action.confirm",
    "action.cancel",
  ])
    await expect(callAssistant(mutation)).rejects.toThrow(
      "current action to finish",
    );
  expect(readAssistantState().draft).toBe("Keep this draft");

  await callAssistant("configure_approval", { approval_mode: "manual" });
  expect(server.call).toHaveBeenLastCalledWith(
    "bridge.assistant.configure_approval",
    { approval_mode: "manual" },
  );

  for (const action of [
    "task.pause",
    "task.cancel",
    "task.stop",
    "task.action.confirm",
  ]) {
    await callAssistant(action, { task_id: "task" });
    expect(server.call).toHaveBeenLastCalledWith(`bridge.assistant.${action}`, {
      task_id: "task",
    });
  }

  server.status("disconnected");
  server.status("connected");
  await refreshAssistant();
  expect(
    server.call.mock.calls.filter(
      ([method]) => method === "bridge.assistant.action.confirm",
    ),
  ).toEqual([["bridge.assistant.action.confirm", { action_id: action.id }]]);
  expect(
    server.call.mock.calls.some(
      ([method]) => method === "bridge.assistant.send",
    ),
  ).toBe(false);
  await callAssistant("stop");
  expect(assistantActionExecuting(readAssistantState().snapshot)).toBe(true);
  server.push(withAction(4, "uncertain"));
  expect(assistantActionExecuting(readAssistantState().snapshot)).toBe(false);
  expect(assistantActionExecuting(snapshot())).toBe(false);
});

test("task detail validates task and run identity without replacing chat state or accepting reconnect replies", async () => {
  const server = installBridge();
  startAssistantClient();
  await refreshAssistant();
  const chat = readAssistantState().snapshot;
  const at = "2026-10-04T00:00:00Z";
  const run = {
    id: "run",
    task_id: "task",
    status: "succeeded" as const,
    scheduled_at: at,
    error: null,
  };
  const detail: AssistantTaskDetail = {
    task: {
      id: "task",
      title: "Check project",
      prompt: "Read status",
      scope,
      schedule: { type: "interval", minutes: 60 },
      status: "active",
      created_at: at,
      updated_at: at,
      next_run_at: at,
      model: { provider: "provider", id: "model" },
      workspaces: [
        {
          ...scope[0],
          label: "Project",
          connection_label: "Local",
          runtime_generation: 1,
        },
      ],
    },
    runs: [run],
    run: { ...run, messages: [] },
  };
  server.call.mockResolvedValueOnce(detail);
  expect(await getAssistantTask("task", "run")).toEqual(detail);
  expect(server.call).toHaveBeenLastCalledWith("bridge.assistant.task.get", {
    task_id: "task",
    run_id: "run",
  });
  expect(readAssistantState().snapshot).toBe(chat);
  for (const value of [
    { ...detail, task: { ...detail.task, id: "other" } },
    { ...detail, run: undefined },
    { ...detail, run: { ...detail.run, messages: [null] } },
  ]) {
    server.call.mockResolvedValueOnce(value);
    await expect(getAssistantTask("task", "run")).rejects.toThrow(
      "Invalid Ranger task",
    );
  }
  expect(readAssistantState().error).toBeNull();
  const pending = Promise.withResolvers<AssistantTaskDetail>();
  server.call.mockReturnValueOnce(pending.promise);
  const old = getAssistantTask("task");
  server.status("disconnected");
  await expect(getAssistantTask("task")).rejects.toThrow("Reconnect");
  server.status("connected");
  pending.resolve(detail);
  await expect(old).rejects.toThrow("connection changed");
  expect(readAssistantState().snapshot).toEqual(chat);
});

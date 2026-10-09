import { afterEach, expect, mock, spyOn, test } from "bun:test";
import {
  type AssistantAction,
  type AssistantMention,
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
  getAssistantMentions,
  readAssistantState,
  parseAssistantContext,
  permittedAssistantWorkspaces,
  pruneAssistantWorkspaceRefs,
  reconcileAssistantConfig,
  refreshAssistant,
  sendAssistant,
  setAssistantDraft,
  startAssistantClient,
} from "./assistant";

const scope = [{ connection_id: "local", workspace_id: "workspace" }];
const mention: AssistantMention = {
  ...scope[0]!,
  kind: "workspace",
  label: "Project",
  workspace_label: "Project",
  connection_label: "Local",
  runtime_generation: 1,
  start: 0,
  end: 8,
};
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

test("workspace catalog metadata is optional but must be authoritative and consistent", () => {
  const workspace = {
    ...scope[0],
    connection_label: "Local",
    label: "Project",
    runtime_generation: 1,
  };
  const catalog = {
    workspaces: [workspace],
    errors: [],
    connection_ids: ["local", "offline"],
    complete_connection_ids: ["local"],
    truncated: false,
  };
  expect(parseAssistantContext(catalog)).toEqual(catalog);
  expect(
    parseAssistantContext({
      workspaces: [],
      connection_ids: [],
      complete_connection_ids: [],
    }),
  ).toEqual({
    workspaces: [],
    errors: [],
    connection_ids: [],
    complete_connection_ids: [],
  });
  for (const invalid of [
    { connection_ids: [1] },
    { connection_ids: [""] },
    { connection_ids: ["local", "local"] },
    { complete_connection_ids: "local" },
    { connection_ids: ["offline"] },
    { complete_connection_ids: ["removed"] },
    { truncated: "yes" },
  ])
    expect(() => parseAssistantContext({ ...catalog, ...invalid })).toThrow(
      "Invalid Ranger workspace list",
    );
});

test("High permissions include every available and newly discovered workspace without changing manual grants", () => {
  const config: AssistantSnapshot["config"] = {
    ...snapshot().config,
    allowed_workspaces: [],
  };
  const available = Array.from({ length: 100 }, (_, index) => ({
    connection_id: "local",
    workspace_id: `project-${index}`,
  }));
  expect(permittedAssistantWorkspaces(config, available)).toEqual([]);
  expect(
    permittedAssistantWorkspaces(
      { ...config, approval_mode: "auto", workspace_scope: "all" },
      available,
    ),
  ).toEqual(available);
  expect(
    permittedAssistantWorkspaces(
      { ...config, approval_mode: "auto" },
      available,
    ),
  ).toEqual([]);
  expect(config.allowed_workspaces).toEqual([]);
  config.allowed_workspaces = [available[0]!];
  const newlyAvailable = [
    ...available,
    { connection_id: "new-host", workspace_id: "new-project" },
  ];
  expect(
    permittedAssistantWorkspaces(
      { ...config, approval_mode: "auto", workspace_scope: "all" },
      newlyAvailable,
    ),
  ).toEqual(newlyAvailable);
  expect(
    permittedAssistantWorkspaces(
      { ...config, approval_mode: "manual" },
      newlyAvailable,
    ),
  ).toEqual([available[0]!]);
});

test("workspace selections are pruned only by complete connection listings", () => {
  const refs = [
    ...scope,
    { connection_id: "local", workspace_id: "deleted" },
    { connection_id: "offline", workspace_id: "project" },
    { connection_id: "removed-host", workspace_id: "project" },
  ];
  const workspaces = [
    {
      ...scope[0],
      connection_label: "Local",
      label: "Project",
      runtime_generation: 1,
    },
  ];
  expect(pruneAssistantWorkspaceRefs(refs, { workspaces, errors: [] })).toEqual(
    refs,
  );
  expect(
    pruneAssistantWorkspaceRefs(refs, {
      workspaces: [],
      errors: ["Disconnected"],
      connection_ids: ["local", "offline", "removed-host"],
      complete_connection_ids: [],
    }),
  ).toEqual(refs);
  expect(
    pruneAssistantWorkspaceRefs(refs, {
      workspaces,
      errors: ["Offline"],
      connection_ids: ["local", "offline"],
      complete_connection_ids: ["local"],
    }),
  ).toEqual([scope[0]!, refs[2]!]);
  expect(
    pruneAssistantWorkspaceRefs(refs, {
      workspaces: [],
      errors: [],
      connection_ids: ["local", "offline"],
      complete_connection_ids: ["local"],
    }),
  ).toEqual([refs[2]!]);
  expect(
    pruneAssistantWorkspaceRefs(refs, {
      workspaces,
      errors: [],
      connection_ids: ["local", "offline", "removed-host"],
      complete_connection_ids: [],
      truncated: true,
    }),
  ).toEqual(refs);
});

test("permission-only snapshot updates preserve unsaved model and workspace edits", () => {
  const deleted = { connection_id: "local", workspace_id: "deleted" };
  const unchecked = { connection_id: "local", workspace_id: "unchecked" };
  const added = { connection_id: "local", workspace_id: "added" };
  const previous = {
    ...snapshot().config,
    allowed_workspaces: [...scope, deleted, unchecked],
  };
  const draft = {
    ...previous,
    model: "unsaved-model",
    thinking_level: "high" as const,
    allowed_workspaces: [...scope, deleted, added],
  };
  const saved = { ...previous, allowed_workspaces: [...scope, unchecked] };
  expect(reconcileAssistantConfig(draft, previous, saved)).toEqual({
    ...draft,
    allowed_workspaces: [...scope, added],
  });
  expect(reconcileAssistantConfig(draft, undefined, saved)).toEqual(saved);
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

test("reference drafts survive native undo and chat switching, while ordinary pasted names stay unbound", async () => {
  const server = installBridge();
  startAssistantClient();
  await refreshAssistant();
  server.push(sessionSnapshot(1, sessionA));
  setAssistantDraft("@Project", [mention]);
  setAssistantDraft("@Project!");
  expect(readAssistantState().draftMentions).toEqual([mention]);
  setAssistantDraft("@Projec!");
  expect(readAssistantState().draftMentions).toEqual([]);
  setAssistantDraft("@Project!", undefined, "historyUndo");
  expect(readAssistantState().draftMentions).toEqual([mention]);
  setAssistantDraft("@Projec!", undefined, "historyRedo");
  expect(readAssistantState().draftMentions).toEqual([]);
  setAssistantDraft("@Project!");
  expect(readAssistantState().draftMentions).toEqual([]);
  setAssistantDraft("@Project", [mention]);
  setAssistantDraft("@Project?", undefined, "historyUndo");
  expect(readAssistantState().draftMentions).toEqual([]);
  setAssistantDraft("@Project", [mention]);
  server.push(sessionSnapshot(2, sessionB));
  setAssistantDraft("@Project");
  expect(readAssistantState().draftMentions).toEqual([]);
  server.push(sessionSnapshot(3, sessionA));
  expect(readAssistantState().draftMentions).toEqual([mention]);
});

test("identical-text pastes retain distinct binding states through repeated native undo and redo", () => {
  const text = "@Project";
  const paste = () =>
    setAssistantDraft(text, undefined, "insertFromPaste", {
      start: 0,
      end: text.length,
      inputType: "insertFromPaste",
    });
  setAssistantDraft(text, [mention]);
  paste();
  expect(readAssistantState().draftMentions).toEqual([]);
  paste();
  for (const expected of [[], [mention]]) {
    setAssistantDraft(text, undefined, "historyUndo");
    expect(readAssistantState().draft).toBe(text);
    expect(readAssistantState().draftMentions).toEqual(expected);
  }
  for (let index = 0; index < 2; index++) {
    setAssistantDraft(text, undefined, "historyRedo");
    expect(readAssistantState().draft).toBe(text);
    expect(readAssistantState().draftMentions).toEqual([]);
  }
  for (const expected of [[], [mention]]) {
    setAssistantDraft(text, undefined, "historyUndo");
    expect(readAssistantState().draftMentions).toEqual(expected);
  }
});

test("picker bindings annotate their native insertion snapshot so redo restores the selected identity", () => {
  setAssistantDraft("@", undefined, "insertText");
  setAssistantDraft("@Project ", undefined, "insertText");
  setAssistantDraft("@Project ", [mention]);
  setAssistantDraft("@", undefined, "historyUndo");
  expect(readAssistantState().draftMentions).toEqual([]);
  setAssistantDraft("@Project ", undefined, "historyRedo");
  expect(readAssistantState().draftMentions).toEqual([mention]);
  const remote = {
    ...mention,
    connection_id: "remote",
    connection_label: "Remote",
  };
  setAssistantDraft("@Project ", undefined, "insertText", {
    start: 0,
    end: mention.end,
    inputType: "insertText",
  });
  setAssistantDraft("@Project ", [remote]);
  setAssistantDraft("@Project ", undefined, "historyUndo");
  expect(readAssistantState().draftMentions).toEqual([mention]);
  setAssistantDraft("@Project ", undefined, "historyRedo");
  expect(readAssistantState().draftMentions).toEqual([remote]);
});

test("mention sends bind retry IDs to references and acknowledgements preserve a newly unlinked draft", async () => {
  const server = installBridge();
  startAssistantClient();
  await refreshAssistant();
  setAssistantDraft("@Project", [mention]);
  server.call.mockRejectedValueOnce(new Error("Reply lost"));
  await expect(sendAssistant("@Project", scope, [mention])).rejects.toThrow(
    "Reply lost",
  );
  const first = server.call.mock.calls[server.call.mock.calls.length - 1]?.[1];
  expect(first?.mentions).toEqual([mention]);
  const reply = deferred();
  server.call.mockReturnValueOnce(reply.promise);
  const retry = sendAssistant("@Project", scope, [mention]);
  expect(
    server.call.mock.calls[server.call.mock.calls.length - 1]?.[1]?.request_id,
  ).toBe(first?.request_id);
  setAssistantDraft("@Project", []);
  reply.resolve(snapshot(1));
  await retry;
  expect(readAssistantState().draft).toBe("@Project");
  expect(readAssistantState().draftMentions).toEqual([]);
  server.call.mockRejectedValueOnce(new Error("Reply lost"));
  await expect(sendAssistant("@Project", scope)).rejects.toThrow("Reply lost");
  expect(
    server.call.mock.calls[server.call.mock.calls.length - 1]?.[1]?.request_id,
  ).not.toBe(first?.request_id);
});

test("mention catalogs reject malformed and reconnect-delayed replies without changing chat state", async () => {
  const server = installBridge();
  startAssistantClient();
  await refreshAssistant();
  const target = {
    kind: mention.kind,
    connection_id: mention.connection_id,
    workspace_id: mention.workspace_id,
    connection_label: mention.connection_label,
    workspace_label: mention.workspace_label,
    runtime_generation: mention.runtime_generation,
    label: mention.label,
  };
  const catalog = { targets: [target], errors: [] };
  const original = readAssistantState().snapshot;
  server.call.mockResolvedValueOnce(catalog);
  expect(await getAssistantMentions(scope)).toEqual(catalog);
  expect(readAssistantState().snapshot).toBe(original);
  server.call.mockResolvedValueOnce({ targets: [{}], errors: [] });
  await expect(getAssistantMentions(scope)).rejects.toThrow(
    "could not load Ranger references",
  );
  let acknowledge!: (value: unknown) => void;
  server.call.mockReturnValueOnce(
    new Promise((resolve) => {
      acknowledge = resolve;
    }),
  );
  const pending = getAssistantMentions(scope);
  server.status("disconnected");
  server.status("connected");
  acknowledge(catalog);
  await expect(pending).rejects.toThrow("connection changed");
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

test("chat selection changes remain server-authoritative through stale replies, failures and reconnects", async () => {
  const server = installBridge();
  const close = startAssistantClient();
  await refreshAssistant();
  const configured = (
    revision: number,
    model: string,
    thinking_level: "low" | "high" = "low",
  ): AssistantSnapshot => ({
    ...snapshot(revision),
    chat_selection: true,
    config: { ...snapshot().config, model, thinking_level },
    models: ["first", "second"].map((id) => ({
      provider: "provider",
      id,
      label: id,
      thinking_levels: ["off", "low", "high"],
      default_thinking_level: "off",
    })),
  });
  try {
    server.push(configured(1, "first"));
    setAssistantDraft("Unsent draft");
    const pending = deferred();
    server.call.mockReturnValueOnce(pending.promise);
    const saving = callAssistant("configure_chat", { model: "second" });
    expect(readAssistantState().snapshot?.config.model).toBe("first");
    server.push(configured(3, "second", "high"));
    pending.resolve(configured(2, "second"));
    await saving;
    expect(readAssistantState().snapshot?.config.thinking_level).toBe("high");
    expect(readAssistantState().draft).toBe("Unsent draft");
    server.call.mockRejectedValueOnce(
      new Error("Selection changed in another browser"),
    );
    await expect(callAssistant("configure_chat")).rejects.toThrow(
      "another browser",
    );
    expect(readAssistantState().snapshot?.config.model).toBe("second");
    expect(readAssistantState().error).toContain("another browser");
    const reconnect = deferred();
    server.call.mockReturnValueOnce(reconnect.promise);
    const oldSave = callAssistant("configure_chat");
    server.status("disconnected");
    server.push(configured(4, "first"));
    reconnect.resolve(configured(9, "second"));
    await oldSave;
    expect(readAssistantState().snapshot?.config.model).toBe("first");
    expect(readAssistantState().draft).toBe("Unsent draft");
  } finally {
    close();
  }
});

test("send binds the visible model and effort and a changed selection starts a fresh request", async () => {
  const server = installBridge();
  const close = startAssistantClient();
  await refreshAssistant();
  try {
    server.push({
      ...snapshot(1),
      chat_selection: true,
      config: { ...snapshot().config, thinking_level: "high" },
    });
    setAssistantDraft("Use this model");
    server.call.mockRejectedValueOnce(new Error("Model changed"));
    await expect(sendAssistant("Use this model", scope)).rejects.toThrow(
      "Model changed",
    );
    const first =
      server.call.mock.calls[server.call.mock.calls.length - 1]?.[1];
    expect(first?.expected).toEqual({
      instance_id: "bridge-1",
      provider: "provider",
      model: "model",
      credential_source: "assistant",
      thinking_level: "high",
    });
    expect(readAssistantState().draft).toBe("Use this model");
    server.push({
      ...snapshot(2),
      chat_selection: true,
      config: { ...snapshot().config, model: "other", thinking_level: "low" },
    });
    server.call.mockRejectedValueOnce(new Error("Unavailable"));
    await expect(sendAssistant("Use this model", scope)).rejects.toThrow(
      "Unavailable",
    );
    const second =
      server.call.mock.calls[server.call.mock.calls.length - 1]?.[1];
    expect(second?.request_id).not.toBe(first?.request_id);
    expect(second?.expected).toMatchObject({
      model: "other",
      thinking_level: "low",
    });
    server.call.mockRejectedValueOnce(new Error("Retry unavailable"));
    await expect(sendAssistant("Use this model", scope)).rejects.toThrow();
    expect(
      server.call.mock.calls[server.call.mock.calls.length - 1]?.[1]
        ?.request_id,
    ).toBe(second?.request_id);
  } finally {
    close();
  }
});

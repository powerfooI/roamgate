import { expect, test } from "bun:test";
import {
  type ActionToolProposer,
  actionTools,
  callActionTool,
  callNotificationTool,
  callTaskTool,
  callWorkspaceTool,
  notificationTools,
  type WorkspaceToolReader,
  type WorkspaceToolResult,
  workspaceTools,
} from "./tools";

test("task tools validate the published schedule and reject effects outside the schema", async () => {
  let calls = 0;
  const handle = async () => {
    calls++;
    return { text: "Pending preview" };
  };
  const proposal = {
    title: "Status",
    prompt: "Summarize status",
    scope: [{ connection_id: "local", workspace_id: "workspace" }],
    schedule: { type: "daily", time: "09:00", timezone: "UTC" },
  };
  expect(await callTaskTool("propose_ranger_task", proposal, handle)).toEqual({
    text: "Pending preview",
  });
  for (const notification_mode of ["status", "agent"])
    await expect(
      callTaskTool(
        "propose_ranger_task",
        { ...proposal, notification_mode },
        handle,
      ),
    ).resolves.toEqual({ text: "Pending preview" });
  for (const params of [
    { ...proposal, execute: true },
    { ...proposal, scope: [] },
    {
      ...proposal,
      schedule: { type: "daily", time: "25:00", timezone: "UTC" },
    },
    { ...proposal, schedule: { type: "interval", minutes: 0 } },
    { ...proposal, notification_mode: "always" },
    { ...proposal, notification_mode: null },
  ])
    await expect(
      callTaskTool("propose_ranger_task", params, handle),
    ).rejects.toThrow("Invalid task tool parameters.");
  await expect(callTaskTool("run_ranger_task", {}, handle)).rejects.toThrow(
    "Unknown task tool.",
  );
  const controller = new AbortController();
  controller.abort();
  await expect(
    callTaskTool("list_ranger_tasks", {}, handle, controller.signal),
  ).rejects.toThrow("Task unavailable");
  expect(calls).toBe(3);
});

test("notification tool accepts bounded custom content without model-controlled destinations", async () => {
  const input = {
    event_key: "agent-session-1:verified-success",
    kind: "completed" as const,
    title: "Agent completed the release check",
    body: "The workspace history confirms the checks passed. Review the result.",
  };
  const signal = new AbortController().signal;
  const receipt = {
    text: '{"accepted":true,"event_key":"agent-session-1:verified-success"}',
  };
  let sends = 0;
  expect(notificationTools).toHaveLength(1);
  expect(
    JSON.parse(JSON.stringify(notificationTools[0]?.parameters)),
  ).toMatchObject({
    type: "object",
    additionalProperties: false,
    properties: {
      event_key: { type: "string", minLength: 1, maxLength: 200 },
      title: { type: "string", minLength: 1, maxLength: 200 },
      body: { type: "string", minLength: 1, maxLength: 400 },
    },
    required: ["event_key", "kind", "title", "body"],
  });
  expect(
    await callNotificationTool(
      "send_user_notification",
      input,
      async (actualInput, actualSignal) => {
        sends++;
        expect(actualInput).toBe(input);
        expect(actualSignal).toBe(signal);
        return receipt;
      },
      signal,
    ),
  ).toBe(receipt);
  const send = async () => {
    sends++;
    return receipt;
  };
  await expect(
    callNotificationTool("notify_user", input, send),
  ).rejects.toThrow("Unknown notification tool.");
  for (const params of [
    null,
    [],
    { ...input, event_key: "" },
    { ...input, event_key: " " },
    { ...input, event_key: "a".repeat(201) },
    { ...input, kind: "failed" },
    { ...input, title: "" },
    { ...input, title: " " },
    { ...input, title: "a".repeat(201) },
    { ...input, body: "" },
    { ...input, body: " " },
    { ...input, body: "a".repeat(401) },
    { ...input, url: "https://example.com" },
    { ...input, destination: "other-user" },
    { ...input, user_id: "other-user" },
    { ...input, task_id: "other-task" },
    { ...input, run_id: "other-run" },
    { ...input, connection_id: "outside-scope" },
    { ...input, workspace_id: "outside-scope" },
  ])
    await expect(
      callNotificationTool("send_user_notification", params, send),
    ).rejects.toThrow("Invalid notification tool parameters.");
  expect(sends).toBe(1);
});

test("notification cancellation blocks sending and late results while errors stay private", async () => {
  const input = {
    event_key: "agent-session-1:needs-input",
    kind: "attention" as const,
    title: "Agent needs input",
    body: "Choose the deployment target in the agent pane.",
  };
  const controller = new AbortController();
  const message = "Notification unavailable or outside the authorized task.";
  let sends = 0;
  await expect(
    callNotificationTool(
      "send_user_notification",
      input,
      async (_input, signal) => {
        sends++;
        expect(signal).toBe(controller.signal);
        controller.abort(new Error("synthetic-private-secret"));
        return { text: "late receipt" };
      },
      controller.signal,
    ),
  ).rejects.toThrow(message);
  await expect(
    callNotificationTool(
      "send_user_notification",
      input,
      async () => {
        sends++;
        return { text: "must not send" };
      },
      controller.signal,
    ),
  ).rejects.toThrow(message);
  expect(sends).toBe(1);
  try {
    await callNotificationTool("send_user_notification", input, async () => {
      throw new Error("synthetic-private-secret");
    });
    throw new Error("expected failure");
  } catch (error) {
    expect((error as Error).message).toBe(message);
    expect((error as Error).cause).toBeUndefined();
    expect(String(error)).not.toContain("synthetic-private-secret");
  }
});

test("the tool directory is JSON Schema and named calls preserve structured results", async () => {
  expect(JSON.parse(JSON.stringify(workspaceTools))).toMatchObject([
    { name: "workspace_status", parameters: { type: "object" } },
    { name: "workspace_history", parameters: { type: "object" } },
    { name: "workspace_diff", parameters: { type: "object" } },
    { name: "workspace_terminal", parameters: { type: "object" } },
  ]);
  const result: WorkspaceToolResult = {
    text: "Read-only workspace context.",
    sources: [
      {
        id: "source-status",
        kind: "status",
        title: "Status",
        connection_id: "local",
        workspace_id: "workspace",
        runtime_generation: 1,
        read_at: "2026-10-03T00:00:00.000Z",
      },
    ],
  };
  const signal = new AbortController().signal;
  for (const [name, kind, params] of [
    ["workspace_status", "status", {}],
    ["workspace_history", "history", { pane_id: "pane" }],
    ["workspace_diff", "diff", { path: "src/index.ts" }],
    ["workspace_terminal", "terminal", { pane_id: "pane" }],
  ] as const) {
    const read: WorkspaceToolReader = async (
      actualKind,
      args,
      actualSignal,
    ) => {
      expect(actualKind).toBe(kind);
      expect(args).toBe(params);
      expect(actualSignal).toBe(signal);
      return result;
    };
    expect(await callWorkspaceTool(name, params, read, signal)).toBe(result);
  }
});

test("named calls reject unknown tools and parameters beyond their published capability", async () => {
  let reads = 0;
  const read: WorkspaceToolReader = async () => {
    reads++;
    return { text: "must not read" };
  };
  await expect(callWorkspaceTool("workspace_write", {}, read)).rejects.toThrow(
    "Unknown workspace tool.",
  );
  for (const [name, params] of [
    ["workspace_status", null],
    ["workspace_status", []],
    ["workspace_status", { connection_id: 1 }],
    ["workspace_status", { method: "pane.write" }],
    ["workspace_history", {}],
    ["workspace_terminal", {}],
    ["workspace_terminal", { pane_id: "pane", source: "scrollback" }],
    ["workspace_history", { pane_id: "pane", lines: 200 }],
    ["workspace_diff", { path: 123 }],
    ["workspace_diff", { mode: "branch-main" }],
    ["workspace_diff", { kind: "branch" }],
    ["workspace_diff", { kind: "last-step" }],
    ["workspace_diff", { kind: "invalid" }],
    ["workspace_diff", { kind: 1 }],
    ["workspace_diff", { kind: null }],
    ["workspace_diff", { old_path: "secrets.txt" }],
    ["workspace_diff", { snapshot_id: "snapshot" }],
  ] as const) {
    await expect(callWorkspaceTool(name, params, read)).rejects.toThrow(
      "Invalid workspace tool parameters.",
    );
  }
  expect(reads).toBe(0);
});

test("terminal tools let the model choose a bounded recent line window", async () => {
  const tool = workspaceTools.find(
    (entry) => entry.name === "workspace_terminal",
  )!;
  expect(JSON.parse(JSON.stringify(tool.parameters))).toMatchObject({
    properties: {
      lines: { type: "integer", minimum: 1, maximum: 1000, default: 120 },
    },
    required: ["pane_id"],
  });
  let reads = 0;
  const read: WorkspaceToolReader = async (kind, params) => {
    reads++;
    expect(kind).toBe("terminal");
    return { text: String(params.lines ?? 120) };
  };
  for (const lines of [undefined, 1, 500, 1000]) {
    const params = {
      pane_id: "pane",
      ...(lines !== undefined ? { lines } : {}),
    };
    expect((await callWorkspaceTool(tool.name, params, read)).text).toBe(
      String(lines ?? 120),
    );
  }
  expect(reads).toBe(4);
  for (const lines of [null, "500", 0, -1, 1.5, 1001, NaN, Infinity]) {
    await expect(
      callWorkspaceTool(tool.name, { pane_id: "pane", lines }, read),
    ).rejects.toThrow("Invalid workspace tool parameters.");
  }
  expect(reads).toBe(4);
});

test("canceled calls do not read or return a late result and preserve the reader signal", async () => {
  const controller = new AbortController();
  const read: WorkspaceToolReader = async (_kind, _params, signal) => {
    expect(signal).toBe(controller.signal);
    controller.abort(new Error("private cancellation reason"));
    return { text: "late result" };
  };
  await expect(
    callWorkspaceTool("workspace_status", {}, read, controller.signal),
  ).rejects.toThrow(
    "Context unavailable, stale, or outside the authorized scope.",
  );
  let reads = 0;
  await expect(
    callWorkspaceTool(
      "workspace_status",
      {},
      async () => {
        reads++;
        return { text: "must not read" };
      },
      controller.signal,
    ),
  ).rejects.toThrow(
    "Context unavailable, stale, or outside the authorized scope.",
  );
  expect(reads).toBe(0);
});

test("reader errors expose only a fixed safe error", async () => {
  const read: WorkspaceToolReader = async () => {
    throw new Error("backend details include synthetic-private-secret");
  };
  try {
    await callWorkspaceTool("workspace_status", {}, read);
    throw new Error("expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Context unavailable, stale, or outside the authorized scope.",
    );
    expect((error as Error).cause).toBeUndefined();
    expect(String(error)).not.toContain("synthetic-private-secret");
  }
});

test("action tools only return proposals through the supplied callback", async () => {
  expect(JSON.parse(JSON.stringify(actionTools))).toMatchObject([
    { name: "propose_workspace_create", parameters: { type: "object" } },
    { name: "propose_worktree_create", parameters: { type: "object" } },
    { name: "propose_tab_create", parameters: { type: "object" } },
    { name: "propose_pane_split", parameters: { type: "object" } },
    { name: "propose_agent_start", parameters: { type: "object" } },
    { name: "propose_agent_prompt", parameters: { type: "object" } },
  ]);
  const result = { text: "Proposal pending user confirmation." };
  const signal = new AbortController().signal;
  for (const [name, kind, params] of [
    [
      "propose_workspace_create",
      "create_workspace",
      { label: "Workspace", cwd: "/tmp/project" },
    ],
    [
      "propose_worktree_create",
      "create_worktree",
      { branch: "feature", label: "Worktree" },
    ],
    ["propose_agent_start", "start_agent", { pane_id: "pane", agent: "pi" }],
    ["propose_tab_create", "create_tab", {}],
    [
      "propose_pane_split",
      "split_pane",
      { pane_id: "pane", direction: "right" },
    ],
    [
      "propose_pane_split",
      "split_pane",
      { pane_id: "pane", direction: "down" },
    ],
    [
      "propose_agent_prompt",
      "send_prompt",
      { pane_id: "pane", prompt: "Review the change." },
    ],
  ] as const) {
    const args = {
      connection_id: "local",
      workspace_id: "workspace",
      ...params,
    };
    let proposals = 0;
    const propose: ActionToolProposer = async (
      actualKind,
      actualArgs,
      actualSignal,
    ) => {
      proposals++;
      expect(actualKind).toBe(kind);
      expect(actualArgs).toBe(args);
      expect(actualSignal).toBe(signal);
      return result;
    };
    expect(await callActionTool(name, args, propose, signal)).toBe(result);
    expect(proposals).toBe(1);
  }
});

test("action schemas require explicit targets and reject commands, environment and unknown parameters", async () => {
  let proposals = 0;
  const propose: ActionToolProposer = async () => {
    proposals++;
    return { text: "must not propose" };
  };
  await expect(callActionTool("workspace_status", {}, propose)).rejects.toThrow(
    "Unknown action tool.",
  );
  await expect(callActionTool("workspace_create", {}, propose)).rejects.toThrow(
    "Unknown action tool.",
  );
  for (const [name, params] of [
    ["propose_workspace_create", { label: "Workspace" }],
    ["propose_worktree_create", { branch: "feature" }],
    ["propose_tab_create", {}],
    ["propose_pane_split", { pane_id: "pane", direction: "right" }],
    ["propose_agent_start", { pane_id: "pane", agent: "pi" }],
    ["propose_agent_prompt", { pane_id: "pane", prompt: "Review." }],
  ] as const) {
    for (const target of [
      {},
      { connection_id: "local" },
      { workspace_id: "workspace" },
      { connection_id: 1, workspace_id: "workspace" },
    ]) {
      await expect(
        callActionTool(name, { ...target, ...params }, propose),
      ).rejects.toThrow("Invalid action tool parameters.");
    }
    for (const extra of [
      { command: "touch unexpected" },
      { shell: "/bin/sh" },
      { env: { SECRET: "synthetic" } },
    ]) {
      await expect(
        callActionTool(
          name,
          {
            connection_id: "local",
            workspace_id: "workspace",
            ...params,
            ...extra,
          },
          propose,
        ),
      ).rejects.toThrow("Invalid action tool parameters.");
    }
    if (name !== "propose_tab_create")
      await expect(
        callActionTool(
          name,
          { connection_id: "local", workspace_id: "workspace" },
          propose,
        ),
      ).rejects.toThrow("Invalid action tool parameters.");
  }
  for (const params of [
    null,
    [],
    { connection_id: "local", workspace_id: "workspace", label: 1 },
    {
      connection_id: "local",
      workspace_id: "workspace",
      label: "Workspace",
      cwd: 1,
    },
  ]) {
    await expect(
      callActionTool("propose_workspace_create", params, propose),
    ).rejects.toThrow("Invalid action tool parameters.");
  }
  expect(proposals).toBe(0);
});

test("layout proposals use native defaults and only explicit right or down splits", async () => {
  let proposals = 0;
  const propose: ActionToolProposer = async () => {
    proposals++;
    return { text: "must not propose" };
  };
  const target = { connection_id: "local", workspace_id: "workspace" };
  for (const extra of [
    { label: "Custom tab" },
    { cwd: "/another/project" },
    { pane_id: "pane" },
    { focus: false },
  ])
    await expect(
      callActionTool("propose_tab_create", { ...target, ...extra }, propose),
    ).rejects.toThrow("Invalid action tool parameters.");
  for (const params of [
    { direction: "right" },
    { pane_id: "pane" },
    { pane_id: 1, direction: "right" },
    { pane_id: "pane", direction: "left" },
    { pane_id: "pane", direction: "vertical" },
    { pane_id: "pane", direction: "down", terminal_id: "terminal" },
    { pane_id: "pane", direction: "right", tab_id: "tab" },
  ])
    await expect(
      callActionTool("propose_pane_split", { ...target, ...params }, propose),
    ).rejects.toThrow("Invalid action tool parameters.");
  expect(proposals).toBe(0);
});

test("action cancellation and callback failures expose only a fixed safe error", async () => {
  const controller = new AbortController();
  const args = {
    connection_id: "local",
    workspace_id: "workspace",
    pane_id: "pane",
    prompt: "Review the change.",
  };
  const message =
    "Action proposal unavailable, stale, or outside the authorized scope.";
  await expect(
    callActionTool(
      "propose_agent_prompt",
      args,
      async (_kind, _params, signal) => {
        expect(signal).toBe(controller.signal);
        controller.abort(new Error("private cancellation reason"));
        return { text: "late proposal" };
      },
      controller.signal,
    ),
  ).rejects.toThrow(message);
  let proposals = 0;
  await expect(
    callActionTool(
      "propose_agent_prompt",
      args,
      async () => {
        proposals++;
        return { text: "must not propose" };
      },
      controller.signal,
    ),
  ).rejects.toThrow(message);
  expect(proposals).toBe(0);
  try {
    await callActionTool("propose_agent_prompt", args, async () => {
      throw new Error("backend details include synthetic-private-secret");
    });
    throw new Error("expected failure");
  } catch (error) {
    expect((error as Error).message).toBe(message);
    expect((error as Error).cause).toBeUndefined();
    expect(String(error)).not.toContain("synthetic-private-secret");
  }
});

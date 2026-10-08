import { expect, test } from "bun:test";
import {
  ASSISTANT_MAX_WORKSPACES,
  ASSISTANT_MAX_MENTIONS,
  ASSISTANT_MAX_TOOL_ARGUMENTS,
  ASSISTANT_MAX_TOOL_OUTPUT,
  isAssistantMessage,
  isAssistantMentionTarget,
  isAssistantMentionCatalog,
  isAssistantMentions,
  isAssistantTaskDetail,
  isAssistantTaskInput,
  isAssistantTaskNotification,
  type AssistantTaskDetail,
} from "./assistant";

test("tool activities accept bounded details and retain legacy summaries", () => {
  const message = {
    id: "message",
    role: "assistant",
    text: "Done",
    sent_at: "2026-10-06T00:00:00Z",
    sources: [],
    tools: [{ id: "read", name: "workspace_status", status: "completed" }],
  };
  expect(isAssistantMessage(message)).toBe(true);
  const tool = {
    ...message.tools[0],
    arguments: "{}",
    output: "Workspace is idle",
  };
  expect(isAssistantMessage({ ...message, tools: [tool] })).toBe(true);
  expect(
    isAssistantMessage({
      ...message,
      tools: [{ ...tool, output: "failed", status: "failed" }],
    }),
  ).toBe(true);
  for (const invalid of [
    { arguments: {} },
    { output: [] },
    { arguments: "x".repeat(ASSISTANT_MAX_TOOL_ARGUMENTS + 1) },
    { output: "x".repeat(ASSISTANT_MAX_TOOL_OUTPUT + 1) },
  ])
    expect(
      isAssistantMessage({ ...message, tools: [{ ...tool, ...invalid }] }),
    ).toBe(false);
});

test("Ranger notification envelopes require a string status and bounded task targets", () => {
  const notification = {
    task_id: "11111111-1111-4111-8111-111111111111",
    run_id: "22222222-2222-4222-8222-222222222222",
    status: "succeeded",
    title: "Agent finished",
    body: "Review its verification result in Ranger.",
  };
  for (const status of ["succeeded", "failed", "waiting"])
    expect(isAssistantTaskNotification({ ...notification, status })).toBe(true);
  for (const status of [["succeeded"], null, "stopped"])
    expect(isAssistantTaskNotification({ ...notification, status })).toBe(
      false,
    );
  expect(
    isAssistantTaskNotification({ ...notification, run_id: "other" }),
  ).toBe(false);
  expect(
    isAssistantTaskNotification({ ...notification, body: "x".repeat(401) }),
  ).toBe(false);
});

test("task details bind run records to the selected task and validate stored outputs", () => {
  const input = {
    title: "Status",
    prompt: "Summarize status",
    scope: [{ connection_id: "local", workspace_id: "workspace" }],
    schedule: { type: "daily" as const, time: "09:00", timezone: "UTC" },
  };
  const run = {
    id: "run-1",
    task_id: "task-1",
    status: "succeeded" as const,
    scheduled_at: "2026-10-04T09:00:00Z",
    error: null,
  };
  const detail: AssistantTaskDetail = {
    task: {
      ...input,
      id: "task-1",
      status: "active",
      created_at: "2026-10-04T00:00:00Z",
      updated_at: "2026-10-04T00:00:00Z",
      next_run_at: "2026-10-05T09:00:00Z",
      workspaces: [
        {
          ...input.scope[0]!,
          label: "Workspace",
          connection_label: "Local",
          runtime_generation: 1,
        },
      ],
      model: { provider: "anthropic", id: "model" },
    },
    runs: [run],
    run: { ...run, messages: [] },
  };
  expect(isAssistantTaskDetail(detail)).toBe(true);
  for (const notification_mode of ["status", "agent"])
    expect(isAssistantTaskInput({ ...input, notification_mode })).toBe(true);
  for (const notification_mode of ["always", "", null, true])
    expect(isAssistantTaskInput({ ...input, notification_mode })).toBe(false);
  expect(
    isAssistantTaskDetail({
      ...detail,
      run: { ...detail.run, task_id: "other" },
    }),
  ).toBe(false);
  expect(isAssistantTaskDetail({ ...detail, runs: [], run: detail.run })).toBe(
    false,
  );
  expect(
    isAssistantTaskDetail({
      ...detail,
      run: { ...detail.run, messages: [{}] },
    }),
  ).toBe(false);
  expect(
    isAssistantTaskInput({ ...input, scope: [...input.scope, ...input.scope] }),
  ).toBe(false);
  expect(
    isAssistantTaskInput({
      ...input,
      schedule: { ...input.schedule, timezone: "invalid-zone" },
    }),
  ).toBe(false);
  const message = {
    id: "draft",
    role: "assistant",
    text: "Preview",
    sent_at: "2026-10-04T00:00:00Z",
    tools: [],
    sources: [],
    task_proposals: [
      {
        ...input,
        id: "proposal",
        status: "pending",
        created_at: "2026-10-04T00:00:00Z",
      },
    ],
  };
  expect(isAssistantMessage(message)).toBe(true);
  expect(
    isAssistantMessage({
      ...message,
      task_proposals: [{ ...message.task_proposals[0], status: "executing" }],
    }),
  ).toBe(false);
});

test("thinking metadata validates exact SDK levels and remains optional for old snapshots", async () => {
  const { ASSISTANT_THINKING_LEVELS, isAssistantSnapshot } = await import(
    "./assistant"
  );
  const snapshot = {
    instance_id: "bridge",
    revision: 0,
    config: {
      provider: "test",
      model: "model",
      credential_source: "assistant",
      allowed_workspaces: [],
    },
    providers: [],
    models: [{ provider: "test", id: "model", label: "Model" }],
    messages: [],
    running: false,
    error: null,
    auth: null,
  };
  expect(isAssistantSnapshot(snapshot)).toBe(true);
  for (const level of ASSISTANT_THINKING_LEVELS) {
    expect(
      isAssistantSnapshot({
        ...snapshot,
        chat_selection: true,
        config: { ...snapshot.config, thinking_level: level },
        models: [
          {
            ...snapshot.models[0],
            thinking_levels: [level],
            default_thinking_level: level,
          },
        ],
      }),
    ).toBe(true);
  }
  for (const invalid of ["auto", "ultra", "", null, ["high"], 1])
    expect(
      isAssistantSnapshot({
        ...snapshot,
        config: { ...snapshot.config, thinking_level: invalid },
      }),
    ).toBe(false);
  for (const metadata of [
    { thinking_levels: ["high", "high"] },
    { thinking_levels: ["ultra"] },
    { thinking_levels: "high" },
    { thinking_levels: ["low"], default_thinking_level: "high" },
    { default_thinking_level: "off" },
  ])
    expect(
      isAssistantSnapshot({
        ...snapshot,
        models: [{ ...snapshot.models[0], ...metadata }],
      }),
    ).toBe(false);
  expect(isAssistantSnapshot({ ...snapshot, chat_selection: false })).toBe(
    false,
  );
  expect(
    isAssistantSnapshot({
      ...snapshot,
      models: [{ ...snapshot.models[0], thinking_levels: [] }],
    }),
  ).toBe(true);
});

test("custom model reasoning declarations validate booleans and accept legacy metadata", async () => {
  const { isAssistantSnapshot } = await import("./assistant");
  const snapshot = {
    instance_id: "bridge",
    revision: 0,
    config: {
      provider: "custom",
      model: "model",
      credential_source: "assistant",
      allowed_workspaces: [],
    },
    providers: [],
    messages: [],
    running: false,
    error: null,
    auth: null,
  };
  for (const reasoning of [undefined, true, false, null, "true", 1]) {
    expect(
      isAssistantSnapshot({
        ...snapshot,
        models: [
          {
            provider: "custom",
            id: "model",
            label: "Model",
            custom: {
              base_url: "https://example.com/v1",
              api: "openai-completions",
              reasoning,
            },
          },
        ],
      }),
    ).toBe(reasoning === undefined || typeof reasoning === "boolean");
  }
});

test("task scope uses the shared 512-workspace inventory boundary", () => {
  expect(ASSISTANT_MAX_WORKSPACES).toBe(512);
  const input = {
    title: "Status",
    prompt: "Summarize workspace status",
    schedule: { type: "interval", minutes: 5 },
    scope: Array.from({ length: ASSISTANT_MAX_WORKSPACES }, (_, index) => ({
      connection_id: "local",
      workspace_id: `w${index}`,
    })),
  };
  expect(isAssistantTaskInput(input)).toBe(true);
  expect(
    isAssistantTaskInput({
      ...input,
      scope: [
        ...input.scope,
        { connection_id: "local", workspace_id: "overflow" },
      ],
    }),
  ).toBe(false);
});

test("all-workspace consent is explicit metadata and legacy auto snapshots remain valid", async () => {
  const { isAssistantSnapshot } = await import("./assistant");
  const snapshot = {
    instance_id: "bridge",
    revision: 0,
    config: {
      provider: "custom",
      model: "model",
      credential_source: "assistant",
      allowed_workspaces: [],
      approval_mode: "auto",
    },
    providers: [],
    models: [],
    messages: [],
    running: false,
    error: null,
    auth: null,
  };
  const allowed = Array.from(
    { length: ASSISTANT_MAX_WORKSPACES },
    (_, index) => ({ connection_id: "local", workspace_id: `w${index}` }),
  );
  expect(
    isAssistantSnapshot({
      ...snapshot,
      config: { ...snapshot.config, allowed_workspaces: allowed },
    }),
  ).toBe(true);
  expect(
    isAssistantSnapshot({
      ...snapshot,
      config: {
        ...snapshot.config,
        allowed_workspaces: [
          ...allowed,
          { connection_id: "local", workspace_id: "overflow" },
        ],
      },
    }),
  ).toBe(false);
  for (const workspace_scope of [undefined, "all", "selected", true, null])
    expect(
      isAssistantSnapshot({
        ...snapshot,
        config: { ...snapshot.config, workspace_scope },
      }),
    ).toBe(workspace_scope === undefined || workspace_scope === "all");
});

const mentionWorkspace = {
  kind: "workspace" as const,
  connection_id: "local",
  workspace_id: "workspace",
  runtime_generation: 1,
  connection_label: "Local",
  workspace_label: "Workspace",
  label: "Workspace",
};

test("mentions validate bounded typed targets without extra private metadata", () => {
  const agent = {
    ...mentionWorkspace,
    kind: "agent" as const,
    label: "Fix login",
    pane_id: "p1",
    terminal_id: "term1",
    agent: "codex",
    agent_identity: "a".repeat(64),
  };
  expect(isAssistantMentionTarget(mentionWorkspace)).toBe(true);
  expect(isAssistantMentionTarget(agent)).toBe(true);
  for (const invalid of [
    { ...agent, kind: "file" },
    { ...agent, agent_identity: "session-path" },
    { ...agent, agent_identity: "A".repeat(64) },
    { ...agent, runtime_generation: -1 },
    { ...agent, label: "x".repeat(201) },
    { ...agent, label: "Agent\nPrompt" },
    { ...agent, path: "/secret/session" },
    { ...mentionWorkspace, pane_id: "p1" },
  ])
    expect(isAssistantMentionTarget(invalid)).toBe(false);
  expect(
    isAssistantMentionCatalog({
      targets: [mentionWorkspace, agent],
      errors: [],
      truncated: true,
    }),
  ).toBe(true);
  expect(isAssistantMentionCatalog({ targets: [agent], errors: [null] })).toBe(
    false,
  );
  expect(
    isAssistantMentionCatalog({
      targets: Array(713).fill(mentionWorkspace),
      errors: [],
    }),
  ).toBe(false);
});

test("mention ranges use exact UTF-16 markers, ordered nonoverlapping ranges and legacy messages", () => {
  const text = "\u{1f600} @Workspace and @Workspace";
  const first = { ...mentionWorkspace, start: 3, end: 13 };
  const second = { ...mentionWorkspace, start: 18, end: 28 };
  expect(isAssistantMentions([first, second], text)).toBe(true);
  for (const invalid of [
    [{ ...first, start: 2 }],
    [{ ...first, end: 12 }],
    [{ ...first, start: -1 }],
    [{ ...first, end: 99 }],
    [{ ...first, start: 3.5 }],
    [{ ...first, label: "Other" }],
    [second, first],
    [first, first],
    Array(ASSISTANT_MAX_MENTIONS + 1).fill(first),
  ])
    expect(isAssistantMentions(invalid, text)).toBe(false);
  const message = {
    id: "message",
    role: "user",
    text,
    sent_at: "2026-10-08T00:00:00Z",
    tools: [],
    sources: [],
  };
  expect(isAssistantMessage(message)).toBe(true);
  expect(isAssistantMessage({ ...message, mentions: [first, second] })).toBe(
    true,
  );
  expect(
    isAssistantMessage({
      ...message,
      mentions: [{ ...first, path: "/secret" }],
    }),
  ).toBe(false);
});

test("task mention targets remain inside the saved workspace scope", () => {
  const task = {
    title: "Watch",
    prompt: "Check the workspace",
    scope: [{ connection_id: "local", workspace_id: "workspace" }],
    schedule: { type: "interval", minutes: 5 },
    mentions: [mentionWorkspace],
  };
  expect(isAssistantTaskInput(task)).toBe(true);
  expect(
    isAssistantTaskInput({
      ...task,
      mentions: [{ ...mentionWorkspace, workspace_id: "private" }],
    }),
  ).toBe(false);
  expect(
    isAssistantTaskInput({
      ...task,
      mentions: Array(33).fill(mentionWorkspace),
    }),
  ).toBe(false);
});

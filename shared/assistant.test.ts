import { expect, test } from "bun:test";
import {
  isAssistantMessage,
  isAssistantTaskDetail,
  isAssistantTaskInput,
  type AssistantTaskDetail,
} from "./assistant";

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

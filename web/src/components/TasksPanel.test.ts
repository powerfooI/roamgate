import { expect, test } from "bun:test";
import type { AgentTask } from "../../../shared/agentTasks";
import { taskMetaLine } from "./TasksPanel";

const base = {
  jira_key: null,
  agent: null,
  started_at: null,
} as unknown as AgentTask;

test("task rows show key or Manual, status or agent, and elapsed time (AC46)", () => {
  const now = Date.parse("2026-11-04T12:06:00.000Z");
  expect(
    taskMetaLine(
      {
        ...base,
        status: "running",
        jira_key: "SDS-1624",
        agent: "claude",
        started_at: "2026-11-04T12:00:00.000Z",
      },
      now,
    ),
  ).toBe("SDS-1624 · claude · 6m");
  expect(
    taskMetaLine({ ...base, status: "queued", jira_key: "SDS-1679", agent: "claude" }),
  ).toBe("SDS-1679 · Queued · claude");
  expect(taskMetaLine({ ...base, status: "needs_review", jira_key: "SDS-1678" })).toBe(
    "SDS-1678 · Needs review",
  );
  expect(taskMetaLine({ ...base, status: "draft" })).toBe("Manual · Draft · Unassigned");
});

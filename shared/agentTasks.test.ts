import { expect, test } from "bun:test";
import {
  activeAgentTaskCount,
  agentTaskFilterCounts,
  agentTaskMatchesFilter,
  isAgentTaskSnapshot,
  openTasksForIssue,
  type AgentTask,
  type AgentTaskStatus,
} from "./agentTasks";

function task(status: AgentTaskStatus, extra: Partial<AgentTask> = {}) {
  return {
    id: `${status}-${Math.random()}`,
    title: "t",
    prompt: "p",
    preset_id: null,
    status,
    jira_key: null,
    jira_issue: null,
    connection_id: null,
    workspace_id: null,
    agent: null,
    session: null,
    started_at: null,
    sync_back: false,
    sync_result: null,
    last_error: null,
    created_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-01T00:00:00.000Z",
    ...extra,
  } satisfies AgentTask;
}

// The mockup: 1 running, 1 queued, 1 needs review, 2 drafts -> Open 5,
// Running 1, badge 3.
const mockup = [
  task("running"),
  task("queued"),
  task("needs_review"),
  task("draft"),
  task("draft"),
];

test("filters treat every unfinished status as open", () => {
  expect(agentTaskFilterCounts(mockup)).toEqual({
    open: 5,
    running: 1,
    done: 0,
  });
  expect(agentTaskMatchesFilter(task("done"), "open")).toBe(false);
  expect(agentTaskMatchesFilter(task("done"), "done")).toBe(true);
});

test("badge counts queued, running and needs review", () => {
  expect(activeAgentTaskCount(mockup)).toBe(3);
  expect(activeAgentTaskCount([task("draft"), task("done")])).toBe(0);
});

test("openTasksForIssue skips done tasks and other issues", () => {
  const linked = task("running", {
    jira_key: "SDS-1",
    updated_at: "2026-11-02T00:00:00.000Z",
  });
  const tasks = [
    task("done", { jira_key: "SDS-1" }),
    task("queued", { jira_key: "SDS-2" }),
    task("queued", { jira_key: "SDS-1" }),
    linked,
  ];
  const result = openTasksForIssue(tasks, "SDS-1");
  expect(result).toHaveLength(2);
  expect(result[0]).toBe(linked);
});

test("isAgentTaskSnapshot rejects malformed pushes", () => {
  expect(isAgentTaskSnapshot({ revision: 1, tasks: [task("draft")] })).toBe(
    true,
  );
  expect(isAgentTaskSnapshot({ revision: 1, tasks: [{ id: "x" }] })).toBe(
    false,
  );
  expect(isAgentTaskSnapshot({ tasks: [] })).toBe(false);
});

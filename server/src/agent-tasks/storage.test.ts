import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTask } from "../../../shared/agentTasks";
import { openAgentTaskStorage } from "./storage";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function tempPath() {
  const directory = mkdtempSync(join(tmpdir(), "roamgate-agent-tasks-"));
  directories.push(directory);
  return join(directory, "agent-tasks.sqlite");
}

const task: AgentTask = {
  id: "t1",
  title: "Fix LMS back-button redirect",
  prompt: "Implement SDS-1679",
  preset_id: "implement",
  status: "running",
  jira_key: "SDS-1679",
  jira_issue: {
    summary: "Back button",
    type: "Bug",
    status: "Selected for Development",
    assignee: "Lloyd Leagas",
  },
  connection_id: "local",
  workspace_id: "w1",
  agent: "claude",
  session: { tab_id: "tab-1", pane_id: "pane-1", terminal_id: "term-1" },
  started_at: "2026-11-04T00:00:00.000Z",
  sync_back: true,
  sync_result: null,
  last_error: null,
  created_at: "2026-11-04T00:00:00.000Z",
  updated_at: "2026-11-04T00:00:00.000Z",
};

test("tasks survive closing and reopening the database (AC3, AC4)", () => {
  const path = tempPath();
  const storage = openAgentTaskStorage(path);
  storage.put(task);
  storage.put({ ...task, id: "t2", jira_key: null, jira_issue: null, session: null, created_at: "2026-11-03T00:00:00.000Z" });
  storage.close();

  const reopened = openAgentTaskStorage(path);
  expect(reopened.list()).toEqual([
    task,
    {
      ...task,
      id: "t2",
      jira_key: null,
      jira_issue: null,
      session: null,
      created_at: "2026-11-03T00:00:00.000Z",
    },
  ]);
  reopened.put({ ...task, status: "done" });
  reopened.remove("t2");
  expect(reopened.list().map((entry) => [entry.id, entry.status])).toEqual([
    ["t1", "done"],
  ]);
  reopened.close();
  if (process.platform !== "win32")
    expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("a database from a newer Roamgate is refused", () => {
  const path = tempPath();
  openAgentTaskStorage(path).close();
  const db = new Database(path);
  db.exec("PRAGMA user_version = 99");
  db.close();
  expect(() => openAgentTaskStorage(path)).toThrow("Unsupported");
});

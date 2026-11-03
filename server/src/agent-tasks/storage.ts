import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  AGENT_TASK_STATUSES,
  type AgentTask,
  type AgentTaskStatus,
} from "../../../shared/agentTasks";
import { assertSafeDataPath, dataRoot } from "../config/data-paths";
import { roamgateEnv } from "../config/environment";

// Separate from Ranger's tasks.sqlite so its versioned rollback contract is
// untouched. Rows are written one at a time; each change commits before the
// service publishes it.
export const AGENT_TASKS_SCHEMA_VERSION = 1;

const schema = `
  CREATE TABLE IF NOT EXISTS agent_tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    preset_id TEXT,
    status TEXT NOT NULL,
    jira_key TEXT,
    jira_issue TEXT,
    connection_id TEXT,
    workspace_id TEXT,
    agent TEXT,
    session TEXT,
    started_at TEXT,
    sync_back INTEGER NOT NULL DEFAULT 0,
    sync_result TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS agent_tasks_jira_key ON agent_tasks (jira_key);
`;

type Row = {
  id: string;
  title: string;
  prompt: string;
  preset_id: string | null;
  status: string;
  jira_key: string | null;
  jira_issue: string | null;
  connection_id: string | null;
  workspace_id: string | null;
  agent: string | null;
  session: string | null;
  started_at: string | null;
  sync_back: number;
  sync_result: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type AgentTaskStorage = {
  list(): AgentTask[];
  put(task: AgentTask): void;
  remove(id: string): void;
  close(): void;
};

export function agentTasksPath(): string {
  return (
    roamgateEnv("AGENT_TASKS_PATH") ?? join(dataRoot(), "agent-tasks.sqlite")
  );
}

function json<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function fromRow(row: Row): AgentTask | null {
  if (!AGENT_TASK_STATUSES.includes(row.status as AgentTaskStatus)) return null;
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    preset_id: row.preset_id,
    status: row.status as AgentTaskStatus,
    jira_key: row.jira_key,
    jira_issue: json(row.jira_issue),
    connection_id: row.connection_id,
    workspace_id: row.workspace_id,
    agent: row.agent,
    session: json(row.session),
    started_at: row.started_at,
    sync_back: row.sync_back === 1,
    sync_result: json(row.sync_result),
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function createPrivateFile(path: string) {
  const fd = openSync(
    path,
    constants.O_RDWR |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  closeSync(fd);
}

export function openAgentTaskStorage(path = agentTasksPath()): AgentTaskStorage {
  assertSafeDataPath(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const existing = existsSync(path);
  if (!existing) createPrivateFile(path);
  const db = new Database(path, { readwrite: true, strict: true });
  let closed = false;
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const version = db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()!.user_version;
    if (existing && version !== 0 && version !== AGENT_TASKS_SCHEMA_VERSION)
      throw new Error("Unsupported agent task database version");
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
    db.exec(schema);
    db.exec(`PRAGMA user_version = ${AGENT_TASKS_SCHEMA_VERSION}`);
    for (const sidecar of [`${path}-wal`, `${path}-shm`])
      if (existsSync(sidecar)) chmodSync(sidecar, 0o600);
  } catch (error) {
    db.close(true);
    throw error;
  }
  const insert = db.query(
    `INSERT OR REPLACE INTO agent_tasks (
      id, title, prompt, preset_id, status, jira_key, jira_issue,
      connection_id, workspace_id, agent, session, started_at, sync_back,
      sync_result, last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const remove = db.query("DELETE FROM agent_tasks WHERE id = ?");
  const select = db.query<Row, []>(
    "SELECT * FROM agent_tasks ORDER BY created_at DESC, id",
  );
  return {
    list: () =>
      select
        .all()
        .map(fromRow)
        .filter((task): task is AgentTask => task !== null),
    put(task) {
      insert.run(
        task.id,
        task.title,
        task.prompt,
        task.preset_id,
        task.status,
        task.jira_key,
        task.jira_issue ? JSON.stringify(task.jira_issue) : null,
        task.connection_id,
        task.workspace_id,
        task.agent,
        task.session ? JSON.stringify(task.session) : null,
        task.started_at,
        task.sync_back ? 1 : 0,
        task.sync_result ? JSON.stringify(task.sync_result) : null,
        task.last_error,
        task.created_at,
        task.updated_at,
      );
    },
    remove(id) {
      remove.run(id);
    },
    close() {
      if (closed) return;
      closed = true;
      db.close(true);
    },
  };
}

/** In-memory storage for tests. */
export function createMemoryAgentTaskStorage(
  initial: AgentTask[] = [],
): AgentTaskStorage {
  const tasks = new Map(initial.map((task) => [task.id, { ...task }]));
  return {
    list: () =>
      [...tasks.values()]
        .map((task) => ({ ...task }))
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    put: (task) => {
      tasks.set(task.id, { ...task });
    },
    remove: (id) => {
      tasks.delete(id);
    },
    close: () => undefined,
  };
}

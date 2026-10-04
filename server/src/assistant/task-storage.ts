import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { join } from "node:path";
import { assertSafeDataPath } from "../config/data-paths";
import type { PreparedTask, SavedTaskState } from "./tasks";

export type TaskStorage = {
  load(): SavedTaskState;
  save(state: SavedTaskState): void;
  close(): void;
};

export const MAX_TASK_STATE_BYTES = 32_000_000;
const schema = `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, position INTEGER NOT NULL,
    status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    next_run_at TEXT, due_at TEXT,
    title TEXT NOT NULL, prompt TEXT NOT NULL, scope TEXT NOT NULL,
    schedule TEXT NOT NULL, config TEXT NOT NULL,
    targets TEXT NOT NULL, workspaces TEXT NOT NULL
  ) STRICT;
  CREATE TABLE runs (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
    position INTEGER NOT NULL, status TEXT NOT NULL, scheduled_at TEXT NOT NULL,
    started_at TEXT, finished_at TEXT, error TEXT, manual INTEGER NOT NULL,
    admission TEXT
  ) STRICT;
  CREATE INDEX runs_task ON runs(task_id, position);
  CREATE TABLE proposals (
    id TEXT PRIMARY KEY, position INTEGER NOT NULL, status TEXT NOT NULL,
    created_at TEXT NOT NULL, task_id TEXT,
    input TEXT NOT NULL, prepared TEXT NOT NULL
  ) STRICT;
  CREATE TABLE requests (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
    position INTEGER NOT NULL
  ) STRICT;
`;

type TaskRow = {
  id: string;
  position: number;
  status: string;
  created_at: string;
  updated_at: string;
  next_run_at: string | null;
  due_at: string | null;
  title: string;
  prompt: string;
  scope: string;
  schedule: string;
  config: string;
  targets: string;
  workspaces: string;
};
type RunRow = {
  id: string;
  task_id: string;
  position: number;
  status: string;
  scheduled_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  manual: number;
  admission: string | null;
};
type ProposalRow = {
  id: string;
  position: number;
  status: string;
  created_at: string;
  task_id: string | null;
  input: string;
  prepared: string;
};

function privateFile(path: string, create = false) {
  assertSafeDataPath(path);
  const fd = openSync(
    path,
    constants.O_RDWR |
      (constants.O_NOFOLLOW ?? 0) |
      (create ? constants.O_CREAT | constants.O_EXCL : 0),
    0o600,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error("Invalid Ranger task storage file");
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}

/** SQLite is authoritative once its file exists, even when it contains no tasks. */
export function openTaskStorage(
  directory: string,
  validate: (value: unknown) => SavedTaskState,
): TaskStorage {
  const path = join(directory, "tasks.sqlite");
  const sidecars = [`${path}-wal`, `${path}-shm`, `${path}-journal`];
  assertSafeDataPath(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const existing = existsSync(path);
  privateFile(path, !existing);
  function protect() {
    assertSafeDataPath(path);
    for (const sidecar of sidecars) {
      assertSafeDataPath(sidecar);
      if (existsSync(sidecar)) privateFile(sidecar);
    }
  }
  protect();
  const db = new Database(path, { readwrite: true, strict: true });
  let closed = false;
  const close = () => {
    if (!closed) {
      db.close(true);
      closed = true;
    }
  };
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000");
    if (
      existing &&
      db.query<{ user_version: number }, []>("PRAGMA user_version").get()
        ?.user_version !== 1
    )
      throw new Error("Unsupported Ranger task database");
    if (
      db.query<{ journal_mode: string }, []>("PRAGMA journal_mode = WAL").get()
        ?.journal_mode !== "wal"
    )
      throw new Error("Ranger task database requires WAL");
    db.exec("PRAGMA synchronous = FULL");
    protect();

    function write(state: SavedTaskState) {
      db.exec(
        "DELETE FROM requests; DELETE FROM runs; DELETE FROM tasks; DELETE FROM proposals",
      );
      const taskInsert = db.query(
        "INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const runInsert = db.query(
        "INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const [position, entry] of state.tasks.entries()) {
        const { task, input, config, targets, workspaces } = entry;
        taskInsert.run(
          task.id,
          position,
          task.status,
          task.created_at,
          task.updated_at,
          task.next_run_at,
          entry.due_at ?? null,
          input.title,
          input.prompt,
          JSON.stringify(input.scope),
          JSON.stringify(input.schedule),
          JSON.stringify(config),
          JSON.stringify(targets),
          JSON.stringify(workspaces),
        );
        for (const [position, run] of entry.runs.entries()) {
          const admission: PreparedTask | null = [
            "queued",
            "running",
            "waiting",
          ].includes(run.status)
            ? {
                input: run.input!,
                config: run.config!,
                targets: run.targets!,
                workspaces: run.workspaces!,
              }
            : null;
          runInsert.run(
            run.id,
            task.id,
            position,
            run.status,
            run.scheduled_at,
            run.started_at ?? null,
            run.finished_at ?? null,
            run.error,
            Number(run.manual),
            admission ? JSON.stringify(admission) : null,
          );
        }
      }
      const proposalInsert = db.query(
        "INSERT INTO proposals VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const [
        position,
        { proposal, prepared },
      ] of state.proposals.entries()) {
        const { id, status, created_at, task_id, ...input } = proposal;
        proposalInsert.run(
          id,
          position,
          status,
          created_at,
          task_id ?? null,
          JSON.stringify(input),
          JSON.stringify(prepared),
        );
      }
      const requestInsert = db.query("INSERT INTO requests VALUES (?, ?, ?)");
      for (const [position, request] of state.requests.entries())
        requestInsert.run(request.id, request.task_id, position);
    }

    if (!existing)
      db.transaction(() => {
        db.exec(schema);
        db.exec("PRAGMA user_version = 1");
      }).immediate();

    const load = db.transaction(() => {
      // Bound row counts and payloads before materializing JSON from disk.
      let bytes = 0;
      for (const [table, count, columns] of [
        [
          "tasks",
          50,
          [
            "id",
            "status",
            "created_at",
            "updated_at",
            "next_run_at",
            "due_at",
            "title",
            "prompt",
            "scope",
            "schedule",
            "config",
            "targets",
            "workspaces",
          ],
        ],
        [
          "runs",
          1000,
          [
            "id",
            "task_id",
            "status",
            "scheduled_at",
            "started_at",
            "finished_at",
            "admission",
            "error",
          ],
        ],
        [
          "proposals",
          50,
          ["id", "status", "created_at", "task_id", "input", "prepared"],
        ],
        ["requests", 1000, ["id", "task_id"]],
      ] as const) {
        const row = db
          .query<{ count: number; bytes: number }, []>(
            `SELECT count(*) AS count, coalesce(sum(${columns.map((column) => `coalesce(length(CAST(${column} AS BLOB)), 0)`).join(" + ")}), 0) AS bytes FROM ${table}`,
          )
          .get()!;
        bytes += row.bytes;
        if (row.count > count || bytes > MAX_TASK_STATE_BYTES)
          throw new Error("Saved Ranger tasks are too large");
      }
      const runs = db
        .query<RunRow, []>("SELECT * FROM runs ORDER BY position")
        .all();
      const tasks = db
        .query<TaskRow, []>("SELECT * FROM tasks ORDER BY position")
        .all()
        .map((row) => ({
          task: {
            id: row.id,
            status: row.status,
            created_at: row.created_at,
            updated_at: row.updated_at,
            next_run_at: row.next_run_at,
          },
          due_at: row.due_at ?? undefined,
          input: {
            title: row.title,
            prompt: row.prompt,
            scope: JSON.parse(row.scope),
            schedule: JSON.parse(row.schedule),
          },
          config: JSON.parse(row.config),
          targets: JSON.parse(row.targets),
          workspaces: JSON.parse(row.workspaces),
          runs: runs
            .filter((run) => run.task_id === row.id)
            .map((run) => ({
              ...(run.admission === null ? {} : JSON.parse(run.admission)),
              id: run.id,
              task_id: run.task_id,
              status: run.status,
              scheduled_at: run.scheduled_at,
              started_at: run.started_at ?? undefined,
              finished_at: run.finished_at ?? undefined,
              error: run.error,
              manual: run.manual === 1,
            })),
        }));
      if (
        runs.some(
          (run) =>
            !tasks.some((entry) => entry.task.id === run.task_id) ||
            ![0, 1].includes(run.manual),
        )
      )
        throw new Error("Invalid saved task runs");
      const proposals = db
        .query<ProposalRow, []>("SELECT * FROM proposals ORDER BY position")
        .all()
        .map((row) => ({
          proposal: {
            ...JSON.parse(row.input),
            id: row.id,
            status: row.status,
            created_at: row.created_at,
            task_id: row.task_id ?? undefined,
          },
          prepared: JSON.parse(row.prepared),
        }));
      const requests = db
        .query<{ id: string; task_id: string }, []>(
          "SELECT id, task_id FROM requests ORDER BY position",
        )
        .all();
      return validate({ tasks, proposals, requests });
    });
    // Fail closed during construction, including a missing or damaged table.
    load();
    const save = db.transaction((state: SavedTaskState) =>
      write(validate(state)),
    );
    return {
      load,
      save(state) {
        protect();
        save.immediate(state);
      },
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

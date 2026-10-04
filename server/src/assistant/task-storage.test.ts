import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTaskStorage, type TaskStorage } from "./task-storage";
import {
  type PreparedTask,
  type SavedTaskState,
  validateSavedTasks,
} from "./tasks";

const directories: string[] = [];
const stores: TaskStorage[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), "roamgate-task-storage-"));
  directories.push(path);
  return path;
}
function open(path: string) {
  const store = openTaskStorage(path, validateSavedTasks);
  stores.push(store);
  return store;
}
function inspect<T>(path: string, use: (db: Database) => T) {
  const db = new Database(join(path, "tasks.sqlite"));
  try {
    return use(db);
  } finally {
    db.close(true);
  }
}
function state(): SavedTaskState {
  const date = "2026-10-04T00:00:00.000Z";
  const scope = [{ connection_id: "local", workspace_id: "workspace" }];
  const prepared: PreparedTask = {
    input: {
      title: "Check workspace",
      prompt: "Report verified progress",
      scope,
      schedule: { type: "interval", minutes: 1 },
    },
    config: {
      provider: "test",
      model: "model",
      credential_source: "assistant",
      allowed_workspaces: scope,
    },
    targets: [
      {
        ...scope[0]!,
        endpoint_fingerprint: "a".repeat(64),
        workspace_identity: "b".repeat(64),
        herdr_boot_id: "original-boot",
      },
    ],
    workspaces: [
      {
        ...scope[0]!,
        connection_label: "Local",
        label: "Workspace",
        runtime_generation: 1,
      },
    ],
  };
  const id = randomUUID();
  return {
    tasks: [
      {
        ...prepared,
        task: {
          id,
          status: "active",
          created_at: date,
          updated_at: date,
          next_run_at: "2026-10-04T00:01:00.000Z",
        },
        due_at: date,
        runs: [
          {
            ...structuredClone(prepared),
            id: randomUUID(),
            task_id: id,
            status: "running",
            scheduled_at: date,
            started_at: date,
            error: null,
            manual: true,
          },
          {
            ...structuredClone(prepared),
            id: randomUUID(),
            task_id: id,
            status: "succeeded",
            scheduled_at: date,
            started_at: date,
            finished_at: date,
            error: null,
            manual: false,
          },
        ],
      },
    ],
    proposals: [
      {
        prepared: structuredClone(prepared),
        proposal: {
          ...structuredClone(prepared.input),
          id: randomUUID(),
          status: "pending",
          created_at: date,
        },
      },
    ],
    requests: [{ id: randomUUID(), task_id: id }],
  };
}
const empty = (): SavedTaskState => ({
  tasks: [],
  proposals: [],
  requests: [],
});

test("SQLite round trips queryable plans and keeps admissions only for unfinished runs", () => {
  const path = directory();
  const saved = state();
  const storage = open(path);
  storage.save(saved);
  const loaded = storage.load();
  expect(loaded.tasks[0]!.task).toEqual(saved.tasks[0]!.task);
  expect(loaded.tasks[0]!.due_at).toBe(saved.tasks[0]!.due_at);
  expect(loaded.tasks[0]!.runs[0]).toEqual(saved.tasks[0]!.runs[0]);
  expect(loaded.tasks[0]!.runs[1]!.input).toBeUndefined();
  expect(loaded.proposals).toEqual(saved.proposals);
  expect(loaded.requests).toEqual(saved.requests);
  inspect(path, (db) => {
    expect(db.query("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "wal",
    });
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(db.query("SELECT id, status, title FROM tasks").get()).toEqual({
      id: saved.tasks[0]!.task.id,
      status: "active",
      title: "Check workspace",
    });
    expect(
      db
        .query("SELECT id, task_id, status FROM runs WHERE status = 'running'")
        .get(),
    ).toEqual({
      id: saved.tasks[0]!.runs[0]!.id,
      task_id: saved.tasks[0]!.task.id,
      status: "running",
    });
    expect(
      db.query("SELECT admission FROM runs WHERE status = 'succeeded'").get(),
    ).toEqual({ admission: null });
  });
  storage.close();
  expect(open(path).load()).toEqual(loaded);
});

test("deleting every plan preserves an authoritative initialized empty database", () => {
  const path = directory();
  const storage = open(path);
  storage.save(state());
  storage.save(empty());
  storage.close();
  expect(open(path).load()).toEqual(empty());
  inspect(path, (db) =>
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 }),
  );
});

test.each([
  "corrupt",
  "uninitialized",
  "future-version",
  "invalid-row",
  "missing-table",
] as const)(
  "%s SQLite data fails closed without clearing the database",
  (damage) => {
    const path = directory();
    const saved = state();
    if (damage === "corrupt")
      writeFileSync(join(path, "tasks.sqlite"), "not sqlite");
    else if (damage === "uninitialized")
      writeFileSync(join(path, "tasks.sqlite"), "");
    else {
      const storage = open(path);
      storage.save(saved);
      storage.close();
      inspect(path, (db) =>
        db.exec(
          damage === "future-version"
            ? "PRAGMA user_version = 2"
            : damage === "missing-table"
              ? "DROP TABLE requests"
              : "UPDATE runs SET admission = NULL WHERE status = 'running'",
        ),
      );
    }
    const prior = readFileSync(join(path, "tasks.sqlite"));
    expect(() => open(path)).toThrow();
    expect(readFileSync(join(path, "tasks.sqlite"))).toEqual(prior);
  },
);

test("invalid permissions and duplicate run identifiers cannot overwrite saved tasks", () => {
  for (const defect of ["target", "duplicate-run"]) {
    const path = directory();
    const storage = open(path);
    storage.save(state());
    const original = storage.load();
    const changed = structuredClone(original);
    if (defect === "target")
      changed.tasks[0]!.targets[0]!.workspace_identity = "replaced";
    else changed.tasks[0]!.runs[1]!.id = changed.tasks[0]!.runs[0]!.id;
    expect(() => storage.save(changed)).toThrow();
    expect(storage.load()).toEqual(original);
  }
});

test("a failure after deleting old rows rolls back every table and can be retried", () => {
  const path = directory();
  const storage = open(path);
  storage.save(state());
  const previous = storage.load();
  const changed = structuredClone(previous);
  changed.tasks[0]!.task.status = "paused";
  changed.proposals[0]!.proposal.status = "cancelled";
  changed.requests = [];
  inspect(path, (db) =>
    db.exec(
      "CREATE TRIGGER fail_run BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'disk failure'); END",
    ),
  );
  expect(() => storage.save(changed)).toThrow("disk failure");
  expect(storage.load()).toEqual(previous);
  inspect(path, (db) => db.exec("DROP TRIGGER fail_run"));
  storage.save(changed);
  storage.close();
  expect(open(path).load()).toEqual(changed);
});

test("directory, database and WAL files are private and dispose closes the handle", () => {
  const path = directory();
  chmodSync(path, 0o755);
  const storage = open(path);
  storage.save(state());
  if (process.platform !== "win32") {
    expect(statSync(path).mode & 0o777).toBe(0o700);
    for (const file of ["tasks.sqlite", "tasks.sqlite-wal", "tasks.sqlite-shm"])
      expect(statSync(join(path, file)).mode & 0o777).toBe(0o600);
  }
  storage.close();
  storage.close();
  expect(() => storage.load()).toThrow();
  expect(() => storage.save(empty())).toThrow();
  expect(open(path).load().tasks).toHaveLength(1);
});

test.each(["database", "wal", "hardlink"] as const)(
  "%s indirection is rejected without changing the target file",
  (target) => {
    if (process.platform === "win32") return;
    const path = directory();
    const outside = join(path, "outside");
    const contents = JSON.stringify(state());
    writeFileSync(outside, contents, { mode: 0o644 });
    const linked = join(
      path,
      target === "wal" ? "tasks.sqlite-wal" : "tasks.sqlite",
    );
    if (target === "hardlink") linkSync(outside, linked);
    else symlinkSync(outside, linked);
    expect(() => open(path)).toThrow();
    expect(readFileSync(outside, "utf8")).toBe(contents);
    expect(statSync(outside).mode & 0o777).toBe(0o644);
  },
);

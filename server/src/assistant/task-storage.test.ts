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
import type { AssistantMentionTarget } from "../../../shared/assistant";
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

function createVersionOne(path: string, saved: SavedTaskState) {
  const db = new Database(join(path, "tasks.sqlite"), { create: true });
  try {
    db.transaction(() => {
      db.exec(`
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
        PRAGMA user_version = 1;
      `);
      for (const [position, entry] of saved.tasks.entries()) {
        const { task, input, config, targets, workspaces } = entry;
        db.query(
          "INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
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
          const admission = ["queued", "running", "waiting"].includes(
            run.status,
          )
            ? {
                input: run.input,
                config: run.config,
                targets: run.targets,
                workspaces: run.workspaces,
              }
            : null;
          db.query(
            "INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ).run(
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
      for (const [
        position,
        { proposal, prepared },
      ] of saved.proposals.entries()) {
        const { id, status, created_at, task_id, ...input } = proposal;
        db.query("INSERT INTO proposals VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          id,
          position,
          status,
          created_at,
          task_id ?? null,
          JSON.stringify(input),
          JSON.stringify(prepared),
        );
      }
      for (const [position, request] of saved.requests.entries())
        db.query("INSERT INTO requests VALUES (?, ?, ?)").run(
          request.id,
          request.task_id,
          position,
        );
    }).immediate();
  } finally {
    db.close(true);
  }
}

function notification(saved: SavedTaskState) {
  return {
    event_key: "agent-completed",
    kind: "completed" as const,
    title: "Agent finished",
    body: "All requested work was verified successfully.",
    scope_key: "c".repeat(64),
    run_id: saved.tasks[0]!.runs[1]!.id,
    created_at: "2026-10-04T00:00:00.000Z",
  };
}

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
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
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

test("version one migrates every table and retains the default notification behavior", () => {
  const path = directory();
  const saved = state();
  saved.proposals[0]!.proposal.status = "confirmed";
  saved.proposals[0]!.proposal.task_id = saved.tasks[0]!.task.id;
  createVersionOne(path, saved);
  const storage = open(path);
  const loaded = storage.load();
  const expected = structuredClone(saved);
  const finished = expected.tasks[0]!.runs[1]!;
  delete finished.input;
  delete finished.config;
  delete finished.targets;
  delete finished.workspaces;
  expect(loaded).toEqual(expected);
  expect(loaded.tasks[0]!.notifications).toBeUndefined();
  inspect(path, (db) => {
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    expect(
      db.query("SELECT notification_mode, notifications FROM tasks").get(),
    ).toEqual({ notification_mode: null, notifications: "[]" });
  });
  loaded.tasks[0]!.input.notification_mode = "agent";
  loaded.tasks[0]!.notifications = [notification(saved)];
  storage.save(loaded);
  storage.close();
  expect(open(path).load()).toEqual(loaded);
});

test("agent mode and notification receipts survive reload and pruning their source run", () => {
  const path = directory();
  const saved = state();
  const entry = saved.tasks[0]!;
  entry.input.notification_mode = "agent";
  entry.runs[0]!.input!.notification_mode = "agent";
  entry.notifications = [notification(saved)];
  saved.proposals[0]!.prepared.input.notification_mode = "agent";
  saved.proposals[0]!.proposal.notification_mode = "agent";
  const storage = open(path);
  storage.save(saved);
  const loaded = storage.load();
  expect(loaded.tasks[0]!.input.notification_mode).toBe("agent");
  expect(loaded.tasks[0]!.runs[0]!.input!.notification_mode).toBe("agent");
  expect(loaded.tasks[0]!.notifications).toEqual(entry.notifications);
  expect(loaded.proposals).toEqual(saved.proposals);
  loaded.tasks[0]!.runs = [loaded.tasks[0]!.runs[0]!];
  storage.save(loaded);
  storage.close();
  expect(open(path).load()).toEqual(loaded);
  inspect(path, (db) =>
    expect(
      db.query("SELECT notification_mode, notifications FROM tasks").get(),
    ).toEqual({
      notification_mode: "agent",
      notifications: JSON.stringify(entry.notifications),
    }),
  );
});

test("version two retains existing plans, admissions, proposals and notifications during migration", () => {
  const path = directory();
  const saved = state();
  createVersionOne(path, saved);
  const receipt = notification(saved);
  inspect(path, (db) => {
    db.exec(`
      ALTER TABLE tasks ADD COLUMN notification_mode TEXT;
      ALTER TABLE tasks ADD COLUMN notifications TEXT NOT NULL DEFAULT '[]';
      PRAGMA user_version = 2;
    `);
    db.query("UPDATE tasks SET notification_mode = ?, notifications = ?").run(
      "agent",
      JSON.stringify([receipt]),
    );
  });
  const storage = open(path);
  const loaded = storage.load();
  expect(loaded.tasks[0]!.input).toEqual({
    ...saved.tasks[0]!.input,
    notification_mode: "agent",
  });
  expect(loaded.tasks[0]!.notifications).toEqual([receipt]);
  expect(loaded.tasks[0]!.runs[0]).toEqual(saved.tasks[0]!.runs[0]);
  expect(loaded.proposals).toEqual(saved.proposals);
  expect(loaded.requests).toEqual(saved.requests);
  inspect(path, (db) => {
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    expect(db.query("SELECT mentions FROM tasks").get()).toEqual({
      mentions: null,
    });
  });
  storage.close();
  expect(open(path).load()).toEqual(loaded);
});

test("mention bindings round trip tasks, proposals and admitted runs without keeping completed admissions", () => {
  const path = directory();
  const saved = state();
  const mentions: AssistantMentionTarget[] = [
    {
      kind: "agent",
      connection_id: "local",
      workspace_id: "workspace",
      connection_label: "Local",
      workspace_label: "Workspace",
      label: "Codex session",
      runtime_generation: 1,
      pane_id: "pane",
      terminal_id: "terminal",
      agent: "codex",
      agent_identity: "c".repeat(64),
    },
  ];
  saved.tasks[0]!.input.mentions = mentions;
  saved.tasks[0]!.runs[0]!.input!.mentions = structuredClone(mentions);
  saved.tasks[0]!.runs[1]!.input!.mentions = structuredClone(mentions);
  saved.proposals[0]!.prepared.input.mentions = structuredClone(mentions);
  saved.proposals[0]!.proposal.mentions = structuredClone(mentions);
  const storage = open(path);
  storage.save(saved);
  const loaded = storage.load();
  expect(loaded.tasks[0]!.input.mentions).toEqual(mentions);
  expect(loaded.tasks[0]!.runs[0]!.input!.mentions).toEqual(mentions);
  expect(loaded.tasks[0]!.runs[1]!.input).toBeUndefined();
  expect(loaded.proposals).toEqual(saved.proposals);
  inspect(path, (db) =>
    expect(db.query("SELECT mentions FROM tasks").get()).toEqual({
      mentions: JSON.stringify(mentions),
    }),
  );
  storage.close();
  expect(open(path).load()).toEqual(loaded);
});

test.each([undefined, "status"] as const)(
  "default notification mode %s retains its original optional shape",
  (mode) => {
    const path = directory();
    const saved = state();
    if (mode) saved.tasks[0]!.input.notification_mode = mode;
    const storage = open(path);
    storage.save(saved);
    expect(storage.load().tasks[0]!.input).toEqual(saved.tasks[0]!.input);
    expect(storage.load().tasks[0]!.notifications).toBeUndefined();
    inspect(path, (db) =>
      expect(db.query("SELECT notification_mode FROM tasks").get()).toEqual({
        notification_mode: mode ?? null,
      }),
    );
  },
);

test.each(["duplicate-column", "invalid-row", "missing-table"] as const)(
  "a version one %s failure rolls back the entire migration",
  (damage) => {
    const path = directory();
    createVersionOne(path, state());
    inspect(path, (db) =>
      db.exec(
        damage === "duplicate-column"
          ? "ALTER TABLE tasks ADD COLUMN notifications TEXT NOT NULL DEFAULT '[]'"
          : damage === "missing-table"
            ? "DROP TABLE requests"
            : "UPDATE runs SET admission = NULL WHERE status = 'running'",
      ),
    );
    const original = inspect(path, (db) => ({
      columns: db.query("PRAGMA table_info(tasks)").all(),
      tasks: db.query("SELECT * FROM tasks").all(),
      runs: db.query("SELECT * FROM runs").all(),
      proposals: db.query("SELECT * FROM proposals").all(),
    }));
    expect(() => open(path)).toThrow();
    inspect(path, (db) => {
      expect(db.query("PRAGMA user_version").get()).toEqual({
        user_version: 1,
      });
      expect({
        columns: db.query("PRAGMA table_info(tasks)").all(),
        tasks: db.query("SELECT * FROM tasks").all(),
        runs: db.query("SELECT * FROM runs").all(),
        proposals: db.query("SELECT * FROM proposals").all(),
      }).toEqual(original);
    });
  },
);

test("a separate SQLite process can read while the writer saves", async () => {
  const path = directory();
  const storage = open(path);
  const saved = state();
  storage.save(saved);
  const reader = `
    import { Database } from "bun:sqlite";
    let reading = true;
    let reads = 0;
    process.stdin.on("data", () => { reading = false; });
    console.log("ready");
    while (reading) {
      const db = new Database(process.argv[1], { readonly: true });
      try {
        const rows = db.transaction(() => ({
          tasks: db.query("SELECT id, status FROM tasks").all(),
          runs: db.query("SELECT task_id FROM runs").all(),
        }))();
        if (rows.tasks.length !== 1 || rows.runs.length !== 2 ||
            rows.runs.some(run => run.task_id !== rows.tasks[0].id))
          throw new Error("Inconsistent task receipt");
        reads++;
      } finally {
        db.close();
      }
      await new Promise(resolve => setImmediate(resolve));
    }
    console.log(reads);
  `;
  const observed = Bun.spawn(
    [process.execPath, "--eval", reader, join(path, "tasks.sqlite")],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 5_000 },
  );
  const stdout = observed.stdout.getReader();
  try {
    const ready = await stdout.read();
    expect(new TextDecoder().decode(ready.value)).toBe("ready\n");
    for (let index = 0; index < 200; index++) {
      saved.tasks[0]!.task.status = index % 2 ? "active" : "paused";
      storage.save(saved);
    }
    observed.stdin.write("stop\n");
    observed.stdin.end();
    const [exit, errors, reads] = await Promise.all([
      observed.exited,
      new Response(observed.stderr).text(),
      (async () => {
        let remaining = "";
        for (;;) {
          const next = await stdout.read();
          if (next.done) return remaining;
          remaining += new TextDecoder().decode(next.value);
        }
      })(),
    ]);
    expect(errors).toBe("");
    expect(exit).toBe(0);
    expect(Number(reads.trim())).toBeGreaterThan(0);
  } finally {
    observed.kill();
    await observed.exited;
    stdout.releaseLock();
  }
});

test("deleting every plan preserves an authoritative initialized empty database", () => {
  const path = directory();
  const storage = open(path);
  storage.save(state());
  storage.save(empty());
  storage.close();
  expect(open(path).load()).toEqual(empty());
  inspect(path, (db) =>
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 3 }),
  );
});

test.each([
  "corrupt",
  "uninitialized",
  "future-version",
  "invalid-row",
  "missing-table",
  "notification-mode",
  "notification-json",
  "notification-receipt",
  "mention-json",
  "mention-identity",
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
            ? "PRAGMA user_version = 4"
            : damage === "missing-table"
              ? "DROP TABLE requests"
              : damage === "notification-mode"
                ? "UPDATE tasks SET notification_mode = 'invalid'"
                : damage === "notification-json"
                  ? "UPDATE tasks SET notifications = 'not JSON'"
                  : damage === "notification-receipt"
                    ? "UPDATE tasks SET notifications = '[{}]'"
                    : damage === "mention-json"
                      ? "UPDATE tasks SET mentions = 'not JSON'"
                      : damage === "mention-identity"
                        ? "UPDATE tasks SET mentions = '[{}]'"
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

test.each(["mode", "receipt", "duplicate", "overflow"] as const)(
  "invalid notification %s cannot overwrite saved tasks",
  (defect) => {
    const path = directory();
    const saved = state();
    saved.tasks[0]!.input.notification_mode = "agent";
    saved.tasks[0]!.notifications = [notification(saved)];
    const storage = open(path);
    storage.save(saved);
    const original = storage.load();
    const changed = structuredClone(original);
    if (defect === "mode")
      (
        changed.tasks[0]!.input as { notification_mode: string }
      ).notification_mode = "invalid";
    else if (defect === "receipt")
      changed.tasks[0]!.notifications![0]!.run_id = "invalid";
    else if (defect === "duplicate")
      changed.tasks[0]!.notifications!.push(notification(saved));
    else
      changed.tasks[0]!.notifications = Array.from(
        { length: 101 },
        (_, index) => ({
          ...notification(saved),
          event_key: `completed-${index}`,
        }),
      );
    expect(() => storage.save(changed)).toThrow();
    expect(storage.load()).toEqual(original);
  },
);

test("notification bytes are bounded before materializing their JSON", () => {
  const path = directory();
  const storage = open(path);
  storage.save(state());
  storage.close();
  inspect(path, (db) =>
    db.exec("UPDATE tasks SET notifications = printf('%33000000s', '')"),
  );
  expect(() => open(path)).toThrow("Saved Ranger tasks are too large");
});

test("a failure after deleting old rows rolls back every table and can be retried", () => {
  const path = directory();
  const storage = open(path);
  storage.save(state());
  const previous = storage.load();
  const changed = structuredClone(previous);
  changed.tasks[0]!.task.status = "paused";
  changed.tasks[0]!.input.notification_mode = "agent";
  changed.tasks[0]!.notifications = [notification(previous)];
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
    for (const file of ["tasks.sqlite-wal", "tasks.sqlite-shm"])
      chmodSync(join(path, file), 0o644);
    storage.save(storage.load());
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

test.each([
  "database",
  "wal",
  "shm",
  "journal",
  "hardlink",
  "sidecar-hardlink",
] as const)(
  "%s indirection is rejected without changing the target file",
  (target) => {
    if (process.platform === "win32") return;
    const path = directory();
    const outside = join(path, "outside");
    const contents = JSON.stringify(state());
    writeFileSync(outside, contents, { mode: 0o644 });
    const linked = join(
      path,
      target === "sidecar-hardlink"
        ? "tasks.sqlite-shm"
        : ["wal", "shm", "journal"].includes(target)
          ? `tasks.sqlite-${target}`
          : "tasks.sqlite",
    );
    if (target.endsWith("hardlink")) linkSync(outside, linked);
    else symlinkSync(outside, linked);
    expect(() => open(path)).toThrow();
    expect(readFileSync(outside, "utf8")).toBe(contents);
    expect(statSync(outside).mode & 0o777).toBe(0o644);
  },
);

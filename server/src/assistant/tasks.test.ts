import { Database } from "bun:sqlite";
import { afterEach, expect, jest, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASSISTANT_MAX_WORKSPACES } from "../../../shared/assistant";
import type {
  AssistantNotificationInput,
  AssistantNotificationReceipt,
  AssistantSnapshot,
  AssistantTaskNotification,
} from "../../../shared/assistant";
import { AssistantRecoveryNotReadyError } from "./context";
import { openTaskStorage } from "./task-storage";
import {
  createAssistantTasks,
  type PreparedTask,
  type SavedTaskRun,
  type ScheduledChild,
  validateTaskInput,
  validateSavedTasks,
} from "./tasks";

const directories: string[] = [];
const managers: ReturnType<typeof createAssistantTasks>[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose();
  jest.useRealTimers();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
async function flush() {
  for (let index = 0; index < 30; index++) await Promise.resolve();
}

const customNotification = (
  event_key = "agent-work-1:completed",
): AssistantNotificationInput => ({
  event_key,
  kind: "completed",
  title: "Agent finished the requested work",
  body: "The tests passed. Open Ranger to review the evidence.",
});

async function startRun(f: ReturnType<typeof fixture>, taskId: string) {
  await f.manager.control("run_now", taskId);
  jest.advanceTimersByTime(0);
  await flush();
  return f.runs.at(-1)!;
}

test("custom task notifications persist before dispatch, deduplicate across runs and restart, and cap each run", async () => {
  jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
  let acceptedReceipt: AssistantNotificationReceipt[] = [];
  const f = fixture(undefined, undefined, () => {
    const storage = openTaskStorage(f.directory, validateSavedTasks);
    try {
      acceptedReceipt = storage.load().tasks[0]!.notifications ?? [];
    } finally {
      storage.close();
    }
  });
  const task = await f.manager.create(prepared(), randomUUID());
  await f.manager.resume();
  const first = await startRun(f, task.id);
  const accepted = await f.manager.notifyRun(
    task.id,
    first.run.id,
    customNotification(),
  );
  expect(JSON.parse(accepted.text)).toEqual({
    accepted: true,
    delivery: "best_effort",
  });
  expect(acceptedReceipt).toEqual([
    {
      ...customNotification(),
      scope_key: expect.stringMatching(/^[a-f0-9]{64}$/),
      run_id: first.run.id,
      created_at: expect.any(String),
    },
  ]);
  expect(Number.isFinite(Date.parse(acceptedReceipt[0]!.created_at))).toBe(
    true,
  );
  expect(f.notifications).toEqual([
    {
      task_id: task.id,
      run_id: first.run.id,
      status: "succeeded",
      title: customNotification().title,
      body: customNotification().body,
    },
  ]);
  expect(
    JSON.parse(
      (await f.manager.notifyRun(task.id, first.run.id, customNotification()))
        .text,
    ),
  ).toEqual({ accepted: false, reason: "already_notified" });
  expect(
    JSON.parse(
      (
        await f.manager.notifyRun(
          task.id,
          first.run.id,
          customNotification("another-event"),
        )
      ).text,
    ),
  ).toEqual({ accepted: false, reason: "run_limit" });
  first.complete();
  expect(f.notifications).toHaveLength(1);
  await f.manager.dispose();

  const restored = fixture(f.directory);
  await restored.manager.resume();
  const second = await startRun(restored, task.id);
  expect(
    JSON.parse(
      (
        await restored.manager.notifyRun(
          task.id,
          second.run.id,
          customNotification(),
        )
      ).text,
    ),
  ).toEqual({ accepted: false, reason: "already_notified" });
  const attention = {
    ...customNotification("agent-work-2:attention"),
    kind: "attention" as const,
  };
  expect(
    JSON.parse(
      (await restored.manager.notifyRun(task.id, second.run.id, attention))
        .text,
    ),
  ).toEqual({ accepted: true, delivery: "best_effort" });
  expect(restored.notifications).toEqual([
    {
      task_id: task.id,
      run_id: second.run.id,
      status: "waiting",
      title: attention.title,
      body: attention.body,
    },
  ]);
  const history = restored.manager.notificationHistory(task.id);
  expect(history).toHaveLength(2);
  history[0]!.event_key = "modified";
  expect(restored.manager.notificationHistory(task.id)[0]!.event_key).toBe(
    customNotification().event_key,
  );
});

test("agent notification mode keeps successful polls quiet and retains failure and confirmation alerts", async () => {
  jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
  const f = fixture();
  const input = prepared();
  input.input.notification_mode = "agent";
  const task = await f.manager.create(input, randomUUID());
  await f.manager.resume();
  const first = await startRun(f, task.id);
  input.input.notification_mode = "status";
  await f.manager.update(task.id, input);
  first.complete();
  expect(f.notifications).toEqual([]);
  const second = await startRun(f, task.id);
  second.complete();
  expect(f.notifications.map((notification) => notification.status)).toEqual([
    "succeeded",
  ]);
  input.input.notification_mode = "agent";
  await f.manager.update(task.id, input);
  const failed = await startRun(f, task.id);
  failed.complete(false, "Model unavailable");
  const waiting = await startRun(f, task.id);
  waiting.complete(true);
  expect(f.notifications.map((notification) => notification.status)).toEqual([
    "succeeded",
    "failed",
    "waiting",
  ]);
});

test("scope changes isolate notification history and event deduplication while a running task keeps its original scope", async () => {
  jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
  const f = fixture();
  const task = await f.manager.create(prepared(), randomUUID());
  await f.manager.resume();
  const first = await startRun(f, task.id);
  await f.manager.notifyRun(task.id, first.run.id, customNotification());
  const replacement = prepared();
  for (const refs of [
    replacement.input.scope,
    replacement.config.allowed_workspaces,
    replacement.workspaces,
    replacement.targets,
  ])
    refs[0]!.workspace_id = "other-workspace";
  replacement.targets[0]!.workspace_identity = "c".repeat(64);
  await f.manager.update(task.id, replacement);
  expect(f.manager.notificationHistory(task.id)).toEqual([]);
  expect(f.manager.notificationHistory(task.id, first.run.id)).toHaveLength(1);
  first.complete();
  const second = await startRun(f, task.id);
  const result = await f.manager.notifyRun(
    task.id,
    second.run.id,
    customNotification(),
  );
  expect(JSON.parse(result.text).accepted).toBe(true);
  expect(f.manager.notificationHistory(task.id, second.run.id)).toEqual(
    f.manager.notificationHistory(task.id),
  );
  expect(f.manager.notificationHistory(task.id)[0]!.run_id).toBe(second.run.id);
  expect(f.notifications).toHaveLength(2);
  await f.manager.dispose();
  const restored = fixture(f.directory);
  expect(restored.manager.notificationHistory(task.id)).toHaveLength(1);
});

test("notification history retains the latest 100 events independently of pruned runs", async () => {
  jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
  const f = fixture();
  const task = await f.manager.create(prepared(), randomUUID());
  await f.manager.resume();
  for (let index = 0; index < 101; index++) {
    const run = await startRun(f, task.id);
    await f.manager.notifyRun(
      task.id,
      run.run.id,
      customNotification(`work-${index}`),
    );
    run.complete();
    await flush();
  }
  expect(f.manager.detail(task.id).runs).toHaveLength(20);
  const history = f.manager.notificationHistory(task.id);
  expect(history).toHaveLength(100);
  expect(history[0]!.event_key).toBe("work-1");
  expect(history.at(-1)!.event_key).toBe("work-100");
  await f.manager.dispose();
  expect(fixture(f.directory).manager.notificationHistory(task.id)).toEqual(
    history,
  );
});

test("custom notification save failures do not emit and delivery failures keep a non-replayable receipt", async () => {
  jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
  const f = fixture(undefined, undefined, () => {
    throw new Error("Delivery failed");
  });
  const task = await f.manager.create(prepared(), randomUUID());
  await f.manager.resume();
  const run = await startRun(f, task.id);
  f.fail(true);
  await expect(
    f.manager.notifyRun(task.id, run.run.id, customNotification()),
  ).rejects.toThrow("could not be saved");
  expect(f.notifications).toEqual([]);
  expect(f.manager.notificationHistory(task.id)).toEqual([]);
  f.fail(false);
  const result = await f.manager.notifyRun(
    task.id,
    run.run.id,
    customNotification(),
  );
  expect(JSON.parse(result.text)).toEqual({
    accepted: true,
    delivery: "best_effort",
  });
  expect(f.notifications).toHaveLength(1);
  expect(f.manager.notificationHistory(task.id)).toHaveLength(1);
  expect(
    JSON.parse(
      (await f.manager.notifyRun(task.id, run.run.id, customNotification()))
        .text,
    ),
  ).toEqual({ accepted: false, reason: "already_notified" });
});

test.each(["stop", "cancel", "revoke", "complete", "abort"] as const)(
  "%s during a notification permission check cannot emit an alert",
  async (operation) => {
    jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
    let block = false;
    let revoked = false;
    const began = Promise.withResolvers<void>();
    const checked = Promise.withResolvers<void>();
    const f = fixture(undefined, async () => {
      if (!block) return;
      began.resolve();
      await checked.promise;
      if (revoked) throw new Error("Permission revoked");
    });
    const task = await f.manager.create(prepared(), randomUUID());
    await f.manager.resume();
    const run = await startRun(f, task.id);
    block = true;
    const abort = new AbortController();
    const sending = f.manager
      .notifyRun(task.id, run.run.id, customNotification(), abort.signal)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await began.promise;
    if (operation === "stop" || operation === "cancel")
      await f.manager.control(operation, task.id);
    else if (operation === "complete") run.complete();
    else if (operation === "abort") abort.abort();
    else revoked = true;
    checked.resolve();
    expect(await sending).toBeInstanceOf(Error);
    expect(f.manager.notificationHistory(task.id)).toEqual([]);
    expect(
      f.notifications.filter(
        (notification) => notification.title === customNotification().title,
      ),
    ).toEqual([]);
  },
);

test("task inputs and saved notification history reject invalid modes and receipts", () => {
  const input = prepared().input;
  expect(validateTaskInput(input)).toEqual(input);
  expect(
    validateTaskInput({ ...input, notification_mode: "agent" })
      .notification_mode,
  ).toBe("agent");
  expect(() =>
    validateTaskInput({ ...input, notification_mode: "quiet" }),
  ).toThrow("Invalid task input");
  const now = "2026-10-04T00:00:00.000Z";
  const notification = {
    ...customNotification(),
    scope_key: "a".repeat(64),
    run_id: randomUUID(),
    created_at: now,
  };
  const saved = {
    tasks: [
      {
        ...prepared(),
        task: {
          id: randomUUID(),
          status: "active" as const,
          created_at: now,
          updated_at: now,
          next_run_at: now,
        },
        runs: [],
        notifications: [notification],
      },
    ],
    proposals: [],
    requests: [],
  };
  expect(validateSavedTasks(saved)).toEqual(saved);
  for (const invalid of [
    { ...notification, event_key: " " },
    { ...notification, event_key: "x".repeat(201) },
    { ...notification, title: "x".repeat(201) },
    { ...notification, body: "" },
    { ...notification, body: "x".repeat(401) },
    { ...notification, kind: "failed" },
    { ...notification, run_id: "invalid" },
    { ...notification, created_at: "invalid" },
    { ...notification, scope_key: "invalid" },
  ]) {
    expect(() =>
      validateSavedTasks({
        ...saved,
        tasks: [{ ...saved.tasks[0]!, notifications: [invalid] }],
      }),
    ).toThrow("Invalid saved tasks");
  }
  expect(() =>
    validateSavedTasks({
      ...saved,
      tasks: [
        { ...saved.tasks[0]!, notifications: [notification, notification] },
      ],
    }),
  ).toThrow("Invalid saved tasks");
  expect(() =>
    validateSavedTasks({
      ...saved,
      tasks: [
        {
          ...saved.tasks[0]!,
          notifications: Array.from({ length: 101 }, (_, index) => ({
            ...notification,
            event_key: String(index),
          })),
        },
      ],
    }),
  ).toThrow("Invalid saved tasks");
});

test("saved task proposals validate their displayed input against the confirmed input with status as the default mode", () => {
  const input = prepared();
  const proposal = {
    ...input.input,
    id: randomUUID(),
    status: "pending" as const,
    created_at: "2026-10-04T00:00:00.000Z",
  };
  const saved = {
    tasks: [],
    proposals: [{ prepared: input, proposal }],
    requests: [],
  };
  expect(validateSavedTasks(saved)).toEqual(saved);
  for (const explicitDefault of [
    {
      prepared: input,
      proposal: { ...proposal, notification_mode: "status" as const },
    },
    {
      prepared: {
        ...input,
        input: { ...input.input, notification_mode: "status" as const },
      },
      proposal,
    },
    {
      prepared: {
        ...input,
        input: { ...input.input, notification_mode: "agent" as const },
      },
      proposal: { ...proposal, notification_mode: "agent" as const },
    },
  ])
    expect(
      validateSavedTasks({ ...saved, proposals: [explicitDefault] }).proposals,
    ).toEqual([explicitDefault]);
  for (const changes of [
    { notification_mode: "invalid" },
    { notification_mode: "agent" },
    { title: "Another title" },
    { prompt: "Another prompt" },
    { scope: [{ connection_id: "local", workspace_id: "another-workspace" }] },
    { schedule: { type: "interval", minutes: 2 } },
    { title: "" },
    { scope: [] },
  ])
    expect(() =>
      validateSavedTasks({
        ...saved,
        proposals: [{ prepared: input, proposal: { ...proposal, ...changes } }],
      }),
    ).toThrow("Invalid saved tasks");
  expect(() =>
    validateSavedTasks({
      ...saved,
      proposals: [
        {
          prepared: {
            ...input,
            input: { ...input.input, notification_mode: "agent" },
          },
          proposal,
        },
      ],
    }),
  ).toThrow("Invalid saved tasks");
});
const prepared = (
  schedule: PreparedTask["input"]["schedule"] = {
    type: "interval",
    minutes: 1,
  },
): PreparedTask => ({
  input: {
    title: "Check workspace",
    prompt: "Report verified progress",
    scope: [{ connection_id: "local", workspace_id: "workspace" }],
    schedule,
  },
  config: {
    provider: "test",
    model: "model",
    credential_source: "assistant",
    allowed_workspaces: [{ connection_id: "local", workspace_id: "workspace" }],
  },
  workspaces: [
    {
      connection_id: "local",
      workspace_id: "workspace",
      connection_label: "Local",
      label: "Workspace",
      runtime_generation: 1,
    },
  ],
  targets: [
    {
      connection_id: "local",
      workspace_id: "workspace",
      endpoint_fingerprint: "a".repeat(64),
      workspace_identity: "b".repeat(64),
      herdr_boot_id: "original-server",
    },
  ],
});
function fixture(
  existing?: string,
  validation?: (
    signal: AbortSignal | undefined,
    prepared: PreparedTask,
  ) => Promise<void>,
  notify?: (notification: AssistantTaskNotification) => void,
) {
  const directory = existing ?? mkdtempSync(join(tmpdir(), "roamgate-tasks-"));
  if (!existing) directories.push(directory);
  const runs: {
    run: SavedTaskRun;
    directory: string;
    recover?: boolean;
    resumes: number;
    stopped: boolean;
    disposing: boolean;
    disposed: boolean;
    stopGate?: ReturnType<typeof Promise.withResolvers<void>>;
    disposeGate?: ReturnType<typeof Promise.withResolvers<void>>;
    complete(pending?: boolean, error?: string | null): void;
  }[] = [];
  let deny = false;
  let startFailure = false;
  const notifications: AssistantTaskNotification[] = [];
  const manager = createAssistantTasks({
    directory,
    publish: () => {},
    notify: (notification) => {
      notifications.push(notification);
      notify?.(notification);
    },
    validate: async (_prepared, signal) => {
      if (deny) throw new Error("Original identity replaced");
      await validation?.(signal, _prepared);
    },
    child: (run, path, publish) => {
      const snapshot: AssistantSnapshot = {
        instance_id: "child",
        revision: 0,
        config: run.config,
        providers: [],
        models: [],
        messages: [],
        running: false,
        auth: null,
        error: null,
      };
      const observed = {
        run,
        directory: path,
        recover: undefined as boolean | undefined,
        resumes: 0,
        stopped: false,
        disposing: false,
        disposed: false,
        stopGate: undefined as
          | ReturnType<typeof Promise.withResolvers<void>>
          | undefined,
        disposeGate: undefined as
          | ReturnType<typeof Promise.withResolvers<void>>
          | undefined,
        complete(pending = false, error: string | null = null) {
          snapshot.running = false;
          snapshot.error = error;
          snapshot.messages = [
            {
              id: "answer",
              role: "assistant",
              text: "Verified",
              sent_at: new Date().toISOString(),
              tools: [],
              sources: [],
              actions: pending
                ? [
                    {
                      ...run.workspaces[0]!,
                      workspace_label: "Workspace",
                      id: "action",
                      kind: "send_prompt",
                      status: "pending",
                      created_at: new Date().toISOString(),
                      params: {},
                      summary: "Review",
                      detail: "Waiting",
                    },
                  ]
                : [],
            },
          ];
          publish(snapshot);
        },
      };
      runs.push(observed);
      const child: ScheduledChild = {
        start: async (recover) => {
          observed.recover = recover;
          const db = new Database(join(directory, "tasks.sqlite"), {
            readonly: true,
          });
          try {
            expect(
              db
                .query<{ status: string }, [string]>(
                  "SELECT status FROM runs WHERE id = ?",
                )
                .get(run.id)?.status,
            ).toBe("running");
          } finally {
            db.close();
          }
          if (startFailure) throw new Error("Private child startup error");
          snapshot.running = true;
          publish(snapshot);
        },
        resume: async () => {
          observed.resumes++;
        },
        stop: async () => {
          await observed.stopGate?.promise;
          observed.stopped = true;
          snapshot.running = false;
          publish(snapshot);
        },
        action: async () => {
          for (const message of snapshot.messages)
            for (const action of message.actions ?? [])
              action.status = "cancelled";
          publish(snapshot);
        },
        snapshot: () => structuredClone(snapshot),
        dispose: async () => {
          observed.disposing = true;
          await observed.disposeGate?.promise;
          observed.disposed = true;
        },
      };
      return child;
    },
  });
  managers.push(manager);
  return {
    directory,
    manager,
    runs,
    notifications,
    fail: (value: boolean) => {
      const db = new Database(join(directory, "tasks.sqlite"));
      try {
        db.exec(
          value
            ? "CREATE TRIGGER fail_save BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT, 'Synthetic write failure'); END"
            : "DROP TRIGGER fail_save",
        );
      } finally {
        db.close();
      }
    },
    deny: (value: boolean) => {
      deny = value;
    },
    failStart: () => {
      startFailure = true;
    },
  };
}

test("task notifications describe persisted transitions once with the original run title", async () => {
  jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
  const f = fixture();
  const input = prepared();
  const task = await f.manager.create(input, randomUUID());
  await f.manager.resume();
  await f.manager.control("run_now", task.id);
  jest.advanceTimersByTime(0);
  await flush();
  expect(f.notifications).toEqual([]);
  input.input.title = "Edited task title";
  await f.manager.update(task.id, input);
  const child = f.runs[0]!;
  child.complete(true);
  child.complete(true);
  await f.manager.control("pause", task.id);
  expect(f.notifications).toEqual([
    {
      task_id: task.id,
      run_id: child.run.id,
      status: "waiting",
      title: "Ranger task needs confirmation",
      body: "Check workspace: needs your confirmation. Open Ranger to review the pending action.",
    },
  ]);
  child.complete();
  child.complete();
  expect(f.notifications[1]).toEqual({
    task_id: task.id,
    run_id: child.run.id,
    status: "succeeded",
    title: "Ranger task completed",
    body: "Check workspace: completed successfully.",
  });
  expect(f.notifications).toHaveLength(2);
  await f.manager.control("run_now", task.id);
  jest.advanceTimersByTime(0);
  await flush();
  const failed = f.runs[1]!;
  failed.complete(false, "Private model error and prompt");
  expect(f.notifications[2]).toEqual({
    task_id: task.id,
    run_id: failed.run.id,
    status: "failed",
    title: "Ranger task failed",
    body: "Edited task title: failed. Open Ranger to review the task.",
  });
  expect(f.notifications).toHaveLength(3);
});

test.each(["admission", "child"] as const)(
  "%s startup failures notify after saving a failed receipt",
  async (failure) => {
    jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
    const f = fixture();
    const task = await f.manager.create(prepared(), randomUUID());
    await f.manager.resume();
    await f.manager.control("run_now", task.id);
    if (failure === "admission") f.deny(true);
    else f.failStart();
    jest.advanceTimersByTime(0);
    await flush();
    const run = f.manager.detail(task.id).runs[0]!;
    expect(run.status).toBe("failed");
    expect(f.notifications).toEqual([
      {
        task_id: task.id,
        run_id: run.id,
        status: "failed",
        title: "Ranger task failed",
        body: "Check workspace: failed. Open Ranger to review the task.",
      },
    ]);
    const restored = fixture(f.directory);
    await restored.manager.resume();
    expect(restored.notifications).toEqual([]);
  },
);

test("notification delivery errors do not change a saved task outcome", async () => {
  jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
  const f = fixture(undefined, undefined, () => {
    throw new Error("Notification delivery failed");
  });
  const task = await f.manager.create(prepared(), randomUUID());
  await f.manager.resume();
  await f.manager.control("run_now", task.id);
  jest.advanceTimersByTime(0);
  await flush();
  f.runs[0]!.complete();
  expect(f.manager.detail(task.id).runs[0]!.status).toBe("succeeded");
  expect(f.manager.error()).toBeNull();
  expect(f.notifications).toHaveLength(1);
  await f.manager.control("run_now", task.id);
  jest.advanceTimersByTime(0);
  await flush();
  expect(f.runs).toHaveLength(2);
});

test("once admission is durable, immutable and isolated; restart keeps one original run", async () => {
  jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
  const f = fixture();
  const input = prepared({ type: "once", at: "2026-10-04T00:01:00.000Z" });
  const request = randomUUID();
  const task = await f.manager.create(input, request);
  input.input.prompt = "Changed after creation";
  await f.manager.resume();
  jest.advanceTimersByTime(60_000);
  await flush();
  expect(f.runs).toHaveLength(1);
  expect(f.runs[0]!.run.input.prompt).toBe("Report verified progress");
  expect(f.runs[0]!.directory).toBe(
    join(f.directory, "tasks", task.id, "runs", f.runs[0]!.run.id),
  );
  expect(f.manager.summaries()[0]!.next_run_at).toBeNull();
  const original = f.runs[0]!.run;
  await f.manager.dispose();
  expect(f.runs[0]!.stopped).toBe(false);
  const restored = fixture(f.directory);
  await restored.manager.resume();
  await flush();
  expect(restored.runs).toHaveLength(1);
  expect(restored.runs[0]!.recover).toBe(true);
  expect(restored.runs[0]!.run).toEqual({
    ...original,
    status: "running",
    started_at: "2026-10-04T00:01:00.000Z",
  });
  restored.runs[0]!.complete();
  await flush();
  expect(restored.manager.summaries()[0]!.last_run?.status).toBe("succeeded");
  expect((await restored.manager.create(prepared(), request)).id).toBe(task.id);
  jest.advanceTimersByTime(600_000);
  await flush();
  expect(restored.runs).toHaveLength(1);
});

test.each(["succeeded", "failed", "stopped", "running", "waiting"] as const)(
  "metadata edits do not replay a consumed one-time task with a %s run",
  async (status) => {
    jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
    const f = fixture();
    const input = prepared({ type: "once", at: "2026-10-04T00:01:00.000Z" });
    const task = await f.manager.create(input, randomUUID());
    await f.manager.resume();
    jest.advanceTimersByTime(60_000);
    await flush();
    const original = f.runs[0]!;
    if (status === "stopped") await f.manager.control("stop", task.id);
    else if (status !== "running")
      original.complete(
        status === "waiting",
        status === "failed" ? "Failed" : null,
      );
    expect(f.manager.detail(task.id).runs[0]!.status).toBe(status);

    input.input.title = "Renamed task";
    input.input.prompt = "Updated instructions";
    input.input.notification_mode = "agent";
    input.config.model = "another-model";
    for (const refs of [
      input.input.scope,
      input.config.allowed_workspaces,
      input.workspaces,
      input.targets,
    ])
      refs[0]!.workspace_id = "another-workspace";
    // Equivalent timestamp spelling must also preserve consumed state.
    input.input.schedule = { at: "2026-10-04T00:01:00Z", type: "once" };
    await f.manager.update(task.id, input);
    expect(f.manager.detail(task.id).task.next_run_at).toBeNull();
    expect(original.run.input.title).toBe("Check workspace");
    if (status === "running" || status === "waiting") original.complete();
    jest.advanceTimersByTime(600_000);
    await flush();
    expect(f.runs).toHaveLength(1);
    await f.manager.dispose();
    const restored = fixture(f.directory);
    await restored.manager.resume();
    await flush();
    expect(restored.runs).toHaveLength(0);
    expect(restored.manager.detail(task.id).task.next_run_at).toBeNull();
    expect(restored.manager.detail(task.id).task.title).toBe("Renamed task");
  },
);

test.each(["interval", "daily"] as const)(
  "metadata edits preserve %s cadence, including an overdue paused deadline",
  async (type) => {
    jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
    const f = fixture();
    const input = prepared(
      type === "interval"
        ? { type, minutes: 2 }
        : { type, time: "00:02", timezone: "Etc/UTC" },
    );
    const task = await f.manager.create(input, randomUUID());
    await f.manager.resume();
    jest.advanceTimersByTime(30_000);
    input.input.title = "Renamed before deadline";
    input.input.schedule =
      type === "interval"
        ? { minutes: 2, type }
        : { timezone: "UTC", time: "00:02", type };
    await f.manager.update(task.id, input);
    expect(f.manager.detail(task.id).task.next_run_at).toBe(
      "2026-10-04T00:02:00.000Z",
    );
    await f.manager.control("pause", task.id);
    jest.advanceTimersByTime(180_000);
    input.input.prompt = "Updated after deadline";
    await f.manager.update(task.id, input);
    expect(f.manager.detail(task.id).task.next_run_at).toBe(
      "2026-10-04T00:02:00.000Z",
    );
    await f.manager.control("resume", task.id);
    jest.advanceTimersByTime(0);
    await flush();
    expect(f.runs).toHaveLength(1);
    expect(f.runs[0]!.run.scheduled_at).toBe("2026-10-04T00:02:00.000Z");
    expect(f.manager.detail(task.id).task.next_run_at).toBe(
      type === "interval"
        ? "2026-10-04T00:04:00.000Z"
        : "2026-10-05T00:02:00.000Z",
    );
  },
);

test.each(["once", "interval"] as const)(
  "metadata edits retain a coalesced %s occurrence while schedule changes replace it",
  async (type) => {
    jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
    const f = fixture();
    const input = prepared(
      type === "once"
        ? { type, at: "2026-10-04T00:01:00.000Z" }
        : { type, minutes: 1 },
    );
    const task = await f.manager.create(input, randomUUID());
    await f.manager.resume();
    const manual = await startRun(f, task.id);
    jest.advanceTimersByTime(60_000);
    await flush();
    const next = f.manager.detail(task.id).task.next_run_at;
    input.input.title = "Updated while due";
    await f.manager.update(task.id, input);
    expect(f.manager.detail(task.id).task.next_run_at).toBe(next);
    manual.complete();
    jest.advanceTimersByTime(0);
    await flush();
    expect(f.runs).toHaveLength(2);
    expect(f.runs[1]!.run).toMatchObject({
      manual: false,
      scheduled_at: "2026-10-04T00:01:00.000Z",
    });
    expect(f.runs[1]!.run.input.title).toBe(input.input.title);

    jest.advanceTimersByTime(60_000);
    await flush();
    input.input.schedule =
      type === "once"
        ? { type, at: "2026-10-04T00:05:00.000Z" }
        : { type, minutes: 3 };
    const changedDeadline =
      type === "once"
        ? "2026-10-04T00:05:00.000Z"
        : new Date(Date.now() + 180_000).toISOString();
    await f.manager.update(task.id, input);
    expect(f.manager.detail(task.id).task.next_run_at).toBe(changedDeadline);
    f.runs[1]!.complete();
    jest.advanceTimersByTime(0);
    await flush();
    expect(f.runs).toHaveLength(2);
    jest.advanceTimersByTime(Date.parse(changedDeadline) - Date.now());
    await flush();
    expect(f.runs).toHaveLength(3);
    expect(f.runs[2]!.run.scheduled_at).toBe(changedDeadline);
  },
);

test.each([
  { restart: false, safety: "ready" },
  { restart: true, safety: "ready" },
  { restart: false, safety: "revoked" },
  { restart: true, safety: "revoked" },
  { restart: false, safety: "disconnected" },
  { restart: true, safety: "disconnected" },
])(
  "failed manual admission drains a due one-time task with fresh validation: %j",
  async ({ restart, safety }) => {
    jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
    const admission = Promise.withResolvers<void>();
    let mode = "ready";
    let checks = 0;
    const validate = async () => {
      checks++;
      if (mode === "blocked") await admission.promise;
      if (mode === "revoked") throw new Error("Workspace permission revoked");
      if (mode === "disconnected")
        throw new AssistantRecoveryNotReadyError("Connection unavailable");
    };
    let f = fixture(undefined, validate);
    const task = await f.manager.create(
      prepared({ type: "once", at: "2026-10-04T00:01:00.000Z" }),
      randomUUID(),
    );
    await f.manager.resume();
    await f.manager.control("run_now", task.id);
    mode = "blocked";
    jest.advanceTimersByTime(0);
    await flush();
    const manual = f.manager.detail(task.id).runs[0]!;
    jest.advanceTimersByTime(60_000);
    await flush();
    expect(f.manager.detail(task.id).task.next_run_at).toBeNull();
    mode = safety;
    admission.reject(new Error("Transient provider catalog failure"));
    await flush();
    expect(f.manager.detail(task.id).runs[0]!.status).toBe("failed");
    expect(f.runs).toHaveLength(0);
    const checksBeforeDrain = checks;
    if (restart) {
      await f.manager.dispose();
      f = fixture(f.directory, validate);
      await f.manager.resume();
    } else jest.advanceTimersByTime(0);
    await flush();
    expect(checks).toBe(checksBeforeDrain + 1);
    const drained = f.manager.detail(task.id).runs[0]!;
    expect(drained.id).not.toBe(manual.id);
    expect(drained.scheduled_at).toBe("2026-10-04T00:01:00.000Z");
    expect(f.manager.detail(task.id).runs).toHaveLength(2);
    if (safety === "disconnected") {
      expect(drained.status).toBe("queued");
      expect(f.runs).toHaveLength(0);
      jest.advanceTimersByTime(4_999);
      await flush();
      expect(checks).toBe(checksBeforeDrain + 1);
      jest.advanceTimersByTime(1);
      await flush();
      expect(checks).toBe(checksBeforeDrain + 2);
      mode = "ready";
      await f.manager.resume();
      await flush();
      expect(f.runs[0]!.run.id).toBe(drained.id);
    }
    if (safety === "revoked") {
      expect(drained.status).toBe("failed");
      expect(f.runs).toHaveLength(0);
    } else {
      expect(f.runs).toHaveLength(1);
      expect(f.runs[0]!.run.manual).toBe(false);
      expect(f.runs[0]!.recover).toBe(false);
      f.runs[0]!.complete();
    }
    const finalChecks = checks;
    jest.advanceTimersByTime(600_000);
    await flush();
    await f.manager.resume();
    expect(checks).toBe(finalChecks);
    expect(f.manager.detail(task.id).runs).toHaveLength(2);
    await f.manager.dispose();
    const restored = fixture(f.directory, validate);
    await restored.manager.resume();
    await flush();
    expect(restored.runs).toHaveLength(0);
    expect(checks).toBe(finalChecks);
  },
);

test("restart drains the oldest stranded interval once before newer missed deadlines", async () => {
  jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
  const admission = Promise.withResolvers<void>();
  let blocked = false;
  const f = fixture(undefined, async () => {
    if (blocked) await admission.promise;
  });
  const task = await f.manager.create(prepared(), randomUUID());
  await f.manager.resume();
  await f.manager.control("run_now", task.id);
  blocked = true;
  jest.advanceTimersByTime(0);
  await flush();
  jest.advanceTimersByTime(60_000);
  await flush();
  admission.reject(new Error("Transient catalog failure"));
  await flush();
  await f.manager.dispose();
  jest.advanceTimersByTime(150_000);
  const restored = fixture(f.directory);
  await restored.manager.resume();
  await flush();
  expect(restored.runs).toHaveLength(1);
  expect(restored.runs[0]!.run.scheduled_at).toBe("2026-10-04T00:01:00.000Z");
  expect(restored.manager.detail(task.id).task.next_run_at).toBe(
    "2026-10-04T00:04:00.000Z",
  );
  restored.runs[0]!.complete();
  jest.advanceTimersByTime(0);
  await flush();
  expect(restored.runs).toHaveLength(1);
  jest.advanceTimersByTime(Date.parse("2026-10-04T00:04:00.000Z") - Date.now());
  await flush();
  expect(restored.runs).toHaveLength(2);
  expect(restored.runs[1]!.run.scheduled_at).toBe("2026-10-04T00:04:00.000Z");
});

test("one model slot coalesces missed intervals and waiting previews release the slot", async () => {
  jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
  const f = fixture();
  const first = await f.manager.create(prepared(), randomUUID());
  const second = await f.manager.create(
    prepared({ type: "once", at: "2026-10-04T00:01:00.000Z" }),
    randomUUID(),
  );
  await f.manager.resume();
  jest.advanceTimersByTime(60_000);
  await flush();
  expect(f.runs).toHaveLength(1);
  expect(
    f.manager
      .summaries()
      .filter((task) => task.current_run?.status === "queued"),
  ).toHaveLength(1);
  jest.advanceTimersByTime(600_000);
  await flush();
  expect(f.runs).toHaveLength(1);
  const running = f.runs[0]!;
  running.complete(true);
  await flush();
  expect(f.manager.detail(running.run.task_id).task.current_run?.status).toBe(
    "waiting",
  );
  jest.advanceTimersByTime(0);
  await flush();
  expect(f.runs).toHaveLength(2);
  const waitingTask = running.run.task_id;
  await f.manager.action("cancel", waitingTask, running.run.id, "action");
  await flush();
  expect(f.manager.detail(waitingTask).runs[0]!.status).toBe("succeeded");
  expect(f.manager.detail(first.id).task.next_run_at).toBe(
    "2026-10-04T00:12:00.000Z",
  );
  expect(f.manager.detail(second.id).task.next_run_at).toBeNull();
});

test.each(["interval", "once"] as const)(
  "restart expires a waiting preview and starts its coalesced %s occurrence once",
  async (schedule) => {
    jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
    const f = fixture();
    const task = await f.manager.create(
      schedule === "interval"
        ? prepared()
        : prepared({ type: "once", at: "2026-10-04T00:01:00.000Z" }),
      randomUUID(),
    );
    await f.manager.resume();
    if (schedule === "once") await f.manager.control("run_now", task.id);
    jest.advanceTimersByTime(schedule === "interval" ? 60_000 : 0);
    await flush();
    const expiredId = f.runs[0]!.run.id;
    f.runs[0]!.complete(true);
    await flush();
    jest.advanceTimersByTime(60_000);
    await flush();
    const scheduledAt =
      schedule === "interval"
        ? "2026-10-04T00:02:00.000Z"
        : "2026-10-04T00:01:00.000Z";
    const nextRunAt = f.manager.detail(task.id).task.next_run_at;
    expect(f.manager.detail(task.id).task.current_run?.status).toBe("waiting");
    await f.manager.dispose();

    const restored = fixture(f.directory);
    await restored.manager.resume();
    await flush();
    expect(
      restored.manager.detail(task.id).runs.find((run) => run.id === expiredId),
    ).toMatchObject({
      status: "failed",
      error: expect.stringContaining("previews expired"),
    });
    expect(restored.runs).toHaveLength(1);
    expect(restored.runs[0]!.run).toMatchObject({
      status: "running",
      scheduled_at: scheduledAt,
      manual: false,
    });
    expect(restored.runs[0]!.run.id).not.toBe(expiredId);
    expect(restored.notifications).toEqual([
      {
        task_id: task.id,
        run_id: expiredId,
        status: "failed",
        title: "Ranger task failed",
        body: "Check workspace: failed. Open Ranger to review the task.",
      },
    ]);
    expect(restored.runs[0]!.recover).toBe(false);
    expect(restored.manager.detail(task.id).task.next_run_at).toBe(nextRunAt);
    restored.runs[0]!.complete();
    await flush();
    jest.advanceTimersByTime(0);
    await flush();
    expect(restored.runs).toHaveLength(1);
    await restored.manager.dispose();

    const restarted = fixture(f.directory);
    await restarted.manager.resume();
    await flush();
    expect(restarted.runs).toHaveLength(0);
    expect(restarted.notifications).toEqual([]);
    expect(
      restarted.manager.detail(task.id).runs.map((run) => run.status),
    ).toEqual(["succeeded", "failed"]);
    expect(restarted.manager.detail(task.id).task.next_run_at).toBe(nextRunAt);
    jest.advanceTimersByTime(60_000);
    await flush();
    expect(restarted.runs).toHaveLength(schedule === "interval" ? 1 : 0);
    if (schedule === "interval")
      expect(restarted.runs[0]!.run.scheduled_at).toBe(nextRunAt!);
  },
);

test("restart expires a paused task preview without restarting its coalesced occurrence", async () => {
  jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
  const f = fixture();
  const task = await f.manager.create(prepared(), randomUUID());
  await f.manager.resume();
  await f.manager.control("run_now", task.id);
  jest.advanceTimersByTime(0);
  await flush();
  f.runs[0]!.complete(true);
  await flush();
  jest.advanceTimersByTime(60_000);
  await flush();
  await f.manager.control("pause", task.id);
  const nextRunAt = f.manager.detail(task.id).task.next_run_at;
  await f.manager.dispose();

  const restored = fixture(f.directory);
  await restored.manager.resume();
  jest.advanceTimersByTime(60_000);
  await flush();
  expect(restored.runs).toHaveLength(0);
  expect(restored.manager.detail(task.id).task).toMatchObject({
    status: "paused",
    next_run_at: nextRunAt,
    current_run: undefined,
  });
  expect(
    restored.manager.detail(task.id).runs.map((run) => run.status),
  ).toEqual(["failed"]);
});

test.each([false, true])(
  "queued Run now preserves a due one-time run (restart: %s)",
  async (restart) => {
    jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
    let f = fixture();
    const blocker = await f.manager.create(
      prepared({ type: "once", at: "2026-10-04T01:00:00.000Z" }),
      randomUUID(),
    );
    const task = await f.manager.create(
      prepared({ type: "once", at: "2026-10-04T00:01:00.000Z" }),
      randomUUID(),
    );
    await f.manager.resume();
    await f.manager.control("run_now", blocker.id);
    jest.advanceTimersByTime(0);
    await flush();
    expect(f.runs).toHaveLength(1);
    await f.manager.control("run_now", task.id);
    jest.advanceTimersByTime(60_000);
    await flush();
    jest.advanceTimersByTime(0);
    await flush();
    expect(f.manager.detail(task.id).task.next_run_at).toBeNull();
    expect(f.manager.detail(task.id).task.current_run?.status).toBe("queued");

    if (restart) {
      await f.manager.dispose();
      f = fixture(f.directory);
      await f.manager.resume();
      await flush();
      expect(f.runs[0]!.recover).toBe(true);
    }
    f.runs[0]!.complete();
    await flush();
    jest.advanceTimersByTime(0);
    await flush();
    expect(f.runs).toHaveLength(2);
    expect(f.runs[1]!.run.manual).toBe(true);
    expect(f.runs[1]!.run.task_id).toBe(task.id);
    f.runs[1]!.complete();
    await flush();
    jest.advanceTimersByTime(0);
    await flush();
    expect(f.runs).toHaveLength(3);
    expect(f.runs[2]!.run.manual).toBe(false);
    expect(f.runs[2]!.run.task_id).toBe(task.id);
    expect(f.runs[2]!.run.scheduled_at).toBe("2026-10-04T00:01:00.000Z");
    f.runs[2]!.complete();
    await flush();
    jest.advanceTimersByTime(300_000);
    await flush();
    expect(f.runs).toHaveLength(3);
    expect(f.manager.detail(task.id).runs.map((run) => run.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
  },
);

test("pause preserves a running child; manual runs and stop preserve the schedule; cancellation and deletion persist first", async () => {
  jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
  const f = fixture();
  const task = await f.manager.create(prepared(), randomUUID());
  await f.manager.resume();
  await f.manager.control("run_now", task.id);
  jest.advanceTimersByTime(0);
  await flush();
  await f.manager.control("pause", task.id);
  expect(f.runs[0]!.stopped).toBe(false);
  expect(f.manager.detail(task.id).task.status).toBe("paused");
  await f.manager.control("stop", task.id);
  expect(f.runs[0]!.stopped).toBe(true);
  expect(f.manager.detail(task.id).runs[0]!.status).toBe("stopped");
  await f.manager.control("run_now", task.id);
  jest.advanceTimersByTime(0);
  await flush();
  expect(f.runs).toHaveLength(2);
  f.fail(true);
  await expect(f.manager.control("cancel", task.id)).rejects.toThrow(
    "could not be saved",
  );
  expect(f.runs[1]!.stopped).toBe(false);
  f.fail(false);
  await f.manager.control("cancel", task.id);
  expect(f.runs[1]!.stopped).toBe(true);
  expect(f.notifications).toEqual([]);
  await expect(f.manager.control("resume", task.id)).rejects.toThrow(
    "cancelled",
  );
  f.manager.delete(task.id);
  expect(f.manager.summaries()).toEqual([]);
  expect(fixture(f.directory).manager.summaries()).toEqual([]);
});

test("failed storage and revoked identity cannot start a model or confirm a preview", async () => {
  jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
  const f = fixture();
  f.fail(true);
  await expect(f.manager.create(prepared(), randomUUID())).rejects.toThrow(
    "could not be saved",
  );
  expect(f.manager.summaries()).toEqual([]);
  f.fail(false);
  const proposal = await f.manager.propose(prepared());
  expect(f.manager.summaries()).toEqual([]);
  f.deny(true);
  await expect(f.manager.confirmProposal(proposal.id)).rejects.toThrow(
    "identity",
  );
  expect(f.manager.summaries()).toEqual([]);
  f.deny(false);
  await f.manager.confirmProposal(proposal.id);
  await f.manager.confirmProposal(proposal.id);
  expect(f.manager.summaries()).toHaveLength(1);
  await f.manager.resume();
  f.deny(true);
  jest.advanceTimersByTime(60_000);
  await flush();
  expect(f.runs).toHaveLength(0);
  expect(f.manager.summaries()[0]!.last_run?.status).toBe("failed");
});

test("a due task waits for its original connection without spinning or losing the occurrence", async () => {
  jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
  let ready = true;
  let checks = 0;
  const f = fixture(undefined, async () => {
    checks++;
    if (!ready)
      throw new AssistantRecoveryNotReadyError("Connection is not ready");
  });
  const task = await f.manager.create(
    prepared({ type: "once", at: "2026-10-04T00:01:00.000Z" }),
    randomUUID(),
  );
  await f.manager.resume();
  ready = false;
  jest.advanceTimersByTime(60_000);
  await flush();
  const queued = f.manager.detail(task.id).runs[0]!;
  expect(queued.status).toBe("queued");
  expect(queued.error).toContain(
    "Waiting for the original workspace connection",
  );
  expect(queued.started_at).toBeUndefined();
  expect(queued.finished_at).toBeUndefined();
  expect(f.manager.detail(task.id).task.next_run_at).toBeNull();
  expect(f.runs).toHaveLength(0);
  expect(checks).toBe(2);
  jest.advanceTimersByTime(4_999);
  await flush();
  expect(checks).toBe(2);
  jest.advanceTimersByTime(1);
  await flush();
  expect(checks).toBe(3);
  expect(f.manager.detail(task.id).runs).toHaveLength(1);
  ready = true;
  await f.manager.resume();
  await flush();
  expect(f.runs).toHaveLength(1);
  expect(f.runs[0]!.run.id).toBe(queued.id);
  expect(f.runs[0]!.run.scheduled_at).toBe(queued.scheduled_at);
  expect(f.runs[0]!.run.error).toBeNull();
  f.runs[0]!.complete();
  jest.advanceTimersByTime(120_000);
  await flush();
  expect(f.runs).toHaveLength(1);
  expect(f.manager.detail(task.id).runs[0]!.status).toBe("succeeded");
});

test("a disconnected queued task releases the slot for another workspace and can be cancelled", async () => {
  jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
  let ready = true;
  const f = fixture(undefined, async (_signal, input) => {
    if (!ready && input.input.title === "Disconnected workspace")
      throw new AssistantRecoveryNotReadyError("Connection is not ready");
  });
  const input = prepared({ type: "once", at: "2026-10-04T00:01:00.000Z" });
  input.input.title = "Disconnected workspace";
  const disconnected = await f.manager.create(input, randomUUID());
  const connected = await f.manager.create(
    prepared({ type: "once", at: "2026-10-04T00:01:01.000Z" }),
    randomUUID(),
  );
  await f.manager.resume();
  ready = false;
  jest.advanceTimersByTime(60_000);
  await flush();
  jest.advanceTimersByTime(1_000);
  await flush();
  expect(f.runs).toHaveLength(1);
  expect(f.runs[0]!.run.task_id).toBe(connected.id);
  expect(f.manager.detail(disconnected.id).runs[0]!.status).toBe("queued");
  await f.manager.control("cancel", disconnected.id);
  f.runs[0]!.complete();
  ready = true;
  await f.manager.resume();
  jest.advanceTimersByTime(5_000);
  await flush();
  expect(f.runs).toHaveLength(1);
  expect(f.manager.detail(disconnected.id).runs[0]!.status).toBe("stopped");
});

test.each(["ready", "replaced"] as const)(
  "a queued occurrence survives restart and revalidates a %s connection",
  async (connection) => {
    jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
    let ready = true;
    const validation = async () => {
      if (!ready)
        throw new AssistantRecoveryNotReadyError("Connection is not ready");
    };
    const f = fixture(undefined, validation);
    const task = await f.manager.create(
      prepared({ type: "once", at: "2026-10-04T00:01:00.000Z" }),
      randomUUID(),
    );
    await f.manager.resume();
    ready = false;
    jest.advanceTimersByTime(60_000);
    await flush();
    const queued = f.manager.detail(task.id).runs[0]!;
    await f.manager.dispose();
    const restored = fixture(f.directory, validation);
    await restored.manager.resume();
    await flush();
    expect(restored.manager.detail(task.id).runs[0]!.id).toBe(queued.id);
    expect(restored.manager.detail(task.id).runs[0]!.status).toBe("queued");
    expect(restored.runs).toHaveLength(0);
    ready = true;
    restored.deny(connection === "replaced");
    await restored.manager.resume();
    await flush();
    expect(restored.manager.detail(task.id).runs).toHaveLength(1);
    if (connection === "ready") {
      expect(restored.runs).toHaveLength(1);
      expect(restored.runs[0]!.run.id).toBe(queued.id);
      expect(restored.runs[0]!.recover).toBe(false);
    } else {
      expect(restored.runs).toHaveLength(0);
      expect(restored.manager.detail(task.id).runs[0]!.status).toBe("failed");
      expect(
        restored.manager.detail(task.id).runs[0]!.finished_at,
      ).toBeDefined();
      expect(restored.manager.detail(task.id).runs[0]!.error).toContain(
        "identity",
      );
    }
  },
);

test.each(["ready", "cancelled", "replaced"] as const)(
  "queued recovery survives another restart with a %s target",
  async (target) => {
    jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
    let ready = true;
    const validate = async () => {
      if (!ready) throw new AssistantRecoveryNotReadyError("Not ready");
    };
    const f = fixture(undefined, validate);
    const task = await f.manager.create(
      prepared({ type: "once", at: "2026-10-04T00:01:00.000Z" }),
      randomUUID(),
    );
    await f.manager.resume();
    jest.advanceTimersByTime(60_000);
    await flush();
    const original = f.manager.detail(task.id).runs[0]!;
    await f.manager.dispose();
    ready = false;
    const waiting = fixture(f.directory, validate);
    await waiting.manager.resume();
    await flush();
    expect(waiting.runs).toHaveLength(0);
    expect(waiting.manager.detail(task.id).runs[0]!.status).toBe("queued");
    expect(waiting.manager.detail(task.id).runs[0]!.started_at).toBe(
      original.started_at,
    );
    await waiting.manager.dispose();
    const restored = fixture(f.directory, validate);
    await restored.manager.resume();
    await flush();
    expect(restored.runs).toHaveLength(0);
    if (target === "cancelled")
      await restored.manager.control("cancel", task.id);
    restored.deny(target === "replaced");
    ready = true;
    await restored.manager.resume();
    await flush();
    const receipt = restored.manager.detail(task.id).runs[0]!;
    expect(receipt.id).toBe(original.id);
    expect(receipt.started_at).toBe(original.started_at);
    expect(restored.manager.detail(task.id).runs).toHaveLength(1);
    if (target === "ready") {
      expect(restored.runs).toHaveLength(1);
      expect(restored.runs[0]!.recover).toBe(true);
      expect(receipt.status).toBe("running");
    } else {
      expect(restored.runs).toHaveLength(0);
      expect(receipt.status).toBe(
        target === "cancelled" ? "stopped" : "failed",
      );
    }
  },
);

test("recovery queued during disconnection retains one coalesced occurrence after the interrupted run", async () => {
  jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
  const f = fixture();
  const task = await f.manager.create(prepared(), randomUUID());
  await f.manager.resume();
  jest.advanceTimersByTime(60_000);
  await flush();
  const original = f.manager.detail(task.id).runs[0]!;
  await f.manager.dispose();
  let ready = false;
  const restored = fixture(f.directory, async () => {
    if (!ready) throw new AssistantRecoveryNotReadyError("Not ready");
  });
  await restored.manager.resume();
  await flush();
  jest.advanceTimersByTime(240_000);
  await flush();
  expect(restored.manager.detail(task.id).runs).toHaveLength(1);
  expect(restored.manager.detail(task.id).runs[0]!.status).toBe("queued");
  ready = true;
  await restored.manager.resume();
  await flush();
  expect(restored.runs).toHaveLength(1);
  expect(restored.runs[0]!.run.id).toBe(original.id);
  expect(restored.runs[0]!.recover).toBe(true);
  restored.runs[0]!.complete();
  jest.advanceTimersByTime(0);
  await flush();
  expect(restored.runs).toHaveLength(2);
  expect(restored.runs[1]!.recover).toBe(false);
  expect(restored.runs[1]!.run.scheduled_at).toBe("2026-10-04T00:02:00.000Z");
  expect(restored.manager.detail(task.id).runs).toHaveLength(2);
  expect(restored.manager.detail(task.id).task.next_run_at).toBe(
    "2026-10-04T00:06:00.000Z",
  );
});

test("completed history retains only receipts, caps at 20 runs and reloads large prompts", async () => {
  jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
  const f = fixture();
  const input = prepared();
  input.input.prompt = "p".repeat(32_000);
  const task = await f.manager.create(input, randomUUID());
  await f.manager.resume();
  for (let index = 0; index < 22; index++) {
    await f.manager.control("run_now", task.id);
    jest.advanceTimersByTime(0);
    await flush();
    const run = f.runs.at(-1)!;
    mkdirSync(run.directory, { recursive: true });
    writeFileSync(join(run.directory, "marker"), "private-history");
    run.complete();
    await flush();
  }
  const storage = openTaskStorage(f.directory, validateSavedTasks);
  const saved = storage.load();
  storage.close();
  expect(saved.tasks[0]!.runs).toHaveLength(20);
  expect(
    saved.tasks[0]!.runs.every(
      (run: Record<string, unknown>) =>
        run.input === undefined &&
        run.targets === undefined &&
        run.config === undefined,
    ),
  ).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThan(50_000);
  expect(existsSync(f.runs[0]!.directory)).toBe(false);
  const restored = fixture(f.directory);
  expect(restored.manager.invalid()).toBe(false);
  expect(restored.manager.detail(task.id).runs).toHaveLength(20);
  expect(restored.manager.detail(task.id).task.prompt).toHaveLength(32_000);
  expect(() =>
    validateTaskInput({ ...input.input, title: "t".repeat(101) }),
  ).toThrow();
});

test.each(["stop", "dispose"] as const)(
  "%s cancels pending scope validation without starting a model",
  async (method) => {
    jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
    let block = false;
    let aborted = false;
    const f = fixture(undefined, async (signal) => {
      if (!block) return;
      await new Promise<void>((_resolve, reject) => {
        signal!.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("Stopped"));
          },
          { once: true },
        );
      });
    });
    const task = await f.manager.create(prepared(), randomUUID());
    await f.manager.resume();
    await f.manager.control("run_now", task.id);
    block = true;
    jest.advanceTimersByTime(0);
    await flush();
    expect(f.runs).toHaveLength(0);
    if (method === "stop") await f.manager.control("stop", task.id);
    else await f.manager.dispose();
    await flush();
    expect(aborted).toBe(true);
    expect(f.runs).toHaveLength(0);
    expect(f.manager.detail(task.id).runs[0]!.status).toBe(
      method === "stop" ? "stopped" : "running",
    );
  },
);

test("deferred permission checks cannot duplicate a run or undo newer cancellation and template changes", async () => {
  const gates: ReturnType<typeof Promise.withResolvers<void>>[] = [];
  let blocked = false;
  const f = fixture(undefined, async () => {
    if (blocked) {
      const gate = Promise.withResolvers<void>();
      gates.push(gate);
      await gate.promise;
    }
  });
  const task = await f.manager.create(prepared(), randomUUID());
  blocked = true;
  const first = f.manager.control("run_now", task.id);
  const second = f.manager.control("run_now", task.id);
  await flush();
  for (const gate of gates.splice(0)) gate.resolve();
  await Promise.all([first, second]);
  expect(
    f.manager.detail(task.id).runs.filter((run) => run.status === "queued"),
  ).toHaveLength(1);
  expect(fixture(f.directory).manager.invalid()).toBe(false);
  await f.manager.control("stop", task.id);
  await f.manager.control("pause", task.id);
  const lateResume = f.manager.control("resume", task.id).then(
    () => "succeeded",
    (error) => error,
  );
  await flush();
  await f.manager.control("cancel", task.id);
  expect(await lateResume).toBeInstanceOf(Error);
  for (const gate of gates.splice(0)) gate.resolve();
  await flush();
  expect(f.manager.detail(task.id).task.status).toBe("cancelled");
  blocked = false;
  const proposal = await f.manager.propose(prepared());
  blocked = true;
  const lateConfirm = f.manager.confirmProposal(proposal.id).then(
    () => "succeeded",
    (error) => error,
  );
  await flush();
  f.manager.cancelProposal(proposal.id);
  expect(await lateConfirm).toBeInstanceOf(Error);
  for (const gate of gates.splice(0)) gate.resolve();
  await flush();
  expect(f.manager.proposal(proposal.id)!.status).toBe("cancelled");
  expect(f.manager.summaries()).toHaveLength(1);
  blocked = false;
  const mutable = prepared();
  const other = await f.manager.create(mutable, randomUUID());
  blocked = true;
  const lateRun = f.manager.control("run_now", other.id).then(
    () => "succeeded",
    (error) => error,
  );
  await flush();
  blocked = false;
  mutable.input.prompt = "Explicitly changed task prompt";
  await f.manager.update(other.id, mutable);
  for (const gate of gates.splice(0)) gate.resolve();
  expect(await lateRun).toBeInstanceOf(Error);
  expect(f.manager.detail(other.id).runs).toHaveLength(0);
});

test("successful explicit Resume recovers a save failure without replaying an already completed child", async () => {
  jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
  const f = fixture();
  const task = await f.manager.create(prepared(), randomUUID());
  await f.manager.resume();
  await f.manager.control("run_now", task.id);
  jest.advanceTimersByTime(0);
  await flush();
  f.fail(true);
  f.runs[0]!.complete();
  expect(f.manager.error()).toContain("Scheduling is paused");
  expect(f.notifications).toEqual([]);
  f.fail(false);
  await f.manager.control("resume", task.id);
  expect(f.manager.error()).toBeNull();
  expect(f.manager.detail(task.id).runs[0]!.status).toBe("succeeded");
  expect(f.runs).toHaveLength(1);
  expect(f.notifications).toHaveLength(1);
  await f.manager.control("resume", task.id);
  expect(f.notifications).toHaveLength(1);
  await f.manager.control("run_now", task.id);
  jest.advanceTimersByTime(0);
  await flush();
  expect(f.runs).toHaveLength(2);
});

test("Delete cannot remove private history until a cancelled child has actually drained", async () => {
  jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
  const f = fixture();
  const task = await f.manager.create(prepared(), randomUUID());
  await f.manager.resume();
  await f.manager.control("run_now", task.id);
  jest.advanceTimersByTime(0);
  await flush();
  f.runs[0]!.stopGate = Promise.withResolvers<void>();
  const cancelling = f.manager.control("cancel", task.id);
  await flush();
  expect(f.manager.detail(task.id).task.status).toBe("cancelled");
  expect(() => f.manager.delete(task.id)).toThrow("before deleting");
  expect(f.runs[0]!.disposed).toBe(false);
  f.runs[0]!.stopGate!.resolve();
  await cancelling;
  expect(f.runs[0]!.disposed).toBe(true);
  f.manager.delete(task.id);
  expect(f.manager.summaries()).toEqual([]);
});

test.each(["stop", "cancel"] as const)(
  "%s drains a child after its Stop save fails before releasing the model slot",
  async (method) => {
    jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
    const f = fixture();
    const first = await f.manager.create(prepared(), randomUUID());
    const second = await f.manager.create(prepared(), randomUUID());
    await f.manager.resume();
    await f.manager.control("run_now", first.id);
    jest.advanceTimersByTime(0);
    await flush();
    await f.manager.control("run_now", second.id);
    const child = f.runs[0]!;
    child.stopGate = Promise.withResolvers<void>();
    child.disposeGate = Promise.withResolvers<void>();
    const error = new Error("The Ranger changes could not be saved.");
    let settled = false;
    const stopping = f.manager.control(method, first.id).then(
      () => {
        settled = true;
      },
      (cause) => {
        settled = true;
        return cause;
      },
    );
    try {
      expect(f.manager.detail(first.id).runs[0]!.status).toBe("stopped");
      child.stopGate.reject(error);
      await flush();
      expect(child.disposing).toBe(true);
      expect(child.disposed).toBe(false);
      expect(settled).toBe(false);
      child.complete();
      jest.advanceTimersByTime(5000);
      await flush();
      expect(f.runs).toHaveLength(1);
      expect(f.manager.detail(second.id).runs[0]!.status).toBe("queued");
      child.disposeGate.resolve();
      expect(await stopping).toBe(error);
      expect(child.disposed).toBe(true);
      jest.advanceTimersByTime(0);
      await flush();
      expect(f.runs).toHaveLength(2);
      expect(f.runs[1]!.run.task_id).toBe(second.id);
      expect(f.manager.detail(second.id).runs[0]!.status).toBe("running");
    } finally {
      child.disposeGate.resolve();
      await stopping;
    }
  },
);

test("task input accepts the shared inventory bound and rejects overflow", () => {
  const input = prepared().input;
  input.scope = Array.from(
    { length: ASSISTANT_MAX_WORKSPACES },
    (_, index) => ({
      connection_id: "local",
      workspace_id: `w${index}`,
    }),
  );
  expect(validateTaskInput(input).scope).toHaveLength(ASSISTANT_MAX_WORKSPACES);
  expect(() =>
    validateTaskInput({
      ...input,
      scope: [
        ...input.scope,
        { connection_id: "local", workspace_id: "overflow" },
      ],
    }),
  ).toThrow("Invalid task input");
});

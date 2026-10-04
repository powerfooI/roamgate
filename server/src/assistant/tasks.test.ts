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
import type { AssistantSnapshot } from "../../../shared/assistant";
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
    complete(pending?: boolean): void;
  }[] = [];
  let deny = false;
  const manager = createAssistantTasks({
    directory,
    publish: () => {},
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
        complete(pending = false) {
          snapshot.running = false;
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
  };
}

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
  f.fail(false);
  await f.manager.control("resume", task.id);
  expect(f.manager.error()).toBeNull();
  expect(f.manager.detail(task.id).runs[0]!.status).toBe("succeeded");
  expect(f.runs).toHaveLength(1);
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

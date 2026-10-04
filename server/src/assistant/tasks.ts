import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  AssistantConfig,
  AssistantSnapshot,
  AssistantTask,
  AssistantTaskDetail,
  AssistantTaskInput,
  AssistantTaskProposal,
  AssistantTaskRun,
  AssistantWorkspace,
} from "../../../shared/assistant";
import { isAssistantSnapshot } from "../../../shared/assistant";
import { assertSafeDataPath } from "../config/data-paths";
import { AssistantRecoveryNotReadyError, type RecoveryTarget } from "./context";
import { nextTaskTime, validateTaskSchedule } from "./task-schedule";
import {
  MAX_TASK_STATE_BYTES,
  openTaskStorage,
  type TaskStorage,
} from "./task-storage";

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const MAX_TASKS = 50;
const MAX_RUNS = 20;
const key = (ref: { connection_id: string; workspace_id: string }) =>
  `${ref.connection_id}\0${ref.workspace_id}`;

export type PreparedTask = {
  input: AssistantTaskInput;
  config: AssistantConfig;
  targets: RecoveryTarget[];
  workspaces: AssistantWorkspace[];
};
export type SavedTaskRun = AssistantTaskRun &
  PreparedTask & { manual: boolean };
type StoredTaskRun = AssistantTaskRun &
  Partial<PreparedTask> & { manual: boolean };
type SavedTask = PreparedTask & {
  task: Pick<
    AssistantTask,
    "id" | "status" | "created_at" | "updated_at" | "next_run_at"
  >;
  runs: StoredTaskRun[];
  due_at?: string;
};
type SavedProposal = {
  proposal: AssistantTaskProposal;
  prepared: PreparedTask;
};
export type SavedTaskState = {
  tasks: SavedTask[];
  proposals: SavedProposal[];
  requests: { id: string; task_id: string }[];
};
export type ScheduledChild = {
  start(recover: boolean): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  action(method: "confirm" | "cancel", actionId: string): Promise<void>;
  snapshot(): AssistantSnapshot;
  dispose(): Promise<void>;
};

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, limit: number) {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    throw new Error("Invalid task input");
  return value;
}
export function validateTaskInput(value: unknown): AssistantTaskInput {
  if (
    !record(value) ||
    Object.keys(value).some(
      (field) => !["title", "prompt", "scope", "schedule"].includes(field),
    ) ||
    !Array.isArray(value.scope) ||
    !value.scope.length ||
    value.scope.length > 64
  )
    throw new Error("Invalid task input");
  const scope = value.scope.map((ref) => {
    if (
      !record(ref) ||
      Object.keys(ref).some(
        (field) => !["connection_id", "workspace_id"].includes(field),
      )
    )
      throw new Error("Invalid task scope");
    return {
      connection_id: text(ref.connection_id, 500),
      workspace_id: text(ref.workspace_id, 500),
    };
  });
  if (new Set(scope.map(key)).size !== scope.length)
    throw new Error("Duplicate task scope");
  return {
    title: text(value.title, 100),
    prompt: text(value.prompt, 32_000),
    scope,
    schedule: validateTaskSchedule(value.schedule),
  };
}
function validPrepared(value: unknown): value is PreparedTask {
  if (!record(value) || !record(value.config)) return false;
  try {
    const input = validateTaskInput(value.input);
    const refs = new Set(input.scope.map(key));
    return (
      typeof value.config.provider === "string" &&
      !!value.config.provider &&
      typeof value.config.model === "string" &&
      !!value.config.model &&
      ["assistant", "pi"].includes(String(value.config.credential_source)) &&
      Array.isArray(value.config.allowed_workspaces) &&
      value.config.allowed_workspaces.length === refs.size &&
      new Set(value.config.allowed_workspaces.map((ref) => key(ref as never)))
        .size === refs.size &&
      value.config.allowed_workspaces.every(
        (ref) => record(ref) && refs.has(key(ref as never)),
      ) &&
      Array.isArray(value.workspaces) &&
      value.workspaces.length === refs.size &&
      new Set(value.workspaces.map((ref) => key(ref as never))).size ===
        refs.size &&
      value.workspaces.every(
        (ref) =>
          record(ref) &&
          refs.has(key(ref as never)) &&
          typeof ref.label === "string" &&
          typeof ref.connection_label === "string" &&
          Number.isSafeInteger(ref.runtime_generation) &&
          Number(ref.runtime_generation) >= 0,
      ) &&
      Array.isArray(value.targets) &&
      value.targets.length === refs.size &&
      new Set(value.targets.map((target) => key(target as never))).size ===
        refs.size &&
      value.targets.every(
        (target) =>
          record(target) &&
          refs.has(key(target as never)) &&
          typeof target.endpoint_fingerprint === "string" &&
          /^[a-f0-9]{64}$/.test(target.endpoint_fingerprint) &&
          typeof target.workspace_identity === "string" &&
          /^[a-f0-9]{64}$/.test(target.workspace_identity) &&
          typeof target.herdr_boot_id === "string" &&
          !!target.herdr_boot_id &&
          target.herdr_boot_id.length <= 500,
      )
    );
  } catch {
    return false;
  }
}
function receipt(run: StoredTaskRun): AssistantTaskRun {
  const { id, task_id, status, scheduled_at, started_at, finished_at, error } =
    run;
  return { id, task_id, status, scheduled_at, started_at, finished_at, error };
}
function compact(run: StoredTaskRun) {
  delete run.input;
  delete run.config;
  delete run.targets;
  delete run.workspaces;
}
function nextAfter(entry: SavedTask, now: number) {
  if (entry.input.schedule.type === "interval") {
    const interval = entry.input.schedule.minutes * 60_000;
    const previous = Date.parse(entry.task.next_run_at!);
    return previous + (Math.floor((now - previous) / interval) + 1) * interval;
  }
  return nextTaskTime(entry.input.schedule, now);
}

export function validateSavedTasks(saved: unknown): SavedTaskState {
  if (Buffer.byteLength(JSON.stringify(saved) ?? "") > MAX_TASK_STATE_BYTES)
    throw new Error("Saved tasks are too large");
  if (
    !record(saved) ||
    !Array.isArray(saved.tasks) ||
    saved.tasks.length > MAX_TASKS ||
    !saved.tasks.every(
      (entry: SavedTask) =>
        validPrepared(entry) &&
        UUID.test(entry.task?.id) &&
        ["active", "paused", "cancelled"].includes(entry.task.status) &&
        [entry.task.created_at, entry.task.updated_at].every((date) =>
          Number.isFinite(Date.parse(date)),
        ) &&
        (entry.task.next_run_at === null ||
          Number.isFinite(Date.parse(entry.task.next_run_at))) &&
        Array.isArray(entry.runs) &&
        entry.runs.length <= MAX_RUNS &&
        entry.runs.every(
          (run) =>
            (!["queued", "running", "waiting"].includes(run.status) ||
              validPrepared(run)) &&
            UUID.test(run.id) &&
            run.task_id === entry.task.id &&
            [
              "queued",
              "running",
              "waiting",
              "succeeded",
              "failed",
              "stopped",
            ].includes(run.status) &&
            typeof run.manual === "boolean" &&
            Number.isFinite(Date.parse(run.scheduled_at)) &&
            [run.started_at, run.finished_at].every(
              (date) => date === undefined || Number.isFinite(Date.parse(date)),
            ) &&
            (run.error === null || typeof run.error === "string"),
        ) &&
        entry.runs.filter((run) =>
          ["queued", "running", "waiting"].includes(run.status),
        ).length <= 1,
    ) ||
    new Set(saved.tasks.map((entry: SavedTask) => entry.task.id)).size !==
      saved.tasks.length ||
    !Array.isArray(saved.proposals) ||
    saved.proposals.length > 50 ||
    !saved.proposals.every(
      (entry: SavedProposal) =>
        validPrepared(entry.prepared) &&
        UUID.test(entry.proposal?.id) &&
        ["pending", "confirmed", "cancelled"].includes(entry.proposal.status),
    ) ||
    !Array.isArray(saved.requests) ||
    saved.requests.length > 1000 ||
    !saved.requests.every(
      (request: { id: string; task_id: string }) =>
        typeof request.id === "string" &&
        request.id.length <= 500 &&
        UUID.test(request.task_id),
    )
  )
    throw new Error("Invalid saved tasks");
  if (
    saved.tasks
      .flatMap((entry: SavedTask) => entry.runs)
      .filter((run) => run.status === "running").length > 1
  )
    throw new Error("Multiple saved task runs");
  const runIds = (saved.tasks as SavedTask[]).flatMap((entry) =>
    entry.runs.map((run) => run.id),
  );
  if (new Set(runIds).size !== runIds.length)
    throw new Error("Duplicate saved task run");
  return saved as SavedTaskState;
}

/** Owns admission and timing; each run still uses the ordinary Ranger service. */
export function createAssistantTasks(options: {
  directory: string;
  publish(): void;
  validate(prepared: PreparedTask, signal?: AbortSignal): Promise<void>;
  child(
    run: SavedTaskRun,
    directory: string,
    publish: (snapshot: AssistantSnapshot) => void,
  ): ScheduledChild;
}) {
  let tasks: SavedTask[] = [];
  let proposals: SavedProposal[] = [];
  let requests: { id: string; task_id: string }[] = [];
  let invalid = false;
  let enabled = false;
  let started = false;
  let disposed = false;
  let busy: string | undefined;
  let fault: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const children = new Map<string, ScheduledChild>();
  const controller = new AbortController();
  const admissions = new Map<string, AbortController>();
  const retryAt = new Map<string, number>();
  const revisions = new Map<string, number>();
  const checks = new Map<string, Set<AbortController>>();
  const jobs = new Set<Promise<void>>();
  const now = () => new Date().toISOString();
  async function validate(prepared: PreparedTask, signal?: AbortSignal) {
    const combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    combined.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        reject(new Error("The task permission check was cancelled."));
      };
      combined.addEventListener("abort", abort, { once: true });
      void Promise.resolve()
        .then(() => {
          combined.throwIfAborted();
          return options.validate(prepared, combined);
        })
        .then(resolve, reject)
        .finally(() => combined.removeEventListener("abort", abort));
    });
    combined.throwIfAborted();
  }
  const seal = (prepared: PreparedTask): PreparedTask =>
    structuredClone({
      input: prepared.input,
      config: prepared.config,
      targets: prepared.targets,
      workspaces: prepared.workspaces,
    });
  const revision = (id: string) => revisions.get(id) ?? 0;
  const bump = (id: string) => revisions.set(id, revision(id) + 1);
  function cancelChecks(id: string) {
    for (const check of checks.get(id) ?? []) check.abort();
  }
  async function check(
    id: string,
    prepared: PreparedTask,
    signal?: AbortSignal,
  ) {
    const operation = new AbortController();
    const pending = checks.get(id) ?? new Set<AbortController>();
    checks.set(id, pending);
    pending.add(operation);
    try {
      await validate(
        prepared,
        signal ? AbortSignal.any([signal, operation.signal]) : operation.signal,
      );
    } finally {
      pending.delete(operation);
      if (!pending.size) checks.delete(id);
    }
  }
  function runDirectory(taskId: string, runId?: string) {
    const root = join(options.directory, "tasks");
    const task = join(root, taskId);
    const paths = [options.directory, root, task];
    if (runId) paths.push(join(task, "runs"), join(task, "runs", runId));
    for (const directory of paths)
      assertSafeDataPath(join(directory, ".guard"));
    return paths.at(-1)!;
  }
  let storage: TaskStorage | undefined;
  try {
    storage = openTaskStorage(options.directory, validateSavedTasks);
    ({ tasks, proposals, requests } = storage.load());
    for (const entry of tasks)
      for (const run of entry.runs)
        if (!["queued", "running", "waiting"].includes(run.status))
          compact(run);
  } catch {
    storage?.close();
    storage = undefined;
    invalid = true;
    tasks = [];
    proposals = [];
    requests = [];
  }
  function save() {
    if (invalid || !storage)
      throw new Error("The saved Ranger tasks could not be loaded.");
    storage.save({ tasks, proposals, requests: requests.slice(-1000) });
  }
  function change(update: () => void) {
    const previous = structuredClone({ tasks, proposals, requests });
    try {
      update();
      save();
    } catch {
      ({ tasks, proposals, requests } = previous);
      fault =
        "The Ranger tasks could not be saved. Scheduling is paused until recovery succeeds.";
      enabled = false;
      options.publish();
      throw new Error("The Ranger task changes could not be saved.");
    }
    options.publish();
    const retained = new Set(
      tasks.flatMap((entry) => entry.runs.map((run) => run.id)),
    );
    for (const id of retryAt.keys()) if (!retained.has(id)) retryAt.delete(id);
    for (const entry of previous.tasks)
      for (const run of entry.runs)
        if (
          !retained.has(run.id) &&
          tasks.some((item) => item.task.id === entry.task.id)
        ) {
          try {
            rmSync(runDirectory(entry.task.id, run.id), {
              recursive: true,
              force: true,
            });
          } catch {}
        }
  }
  function find(id: unknown) {
    if (typeof id !== "string" || !UUID.test(id))
      throw new Error("Invalid task identifier");
    const found = tasks.find((entry) => entry.task.id === id);
    if (!found) throw new Error("This task is no longer available.");
    return found;
  }
  function current(entry: SavedTask) {
    return entry.runs.find((run) =>
      ["queued", "running", "waiting"].includes(run.status),
    );
  }
  function summary(entry: SavedTask): AssistantTask {
    return {
      id: entry.task.id,
      status: entry.task.status,
      created_at: entry.task.created_at,
      updated_at: entry.task.updated_at,
      next_run_at: entry.task.next_run_at,
      ...structuredClone(entry.input),
      workspaces: structuredClone(entry.workspaces),
      model: { provider: entry.config.provider, id: entry.config.model },
      current_run: current(entry) ? receipt(current(entry)!) : undefined,
      last_run: entry.runs.find(
        (run) => !["queued", "running", "waiting"].includes(run.status),
      )
        ? receipt(
            entry.runs.find(
              (run) => !["queued", "running", "waiting"].includes(run.status),
            )!,
          )
        : undefined,
    };
  }
  function queue(entry: SavedTask, scheduledAt: string, manual = false) {
    const run: SavedTaskRun = {
      ...structuredClone({
        input: entry.input,
        config: entry.config,
        targets: entry.targets,
        workspaces: entry.workspaces,
      }),
      id: randomUUID(),
      task_id: entry.task.id,
      status: "queued",
      scheduled_at: scheduledAt,
      error: null,
      manual,
    };
    entry.runs.unshift(run);
    entry.runs = entry.runs.slice(0, MAX_RUNS);
    return run;
  }
  function arm() {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!enabled || disposed || invalid) return;
    const due = tasks
      .filter(
        (entry) => entry.task.status === "active" && entry.task.next_run_at,
      )
      .map((entry) => Date.parse(entry.task.next_run_at!));
    if (busy) due.push(Date.now() + 5_000);
    if (!busy)
      for (const entry of tasks) {
        const run = current(entry);
        if (
          run?.status === "queued" &&
          (entry.task.status === "active" || run.manual || run.started_at)
        )
          due.push(retryAt.get(run.id) ?? Date.now());
      }
    if (!due.length) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        track(tick());
      },
      Math.min(2_147_483_647, Math.max(0, Math.min(...due) - Date.now())),
    );
  }
  function track(work: Promise<void>) {
    jobs.add(work);
    void work.catch(() => {}).finally(() => jobs.delete(work));
  }
  function finish(runId: string, snapshot: AssistantSnapshot) {
    if (disposed) return;
    const entry = tasks.find((item) =>
      item.runs.some((run) => run.id === runId),
    );
    const run = entry?.runs.find((item) => item.id === runId);
    if (!entry || !run || !["running", "waiting"].includes(run.status)) return;
    if (snapshot.running) {
      if (run.error !== snapshot.error)
        change(() => {
          run.error = snapshot.error;
        });
      return;
    }
    const pending = snapshot.messages.some((message) =>
      message.actions?.some(
        (action) =>
          action.status === "pending" || action.status === "executing",
      ),
    );
    change(() => {
      run.error = snapshot.error;
      if (pending) run.status = "waiting";
      else {
        run.status = snapshot.error ? "failed" : "succeeded";
        run.finished_at = now();
        compact(run);
        if (entry.due_at && entry.task.status === "active") {
          queue(entry, entry.due_at);
          delete entry.due_at;
        }
      }
    });
    if (busy === runId) busy = undefined;
    if (!pending) {
      const child = children.get(runId);
      children.delete(runId);
      if (child) track(child.dispose());
    }
    arm();
  }
  async function launch(
    entry: SavedTask,
    run: StoredTaskRun,
    recover: boolean,
  ) {
    busy = run.id;
    const admission = new AbortController();
    admissions.set(run.id, admission);
    let child: ScheduledChild | undefined;
    try {
      change(() => {
        retryAt.delete(run.id);
        run.status = "running";
        run.started_at ??= now();
        run.error = null;
      });
      if (!validPrepared(run)) throw new Error("Invalid task admission");
      await validate(run, admission.signal);
      if (disposed || !["running", "waiting"].includes(run.status)) {
        if (busy === run.id) busy = undefined;
        return;
      }
      child = options.child(
        structuredClone(run as SavedTaskRun),
        runDirectory(entry.task.id, run.id),
        (snapshot) => {
          try {
            finish(run.id, snapshot);
          } catch {}
        },
      );
      children.set(run.id, child);
      await child.start(recover);
      if (!disposed) finish(run.id, child.snapshot());
    } catch (error) {
      if (!disposed && run.status !== "stopped") {
        if (
          (!child || recover) &&
          error instanceof AssistantRecoveryNotReadyError
        ) {
          await child?.dispose();
          children.delete(run.id);
          if (disposed || !["running", "waiting"].includes(run.status)) return;
          change(() => {
            run.status = "queued";
            run.error =
              "Waiting for the original workspace connection to become ready.";
            // An admitted run must retain its checkpoint and original start time.
            if (!recover) delete run.started_at;
          });
          retryAt.set(run.id, Date.now() + 5_000);
          return;
        }
        change(() => {
          run.status = "failed";
          run.error =
            "The task could not safely start or resume. Check its original workspace permissions, identity and model.";
          run.finished_at = now();
          compact(run);
        });
        if (busy === run.id) busy = undefined;
        children.delete(run.id);
        await child?.dispose();
      }
    } finally {
      admissions.delete(run.id);
      if (!children.has(run.id) && busy === run.id) busy = undefined;
      arm();
    }
  }
  async function tick() {
    if (!enabled || disposed || invalid) return;
    const time = Date.now();
    const due = tasks.filter(
      (entry) =>
        entry.task.status === "active" &&
        entry.task.next_run_at &&
        Date.parse(entry.task.next_run_at) <= time,
    );
    if (due.length)
      change(() => {
        for (const entry of due) {
          const scheduled = entry.task.next_run_at!;
          const next = nextAfter(entry, time);
          entry.task.next_run_at =
            next === null ? null : new Date(next).toISOString();
          const active = current(entry);
          if (
            active &&
            (active.status !== "queued" || active.manual || active.started_at)
          )
            entry.due_at ??= scheduled;
          else if (active) continue;
          else queue(entry, scheduled);
        }
      });
    if (busy) {
      await children.get(busy)?.resume();
    } else {
      const queued = tasks
        .flatMap((entry) =>
          entry.runs
            .filter(
              (run) =>
                run.status === "queued" &&
                (retryAt.get(run.id) ?? 0) <= time &&
                (entry.task.status === "active" ||
                  run.manual ||
                  !!run.started_at),
            )
            .map((run) => ({ entry, run })),
        )
        .sort((a, b) => a.run.scheduled_at.localeCompare(b.run.scheduled_at));
      if (queued[0])
        track(
          launch(queued[0].entry, queued[0].run, !!queued[0].run.started_at),
        );
    }
    arm();
  }
  function insert(prepared: PreparedTask, requestId: string) {
    const existing = requests.find((request) => request.id === requestId);
    if (existing) return find(existing.task_id);
    if (tasks.length >= MAX_TASKS)
      throw new Error("Ranger supports up to 50 saved tasks.");
    const schedule = prepared.input.schedule;
    const next =
      schedule.type === "once"
        ? Date.parse(schedule.at)
        : nextTaskTime(schedule, Date.now());
    const entry: SavedTask = {
      ...structuredClone(prepared),
      task: {
        id: randomUUID(),
        status: "active",
        created_at: now(),
        updated_at: now(),
        next_run_at: next === null ? null : new Date(next).toISOString(),
      },
      runs: [],
    };
    tasks.unshift(entry);
    requests.push({ id: requestId, task_id: entry.task.id });
    requests = requests.slice(-1000);
    return entry;
  }
  return {
    invalid: () => invalid,
    error: () => fault,
    summaries: () => tasks.map(summary),
    proposal: (id: string) =>
      structuredClone(
        proposals.find((entry) => entry.proposal.id === id)?.proposal,
      ),
    async create(prepared: PreparedTask, requestId: string) {
      if (!UUID.test(requestId))
        throw new Error("Invalid task request identifier");
      const sealed = seal(prepared);
      await validate(sealed);
      let entry!: SavedTask;
      change(() => {
        entry = insert(sealed, requestId);
      });
      arm();
      return summary(entry);
    },
    async update(id: unknown, prepared: PreparedTask) {
      let entry = find(id);
      if (entry.task.status === "cancelled")
        throw new Error("A cancelled task cannot be updated.");
      const version = revision(entry.task.id);
      const sealed = seal(prepared);
      await check(entry.task.id, sealed);
      entry = find(id);
      if (
        entry.task.status === "cancelled" ||
        revision(entry.task.id) !== version
      )
        throw new Error(
          "The task changed during permission checks. Review it and try again.",
        );
      change(() => {
        bump(entry.task.id);
        Object.assign(entry, sealed);
        Object.assign(entry.task, {
          updated_at: now(),
          next_run_at:
            sealed.input.schedule.type === "once"
              ? sealed.input.schedule.at
              : new Date(
                  nextTaskTime(sealed.input.schedule, Date.now())!,
                ).toISOString(),
        });
        delete entry.due_at;
      });
      arm();
    },
    async propose(
      prepared: PreparedTask,
      signal?: AbortSignal,
    ): Promise<AssistantTaskProposal> {
      const sealed = seal(prepared);
      await validate(sealed, signal);
      if (
        proposals.filter((entry) => entry.proposal.status === "pending")
          .length >= 50
      )
        throw new Error("Too many pending task proposals.");
      const proposal: AssistantTaskProposal = {
        ...structuredClone(sealed.input),
        id: randomUUID(),
        status: "pending",
        created_at: now(),
      };
      change(() => {
        proposals = proposals
          .filter((entry) => entry.proposal.status === "pending")
          .slice(-49);
        proposals.push({ prepared: sealed, proposal });
      });
      return structuredClone(proposal);
    },
    async confirmProposal(id: string) {
      let entry = proposals.find((value) => value.proposal.id === id);
      if (!entry) throw new Error("This task proposal is no longer available.");
      if (entry.proposal.status !== "pending") return;
      const sealed = seal(entry.prepared);
      await check(`proposal:${id}`, sealed);
      entry = proposals.find((value) => value.proposal.id === id);
      if (!entry || entry.proposal.status !== "pending") return;
      if (JSON.stringify(entry.prepared) !== JSON.stringify(sealed))
        throw new Error("The task proposal changed. Ask for a fresh preview.");
      change(() => {
        const task = insert(sealed, `proposal:${id}`);
        entry!.proposal.status = "confirmed";
        entry!.proposal.task_id = task.task.id;
      });
      arm();
    },
    cancelProposal(id: string) {
      const entry = proposals.find((value) => value.proposal.id === id);
      if (!entry || entry.proposal.status !== "pending") return;
      change(() => {
        entry.proposal.status = "cancelled";
      });
      cancelChecks(`proposal:${id}`);
    },
    async control(
      method: "pause" | "resume" | "cancel" | "run_now" | "stop",
      id: unknown,
    ) {
      let entry = find(id);
      if (
        entry.task.status === "cancelled" &&
        !["cancel", "stop"].includes(method)
      )
        throw new Error("This task was cancelled.");
      if (method === "resume" || method === "run_now") {
        const version = revision(entry.task.id);
        const sealed = seal(entry);
        await check(entry.task.id, sealed);
        entry = find(id);
        if (entry.task.status === "cancelled")
          throw new Error("This task was cancelled.");
        if (revision(entry.task.id) !== version) {
          if (
            method === "run_now" &&
            current(entry) &&
            JSON.stringify(seal(entry)) === JSON.stringify(sealed)
          )
            return;
          throw new Error(
            "The task changed during permission checks. Review it and try again.",
          );
        }
      }
      const active = current(entry);
      change(() => {
        bump(entry.task.id);
        entry.task.updated_at = now();
        if (method === "pause") {
          entry.task.status = "paused";
          delete entry.due_at;
        }
        if (method === "resume") {
          entry.task.status = "active";
          if (
            entry.task.next_run_at === null &&
            entry.input.schedule.type !== "once"
          )
            entry.task.next_run_at = new Date(
              nextTaskTime(entry.input.schedule, Date.now())!,
            ).toISOString();
        }
        if (method === "run_now" && !active) queue(entry, now(), true);
        if (method === "cancel") {
          entry.task.status = "cancelled";
          entry.task.next_run_at = null;
          delete entry.due_at;
        }
        if ((method === "cancel" || method === "stop") && active) {
          active.status = "stopped";
          active.finished_at = now();
          active.error = null;
          delete entry.due_at;
        }
      });
      if (method === "cancel" || method === "stop" || method === "pause")
        cancelChecks(entry.task.id);
      if ((method === "cancel" || method === "stop") && active) {
        admissions.get(active.id)?.abort(new Error("Scheduled task stopped"));
        const child = children.get(active.id);
        try {
          await child?.stop();
        } finally {
          // Stop can fail while saving cancellation; still drain the child.
          await child?.dispose();
          children.delete(active.id);
          if (busy === active.id) busy = undefined;
          change(() => {
            compact(active);
          });
          arm();
        }
      }
      if (method === "resume" && started && !disposed) {
        enabled = true;
        fault = null;
        for (const [runId, child] of children) finish(runId, child.snapshot());
        options.publish();
      }
      arm();
    },
    async revalidate() {
      for (const entry of tasks) {
        const run = current(entry);
        if (!run || !children.has(run.id)) continue;
        try {
          if (!validPrepared(run)) throw new Error("Invalid task scope");
          await validate(run);
        } catch {
          await this.control("stop", entry.task.id);
          change(() => {
            run.error =
              "The original task permission, workspace identity or model is no longer available.";
          });
        }
      }
    },
    delete(id: unknown) {
      const entry = find(id);
      if (
        entry.task.status !== "cancelled" ||
        current(entry) ||
        entry.runs.some((run) => children.has(run.id) || admissions.has(run.id))
      )
        throw new Error("Cancel this task before deleting its history.");
      change(() => {
        bump(entry.task.id);
        tasks = tasks.filter((item) => item !== entry);
        requests = requests.filter(
          (request) => request.task_id !== entry.task.id,
        );
      });
      try {
        rmSync(runDirectory(entry.task.id), { recursive: true, force: true });
      } catch {
        throw new Error(
          "The task was deleted, but its private history could not be removed.",
        );
      }
      arm();
    },
    async action(
      method: "confirm" | "cancel",
      taskId: unknown,
      runId: unknown,
      actionId: unknown,
    ) {
      const entry = find(taskId);
      const run = entry.runs.find(
        (value) => value.id === runId && value.status === "waiting",
      );
      if (!run || typeof actionId !== "string")
        throw new Error("This task preview has expired.");
      const child = children.get(run.id);
      if (!child)
        throw new Error(
          "This task preview has expired. Ask for a fresh preview.",
        );
      if (!validPrepared(run)) throw new Error("Invalid task scope");
      const version = revision(entry.task.id);
      if (method === "confirm") await check(entry.task.id, seal(run));
      const fresh = find(taskId);
      if (
        revision(fresh.task.id) !== version ||
        !fresh.runs.some(
          (current) => current.id === runId && current.status === "waiting",
        ) ||
        children.get(run.id) !== child
      )
        throw new Error(
          "This task preview changed or was cancelled. Review it again.",
        );
      await child.action(method, actionId);
      finish(run.id, child.snapshot());
    },
    detail(taskId: unknown, runId?: unknown): AssistantTaskDetail {
      const entry = find(taskId);
      const runs = entry.runs.map(receipt);
      if (runId === undefined) return { task: summary(entry), runs };
      const run = entry.runs.find((item) => item.id === runId);
      if (!run) throw new Error("This task run is no longer available.");
      const child = children.get(run.id);
      let messages = child?.snapshot().messages;
      if (!messages) {
        try {
          const statePath = join(
            runDirectory(entry.task.id, run.id),
            "state.json",
          );
          assertSafeDataPath(statePath);
          if (statSync(statePath).size <= 3_000_000) {
            const saved = JSON.parse(readFileSync(statePath, "utf8"));
            if (
              isAssistantSnapshot({
                ...saved,
                instance_id: "saved-task",
                revision: 0,
                running: false,
                error: null,
                auth: null,
                providers: [],
                models: [],
              })
            )
              messages = saved.messages;
          }
        } catch {}
      }
      messages = Array.isArray(messages) ? structuredClone(messages) : [];
      if (!child)
        for (const message of messages)
          for (const action of message.actions ?? [])
            if (action.status === "pending" || action.status === "executing") {
              action.status = "cancelled";
              action.detail =
                "This task preview expired. Ask Ranger for a fresh preview.";
            }
      return { task: summary(entry), runs, run: { ...receipt(run), messages } };
    },
    async resume() {
      if (disposed || invalid) return;
      enabled = true;
      started = true;
      fault = null;
      retryAt.clear();
      for (const entry of tasks) {
        const run = current(entry);
        if (!run || children.has(run.id)) continue;
        if (run.status === "waiting") {
          // Prepared write closures cannot survive a restart; never reconstruct
          // or automatically confirm an old preview.
          change(() => {
            run.status = "failed";
            run.finished_at = now();
            run.error =
              "The bridge restarted and task action previews expired. Ask Ranger for a fresh preview.";
            compact(run);
          });
        } else if (run.status === "running" && !busy)
          track(launch(entry, run, true));
      }
      await children.get(busy ?? "")?.resume();
      await tick();
    },
    async dispose() {
      disposed = true;
      controller.abort(new Error("Ranger tasks paused"));
      if (timer) clearTimeout(timer);
      await Promise.allSettled(
        [...children.values()].map((child) => child.dispose()),
      );
      await Promise.allSettled(jobs);
      children.clear();
      storage?.close();
    },
  };
}

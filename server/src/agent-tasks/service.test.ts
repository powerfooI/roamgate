import { describe, expect, test } from "bun:test";
import type { AgentTask, AgentTaskSnapshot } from "../../../shared/agentTasks";
import { createAgentTaskService, syncBackComment } from "./service";
import { createMemoryAgentTaskStorage } from "./storage";

function setup(syncBack?: (task: AgentTask) => Promise<void>) {
  const pushes: AgentTaskSnapshot[] = [];
  const storage = createMemoryAgentTaskStorage();
  let sequence = 0;
  let clock = Date.parse("2026-11-04T00:00:00.000Z");
  const service = createAgentTaskService({
    storage,
    publish: (snapshot) => pushes.push(snapshot),
    syncBack,
    now: () => (clock += 1000),
    id: () => `task-${++sequence}`,
    publishDelayMs: 0,
  });
  return { service, storage, pushes };
}

const session = { tab_id: "tab-1", pane_id: "pane-1", terminal_id: "term-1" };

async function created(
  service: ReturnType<typeof setup>["service"],
  extra: Record<string, unknown> = {},
) {
  return (await service.handle("bridge.tasks.create", {
    title: "Fix LMS back-button redirect",
    prompt: "Implement SDS-1679",
    ...extra,
  })) as AgentTask;
}

describe("create", () => {
  test("drafts and queued tasks are stored and published (AC5, AC56, AC57)", async () => {
    const { service, storage, pushes } = setup();
    const draft = await created(service);
    const queued = await created(service, {
      status: "queued",
      jira_key: "sds-1679",
      jira_issue: { summary: "Back", type: "Bug", status: "To Do", assignee: "Ada" },
      sync_back: true,
      workspace_id: "w1",
      agent: "claude",
      connection_id: "local",
    });
    expect(draft.status).toBe("draft");
    expect(queued).toMatchObject({
      status: "queued",
      jira_key: "SDS-1679",
      sync_back: true,
      jira_issue: { summary: "Back", assignee: "Ada" },
    });
    expect(storage.list()).toHaveLength(2);
    expect(pushes.map((push) => push.revision)).toEqual([1, 2]);
    expect(pushes[1].tasks.map((task) => task.id)).toEqual(["task-2", "task-1"]);
  });

  test("validates required fields and ignores sync-back without an issue", async () => {
    const { service } = setup();
    await expect(created(service, { title: " " })).rejects.toThrow("Title");
    await expect(created(service, { prompt: "" })).rejects.toThrow("Prompt");
    await expect(created(service, { jira_key: "nope" })).rejects.toThrow(
      "issue key",
    );
    expect((await created(service, { sync_back: true })).sync_back).toBe(false);
  });
});

describe("lifecycle", () => {
  test("link_session starts a queued task (AC58)", async () => {
    const { service } = setup();
    const task = await created(service, { status: "queued" });
    const running = (await service.handle("bridge.tasks.link_session", {
      id: task.id,
      connection_id: "local",
      workspace_id: "w1",
      agent: "claude",
      session,
    })) as AgentTask;
    expect(running).toMatchObject({ status: "running", session, agent: "claude" });
    expect(running.started_at).toBeString();
    await expect(
      service.handle("bridge.tasks.link_session", {
        id: task.id,
        connection_id: "local",
        workspace_id: "w1",
        agent: "claude",
        session,
      }),
    ).rejects.toThrow("already been started");
  });

  test("a failed start keeps the task queued with its error (AC59)", async () => {
    const { service } = setup();
    const task = await created(service, { status: "queued" });
    const failed = (await service.handle("bridge.tasks.set_status", {
      id: task.id,
      status: "queued",
      error: "The agent did not start within 60 seconds.",
    })) as AgentTask;
    expect(failed.status).toBe("queued");
    expect(failed.last_error).toContain("60 seconds");
  });

  test("a task notification for the linked pane moves it to needs review (AC49)", async () => {
    const { service } = setup();
    const task = await created(service, { status: "queued" });
    await service.handle("bridge.tasks.link_session", {
      id: task.id,
      connection_id: "local",
      workspace_id: "w1",
      agent: "claude",
      session,
    });
    service.onTaskEvent({ connectionId: "other", paneId: "pane-1", kind: "completed" });
    service.onTaskEvent({ connectionId: "local", paneId: "pane-2", kind: "completed" });
    expect(service.snapshot().tasks[0].status).toBe("running");
    service.onTaskEvent({ connectionId: "local", paneId: "pane-1", kind: "blocked" });
    expect(service.snapshot().tasks[0].status).toBe("needs_review");
  });

  test("edit is limited to draft and queued tasks (AC48)", async () => {
    const { service } = setup();
    const task = await created(service);
    const edited = (await service.handle("bridge.tasks.update", {
      id: task.id,
      patch: { title: "New title", status: "queued" },
    })) as AgentTask;
    expect(edited).toMatchObject({ title: "New title", status: "queued" });
    await service.handle("bridge.tasks.set_status", { id: task.id, status: "done" });
    await expect(
      service.handle("bridge.tasks.update", { id: task.id, patch: { title: "x" } }),
    ).rejects.toThrow("draft or queued");
  });

  test("reopen returns a done task to the queue without its session", async () => {
    const { service } = setup();
    const task = await created(service, { status: "queued" });
    await service.handle("bridge.tasks.link_session", {
      id: task.id,
      connection_id: "local",
      workspace_id: "w1",
      agent: "claude",
      session,
    });
    await service.handle("bridge.tasks.set_status", { id: task.id, status: "done" });
    const reopened = (await service.handle("bridge.tasks.set_status", {
      id: task.id,
      status: "queued",
    })) as AgentTask;
    expect(reopened).toMatchObject({ status: "queued", session: null });
  });

  test("delete removes the task", async () => {
    const { service, storage } = setup();
    const task = await created(service);
    await service.handle("bridge.tasks.delete", { id: task.id });
    expect(storage.list()).toHaveLength(0);
    await expect(
      service.handle("bridge.tasks.delete", { id: task.id }),
    ).rejects.toThrow("no longer exists");
  });
});

describe("sync back", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("runs once when a synced task first becomes done (AC61, AC62)", async () => {
    const synced: string[] = [];
    const { service } = setup(async (task) => {
      synced.push(task.jira_key!);
    });
    const task = await created(service, { jira_key: "SDS-1", sync_back: true });
    await service.handle("bridge.tasks.set_status", { id: task.id, status: "done" });
    await flush();
    expect(synced).toEqual(["SDS-1"]);
    expect(service.snapshot().tasks[0].sync_result?.ok).toBe(true);
    await service.handle("bridge.tasks.set_status", { id: task.id, status: "queued" });
    await service.handle("bridge.tasks.set_status", { id: task.id, status: "done" });
    await flush();
    expect(synced).toEqual(["SDS-1"]);
  });

  test("records a failure without retrying (AC62)", async () => {
    let attempts = 0;
    const { service } = setup(async () => {
      attempts++;
      throw new Error('Commented on SDS-1, but no transition leads to "In Review".');
    });
    const task = await created(service, { jira_key: "SDS-1", sync_back: true });
    await service.handle("bridge.tasks.set_status", { id: task.id, status: "done" });
    await flush();
    const result = service.snapshot().tasks[0].sync_result;
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain("no transition");
    await service.handle("bridge.tasks.set_status", { id: task.id, status: "queued" });
    await service.handle("bridge.tasks.set_status", { id: task.id, status: "done" });
    await flush();
    expect(attempts).toBe(1);
  });

  test("skips tasks without sync-back", async () => {
    let attempts = 0;
    const { service } = setup(async () => {
      attempts++;
    });
    const task = await created(service, { jira_key: "SDS-1" });
    await service.handle("bridge.tasks.set_status", { id: task.id, status: "done" });
    await flush();
    expect(attempts).toBe(0);
  });
});

test("the comment names the task and agent", () => {
  expect(
    syncBackComment({ title: "Fix it", agent: "claude" } as AgentTask),
  ).toBe('Roamgate task "Fix it" was completed by claude.');
});

test("tasks are reloaded from storage on start (AC4)", async () => {
  const first = setup();
  await created(first.service, { status: "queued" });
  const service = createAgentTaskService({
    storage: first.storage,
    publish: () => undefined,
    publishDelayMs: 0,
  });
  expect(
    ((await service.handle("bridge.tasks.list", {})) as AgentTaskSnapshot).tasks,
  ).toHaveLength(1);
});

import { afterEach, describe, expect, jest, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssistantSnapshot,
  AssistantTaskNotification,
  AssistantWorkspace,
} from "../../../shared/assistant";
import {
  ASSISTANT_MAX_CUSTOM_MODELS,
  isAssistantSnapshot,
} from "../../../shared/assistant";
import {
  type AssistantContext,
  AssistantRecoveryNotReadyError,
} from "./context";
import { type AssistantDriver, createPiDriver } from "./pi-driver";
import { createAssistantService } from "./service";
import type { PreparedAssistantAction } from "./actions";

const workspace: AssistantWorkspace = {
  connection_id: "local",
  workspace_id: "ws",
  connection_label: "Local",
  label: "Workspace",
  runtime_generation: 7,
};
const catalog = {
  providers: [
    {
      id: "test",
      label: "Test",
      methods: ["api_key" as const, "oauth" as const],
      configured: true,
    },
  ],
  models: [{ provider: "test", id: "model", label: "Model" }],
};
const configured = {
  provider: "test",
  model: "model",
  credential_source: "assistant",
  allowed_workspaces: [{ connection_id: "local", workspace_id: "ws" }],
};
const temporary: string[] = [];
const services: ReturnType<typeof createAssistantService>[] = [];
function setup(
  overrides: Partial<AssistantDriver> = {},
  childDriver?: () => AssistantDriver,
) {
  const directory = mkdtempSync(join(tmpdir(), "roamgate-assistant-"));
  temporary.push(directory);
  const snapshots: AssistantSnapshot[] = [];
  const notifications: AssistantTaskNotification[] = [];
  const reads: {
    scope: AssistantWorkspace[];
    params: Record<string, unknown>;
  }[] = [];
  const context: AssistantContext = {
    catalog: async () => ({ workspaces: [workspace], errors: [] }),
    captureScope: async (scope) => {
      if (scope.some((ref) => ref.workspace_id !== workspace.workspace_id))
        throw new Error("Unknown workspace");
      return [structuredClone(workspace)];
    },
    read: async (_kind, scope, params) => {
      reads.push({ scope, params });
      return {
        text: "Workspace is working",
        sources: [
          {
            ...workspace,
            id: "source-1",
            kind: "status",
            title: "Status",
            read_at: "2026-10-03T00:00:00Z",
          },
        ],
      };
    },
  };
  const driver: AssistantDriver = {
    catalog: async () => structuredClone(catalog),
    login: async () => {},
    run: async (input) => {
      input.delta("Hello");
      input.message("Hello");
      return [{ persisted: true }];
    },
    stop: async () => {},
    dispose: async () => {},
    ...overrides,
  };
  const service = createAssistantService({
    directory,
    context,
    driver,
    createDriver: childDriver ? () => childDriver() : undefined,
    publish: (snapshot) => snapshots.push(snapshot),
    notify: (notification) => notifications.push(notification),
  });
  services.push(service);
  return {
    service,
    directory,
    snapshots,
    notifications,
    reads,
    context,
    driver,
  };
}
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("State did not settle");
}
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
  jest.useRealTimers();
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function stableTaskIdentity(context: AssistantContext) {
  context.recoveryScope = async (captured) =>
    captured.map((ref) => ({
      connection_id: ref.connection_id,
      workspace_id: ref.workspace_id,
      endpoint_fingerprint: "a".repeat(64),
      workspace_identity: "b".repeat(64),
      herdr_boot_id: "original-server",
    }));
  context.restoreScope = async (targets) =>
    targets.map((target) => ({
      ...workspace,
      workspace_id: target.workspace_id,
    }));
}
async function flushTasks() {
  for (let index = 0; index < 60; index++) await Promise.resolve();
}

function permissionAction(
  execute: PreparedAssistantAction["execute"],
): PreparedAssistantAction {
  return {
    preview: {
      ...workspace,
      workspace_label: workspace.label,
      kind: "create_tab",
      summary: "Create a tab",
      params: { cwd: "/repo" },
    },
    execute,
  };
}

test("live tool details persist while repeated call IDs explicitly clear stale details", async () => {
  const pointer = [{ type: "ranger-durable", id: randomUUID() }];
  const f = setup({
    run: async (input) => {
      input.tool("failed", "workspace_history", "running", {
        arguments: '{\n  "pane_id": "pane"\n}',
      });
      input.tool("failed", "workspace_history", "failed", {
        output: "Workspace tool unavailable.",
      });
      input.tool("reused", "workspace_status", "completed", {
        arguments: "{}",
        output: "Old result",
      });
      input.tool("reused", "workspace_status", "completed", {
        arguments: undefined,
        output: undefined,
      });
      input.message("Done");
      return pointer;
    },
  });
  await f.service.handle("configure", { config: configured });
  await f.service.handle("send", { text: "Read tools", request_id: "tools" });
  await until(() => !f.service.peek().running);
  const tools = f.service.peek().messages.at(-1)!.tools;
  expect(tools[0]).toMatchObject({
    status: "failed",
    arguments: '{\n  "pane_id": "pane"\n}',
    output: "Workspace tool unavailable.",
  });
  expect(tools[1]).toEqual({
    id: "reused",
    name: "workspace_status",
    status: "completed",
  });
  expect(
    JSON.parse(
      readFileSync(join(f.directory, "state.json"), "utf8"),
    ).messages.at(-1).tools,
  ).toEqual(tools);
  await f.service.dispose();
  const restored = createAssistantService({
    directory: f.directory,
    context: f.context,
    driver: f.driver,
    publish: () => {},
  });
  services.push(restored);
  expect((await restored.snapshot()).messages.at(-1)!.tools).toEqual(tools);
});

test("legacy tool details hydrate current and archived chats without rewriting their summaries", async () => {
  const pointer = [{ type: "ranger-durable", id: randomUUID() }];
  let runs = 0;
  let reads = 0;
  const f = setup({
    run: async (input) => {
      runs++;
      input.tool("legacy", "workspace_status", "completed");
      input.message("Done");
      return pointer;
    },
  });
  await f.service.handle("configure", { config: configured });
  await f.service.handle("send", { text: "Read status", request_id: "legacy" });
  await until(() => !f.service.peek().running);
  const sessionId = f.service.peek().session_id!;
  const statePath = join(f.directory, "state.json");
  const before = readFileSync(statePath, "utf8");
  f.driver.readToolDetails = async (entries, messages) => {
    reads++;
    expect(entries).toEqual(pointer);
    const result = structuredClone(messages);
    for (const message of result)
      for (const tool of message.tools)
        Object.assign(tool, { arguments: "{}", output: "Saved status" });
    return result;
  };
  const detailed = await f.service.handle("get", {});
  expect(detailed.messages.at(-1)!.tools[0]).toMatchObject({
    arguments: "{}",
    output: "Saved status",
  });
  expect(readFileSync(statePath, "utf8")).toBe(before);
  await f.service.handle("configure", { config: configured });
  expect(f.service.peek().messages.at(-1)!.tools[0]!.output).toBe(
    "Saved status",
  );
  expect(
    JSON.parse(readFileSync(statePath, "utf8")).messages.at(-1).tools[0].output,
  ).toBeUndefined();
  await f.service.handle("new_session", {});
  const archive = join(f.directory, "sessions", `${sessionId}.json`);
  expect(
    JSON.parse(readFileSync(archive, "utf8")).messages.at(-1).tools[0].output,
  ).toBeUndefined();
  const selected = await f.service.handle("select_session", {
    session_id: sessionId,
  });
  expect(selected.messages.at(-1)!.tools[0]!.output).toBe("Saved status");
  expect(reads).toBe(2);
  await f.service.dispose();
  const restored = createAssistantService({
    directory: f.directory,
    context: f.context,
    driver: f.driver,
    publish: () => {},
  });
  services.push(restored);
  expect((await restored.snapshot()).messages.at(-1)!.tools[0]!.arguments).toBe(
    "{}",
  );
  expect(runs).toBe(1);
});

test("an in-flight history read cannot restore details cleared by a live tool update", async () => {
  const done = Promise.withResolvers<unknown[]>();
  const reading = Promise.withResolvers<void>();
  const details = Promise.withResolvers<void>();
  let input: Parameters<AssistantDriver["run"]>[0] | undefined;
  const f = setup({
    run: async (next) => {
      input = next;
      next.tool("call", "workspace_status", "running");
      return done.promise;
    },
    readToolDetails: async (_entries, messages) => {
      reading.resolve();
      await details.promise;
      messages.at(-1)!.tools[0]!.arguments = '{"stale": true}';
      return messages;
    },
  });
  await f.service.handle("configure", { config: configured });
  await f.service.handle("send", { text: "Read status", request_id: "race" });
  await until(() => input !== undefined);
  const pending = f.service.snapshot();
  await reading.promise;
  input!.tool("call", "workspace_status", "completed", {
    arguments: undefined,
    output: undefined,
  });
  details.resolve();
  expect((await pending).messages.at(-1)!.tools[0]!.arguments).toBeUndefined();
  expect(f.service.peek().messages.at(-1)!.tools[0]!.arguments).toBeUndefined();
  done.resolve([]);
  await until(() => !f.service.peek().running);
});

test("legacy task run details read the child's saved durable pointer without rerunning it", async () => {
  jest.useFakeTimers();
  const pointer = [{ type: "ranger-durable", id: randomUUID() }];
  let runs = 0;
  const f = setup({}, () => ({
    ...f.driver,
    run: async (input) => {
      runs++;
      input.tool("child-call", "workspace_status", "completed");
      input.message("Saved task status");
      return pointer;
    },
  }));
  stableTaskIdentity(f.context);
  await f.service.handle("configure", { config: configured });
  const created = await f.service.handle("task.create", {
    request_id: randomUUID(),
    title: "Read status",
    prompt: "Read status",
    scope: configured.allowed_workspaces,
    schedule: { type: "interval", minutes: 1 },
  });
  const taskId = created.tasks![0]!.id;
  await f.service.resume();
  await f.service.handle("task.run_now", { task_id: taskId });
  jest.advanceTimersByTime(0);
  await flushTasks();
  const runId = (await f.service.taskDetail({ task_id: taskId })).runs[0]!.id;
  const sourceDirectory = join(f.directory, "tasks", taskId, "runs", runId);
  const statePath = join(sourceDirectory, "state.json");
  const before = readFileSync(statePath, "utf8");
  f.driver.readToolDetails = async (entries, messages, directory) => {
    expect(entries).toEqual(pointer);
    expect(directory).toBe(sourceDirectory);
    const result = structuredClone(messages);
    Object.assign(result.at(-1)!.tools[0]!, {
      arguments: "{}",
      output: "Saved task status",
    });
    return result;
  };
  const detailed = await f.service.taskDetail({
    task_id: taskId,
    run_id: runId,
  });
  expect(detailed.run!.messages.at(-1)!.tools[0]).toMatchObject({
    arguments: "{}",
    output: "Saved task status",
  });
  expect(readFileSync(statePath, "utf8")).toBe(before);
  expect(runs).toBe(1);
});

describe("Ranger approval policy", () => {
  test("auto actions and schedules return real receipts and retain durable admission", async () => {
    const pointer = [{ type: "ranger-durable", id: randomUUID() }];
    let writes = 0;
    const receipts: Record<string, unknown>[] = [];
    const f = setup({
      run: async (input) => {
        expect(input.config.approval_mode).toBe("auto");
        input.checkpoint!(pointer);
        receipts.push(
          JSON.parse(
            (
              await input.propose!(
                "create_tab",
                configured.allowed_workspaces[0]!,
              )
            ).text,
          ),
        );
        receipts.push(
          JSON.parse(
            (
              await input.task!("create", {
                title: "Read later",
                prompt: "Read verified status",
                scope: configured.allowed_workspaces,
                schedule: {
                  type: "once",
                  at: new Date(Date.now() + 3_600_000).toISOString(),
                },
              })
            ).text,
          ),
        );
        input.message("Verified tab and schedule created.");
        return pointer;
      },
    });
    stableTaskIdentity(f.context);
    f.context.prepareAction = async () =>
      permissionAction(async () => {
        writes++;
        const saved = JSON.parse(
          readFileSync(join(f.directory, "state.json"), "utf8"),
        );
        expect(saved.messages.at(-1).actions[0].status).toBe("executing");
        expect(saved.entries).toEqual(pointer);
        expect(saved.active_run.request_id).toBe("automatic");
        return { status: "succeeded", detail: "Verified new pane p2" };
      });
    await f.service.handle("configure", { config: configured });
    expect(f.service.peek().config.approval_mode).toBeUndefined();
    await f.service.handle("configure_approval", { approval_mode: "auto" });
    await f.service.handle("send", {
      request_id: "automatic",
      text: "Create a tab and schedule",
    });
    await until(() => !f.service.peek().running);
    expect(writes).toBe(1);
    expect(receipts[0]).toMatchObject({
      status: "succeeded",
      detail: "Verified new pane p2",
    });
    expect(receipts[1]).toMatchObject({ status: "confirmed" });
    expect(f.service.peek().tasks?.[0]?.approval_mode).toBe("auto");
    expect(f.service.peek().messages.at(-1)?.text).toContain("Verified");
    expect(isAssistantSnapshot(f.service.peek())).toBe(true);
  });

  test("revoking during action preparation leaves a pending receipt and blocks later effects", async () => {
    const preparing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let writes = 0;
    let receipt = "";
    const f = setup({
      run: async (input) => {
        receipt = (
          await input.propose!("create_tab", configured.allowed_workspaces[0]!)
        ).text;
        return [];
      },
    });
    f.context.prepareAction = async () => {
      preparing.resolve();
      await release.promise;
      return permissionAction(async () => {
        writes++;
        return { status: "succeeded", detail: "Created" };
      });
    };
    await f.service.handle("configure", { config: configured });
    await f.service.handle("configure_approval", { approval_mode: "auto" });
    await f.service.handle("send", { request_id: "revoke", text: "Create" });
    await preparing.promise;
    await expect(
      f.service.handle("configure_approval", { approval_mode: "auto" }),
    ).rejects.toThrow("busy");
    await f.service.handle("configure_approval", { approval_mode: "manual" });
    release.resolve();
    await until(() => !f.service.peek().running);
    expect(JSON.parse(receipt).status).toBe("pending");
    expect(writes).toBe(0);
  });

  // Preparation, proposal creation, and automatic confirmation revalidate.
  test.each([1, 2, 3])(
    "revoking during task validation %i keeps manual confirmation manual after re-enabling auto",
    async (validation) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const childFinished = Promise.withResolvers<void>();
      let preparing = false;
      let checks = 0;
      let writes = 0;
      let receipt = "";
      const f = setup(
        {
          catalog: async () => {
            if (preparing && ++checks === validation) {
              entered.resolve();
              await release.promise;
            }
            return catalog;
          },
          run: async (input) => {
            preparing = true;
            receipt = (
              await input.task!("create", {
                title: "Create later",
                prompt: "Create a tab",
                scope: configured.allowed_workspaces,
                schedule: {
                  type: "once",
                  at: new Date(Date.now() + 3_600_000).toISOString(),
                },
              })
            ).text;
            return [];
          },
        },
        () => ({
          catalog: async () => catalog,
          login: async () => {},
          stop: async () => {},
          dispose: async () => {},
          run: async (input) => {
            expect(input.config.approval_mode).toBe("manual");
            await input.propose!(
              "create_tab",
              configured.allowed_workspaces[0]!,
            );
            childFinished.resolve();
            return [];
          },
        }),
      );
      stableTaskIdentity(f.context);
      f.context.prepareAction = async () =>
        permissionAction(async () => {
          writes++;
          return { status: "succeeded", detail: "Created" };
        });
      await f.service.handle("configure", { config: configured });
      await f.service.handle("configure_approval", { approval_mode: "auto" });
      await f.service.handle("send", {
        request_id: "revoke-task",
        text: "Schedule a tab",
      });
      await entered.promise;
      await f.service.handle("configure_approval", {
        approval_mode: "manual",
      });
      release.resolve();
      await until(() => !f.service.peek().running);
      const proposal = JSON.parse(receipt);
      expect(proposal.status).toBe("pending");
      await f.service.handle("task.confirm_proposal", {
        proposal_id: proposal.id,
      });
      const task = f.service.peek().tasks![0]!;
      expect(task.approval_mode).toBe("manual");
      await f.service.handle("configure_approval", { approval_mode: "auto" });
      jest.useFakeTimers();
      await f.service.resume();
      await f.service.handle("task.run_now", { task_id: task.id });
      jest.advanceTimersByTime(0);
      await childFinished.promise;
      expect(writes).toBe(0);
    },
  );

  test("failed revocation preserves live action and streamed message references", async () => {
    const executing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = setup({
      run: async (input) => {
        input.delta("Before ");
        await input.propose!("create_tab", configured.allowed_workspaces[0]!);
        input.delta("after");
        return [];
      },
    });
    f.context.prepareAction = async () =>
      permissionAction(async () => {
        executing.resolve();
        await release.promise;
        return { status: "succeeded", detail: "Verified" };
      });
    await f.service.handle("configure", { config: configured });
    await f.service.handle("configure_approval", { approval_mode: "auto" });
    await f.service.handle("send", {
      request_id: "failed-revoke",
      text: "Create",
    });
    await executing.promise;
    const path = join(f.directory, "state.json");
    renameSync(path, `${path}.backup`);
    mkdirSync(path);
    try {
      await expect(
        f.service.handle("configure_approval", { approval_mode: "manual" }),
      ).rejects.toThrow("could not be saved");
      expect(f.service.peek().config.approval_mode).toBe("auto");
    } finally {
      rmSync(path, { recursive: true });
      renameSync(`${path}.backup`, path);
      release.resolve();
    }
    await until(() => !f.service.peek().running);
    expect(f.service.peek().messages.at(-1)?.actions?.[0]?.status).toBe(
      "succeeded",
    );
    expect(f.service.peek().messages.at(-1)?.text).toBe("Before after");
    expect(
      JSON.parse(readFileSync(path, "utf8")).messages.at(-1).actions[0].status,
    ).toBe("succeeded");
  });

  test("Stop retains an outstanding automatic effect until its receipt settles", async () => {
    const executing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = setup({
      run: async (input) => {
        const effect = input.propose!(
          "create_tab",
          configured.allowed_workspaces[0]!,
        );
        await Promise.race([
          effect,
          new Promise<void>((resolve) =>
            input.signal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          ),
        ]);
        return [];
      },
    });
    f.context.prepareAction = async () =>
      permissionAction(async () => {
        executing.resolve();
        await release.promise;
        return { status: "succeeded", detail: "Created before Stop" };
      });
    await f.service.handle("configure", { config: configured });
    await f.service.handle("configure_approval", { approval_mode: "auto" });
    await f.service.handle("send", { request_id: "stop-auto", text: "Create" });
    await executing.promise;
    await f.service.handle("stop", {});
    expect(f.service.peek().running).toBe(false);
    expect(f.service.peek().messages.at(-1)?.actions?.[0]?.status).toBe(
      "executing",
    );
    await expect(f.service.handle("new_session", {})).rejects.toThrow("busy");
    await expect(
      f.service.handle("configure", { config: configured }),
    ).rejects.toThrow("busy");
    release.resolve();
    await until(
      () =>
        f.service.peek().messages.at(-1)?.actions?.[0]?.status === "succeeded",
    );
    expect(
      JSON.parse(
        readFileSync(join(f.directory, "state.json"), "utf8"),
      ).messages.at(-1).actions[0].status,
    ).toBe("succeeded");
    await f.service.handle("new_session", {});
  });

  test("a delayed connection save preserves the latest permission mode", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = setup();
    await f.service.handle("configure", { config: configured });
    await f.service.handle("configure_approval", { approval_mode: "auto" });
    f.driver.catalog = async () => {
      entered.resolve();
      await release.promise;
      return catalog;
    };
    const saving = f.service.handle("configure", {
      config: { ...configured, approval_mode: "auto" },
    });
    await entered.promise;
    await f.service.handle("configure_approval", { approval_mode: "manual" });
    release.resolve();
    await saving;
    expect(f.service.peek().config.approval_mode).toBe("manual");
    await f.service.handle("configure", {
      config: { ...configured, approval_mode: "auto" },
    });
    expect(f.service.peek().config.approval_mode).toBe("manual");
  });

  test("scheduled tasks require both their saved auto policy and current global permission", async () => {
    jest.useFakeTimers({ now: Date.parse("2026-10-05T00:00:00Z") });
    const policies: (string | undefined)[] = [];
    const thirdTurn = Promise.withResolvers<void>();
    const releaseThird = Promise.withResolvers<void>();
    let writes = 0;
    const f = setup({}, () => ({
      catalog: async () => catalog,
      login: async () => {},
      stop: async () => {},
      dispose: async () => {},
      run: async (input) => {
        policies.push(input.config.approval_mode);
        if (policies.length === 3) {
          thirdTurn.resolve();
          await releaseThird.promise;
        }
        await input.propose!("create_tab", configured.allowed_workspaces[0]!);
        return [];
      },
    }));
    stableTaskIdentity(f.context);
    f.context.prepareAction = async () =>
      permissionAction(async () => {
        writes++;
        return { status: "succeeded", detail: "Created" };
      });
    await f.service.handle("configure", { config: configured });
    const create = async (title: string) => {
      await f.service.handle("task.create", {
        request_id: randomUUID(),
        title,
        prompt: "Create tab",
        scope: configured.allowed_workspaces,
        schedule: { type: "interval", minutes: 60 },
      });
      return f.service.peek().tasks!.find((task) => task.title === title)!.id;
    };
    const oldManual = await create("Old manual");
    await f.service.handle("configure_approval", { approval_mode: "auto" });
    const savedAuto = await create("Saved auto");
    expect(
      f.service.peek().tasks!.find((task) => task.id === savedAuto)
        ?.approval_mode,
    ).toBe("auto");
    await f.service.resume();
    const run = async (id: string) => {
      await f.service.handle("task.run_now", { task_id: id });
      jest.advanceTimersByTime(0);
      await flushTasks();
    };
    await run(oldManual);
    expect(writes).toBe(0);
    const waiting = await f.service.taskDetail({
      task_id: oldManual,
      run_id: f.service.peek().tasks!.find((task) => task.id === oldManual)!
        .current_run!.id,
    });
    expect(waiting.task.current_run?.status).toBe("waiting");
    await f.service.handle("task.action.cancel", {
      task_id: oldManual,
      run_id: waiting.task.current_run!.id,
      action_id: waiting.run!.messages.at(-1)!.actions![0]!.id,
    });
    await flushTasks();
    await run(savedAuto);
    expect(writes).toBe(1);
    await f.service.handle("configure_approval", { approval_mode: "manual" });
    await run(savedAuto);
    await thirdTurn.promise;
    await f.service.handle("configure_approval", { approval_mode: "auto" });
    releaseThird.resolve();
    await flushTasks();
    expect(writes).toBe(1);
    expect(policies).toEqual(["manual", "auto", "manual"]);
  });
});

describe("Ranger scheduled task service", () => {
  test("editing a completed one-time task cannot repeat its auto-approved workspace write", async () => {
    jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
    let writes = 0;
    const starts: string[] = [];
    const f = setup({}, () => ({
      catalog: async () => catalog,
      login: async () => {},
      stop: async () => {},
      dispose: async () => {},
      run: async (input) => {
        starts.push(input.requestId!);
        await input.propose!("create_tab", configured.allowed_workspaces[0]!);
        return [];
      },
    }));
    stableTaskIdentity(f.context);
    f.context.prepareAction = async () =>
      permissionAction(async () => {
        writes++;
        return { status: "succeeded", detail: "Created" };
      });
    await f.service.handle("configure", { config: configured });
    await f.service.handle("configure_approval", { approval_mode: "auto" });
    const input = {
      title: "Create tab once",
      prompt: "Create a tab",
      scope: configured.allowed_workspaces,
      schedule: { type: "once", at: "2026-10-04T00:01:00.000Z" },
    };
    const created = await f.service.handle("task.create", {
      ...input,
      request_id: randomUUID(),
    });
    const task = created.tasks![0]!;
    await f.service.resume();
    jest.advanceTimersByTime(60_000);
    await flushTasks();
    expect(writes).toBe(1);
    expect(f.service.peek().tasks![0]!.next_run_at).toBeNull();
    expect(
      (await f.service.taskDetail({ task_id: task.id })).runs[0]!.status,
    ).toBe("succeeded");
    for (const edit of [
      { title: "Renamed completed task" },
      { prompt: "Edited instructions" },
      { notification_mode: "agent" },
      { schedule: { at: "2026-10-04T00:01:00Z", type: "once" } },
    ]) {
      await f.service.handle("task.update", {
        ...input,
        ...edit,
        task_id: task.id,
      });
      jest.advanceTimersByTime(0);
      await flushTasks();
      expect(f.service.peek().tasks![0]!.next_run_at).toBeNull();
      expect(writes).toBe(1);
    }
    await f.service.resume();
    jest.advanceTimersByTime(600_000);
    await flushTasks();
    expect(starts).toHaveLength(1);
    expect(
      (await f.service.taskDetail({ task_id: task.id })).runs,
    ).toHaveLength(1);
  });

  test.each(["ready", "revoked permission", "replaced identity"] as const)(
    "a catalog failure releases a coalesced one-time run with a %s workspace",
    async (safety) => {
      jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
      const admission = Promise.withResolvers<void>();
      let starts = 0;
      const f = setup({}, () => ({
        catalog: async () => catalog,
        login: async () => {},
        stop: async () => {},
        dispose: async () => {},
        run: async () => {
          starts++;
          return [];
        },
      }));
      stableTaskIdentity(f.context);
      await f.service.handle("configure", configured);
      const created = await f.service.handle("task.create", {
        request_id: randomUUID(),
        title: "Check once",
        prompt: "Check status",
        scope: configured.allowed_workspaces,
        schedule: { type: "once", at: "2026-10-04T00:01:00.000Z" },
      });
      const taskId = created.tasks![0]!.id;
      await f.service.resume();
      await f.service.handle("task.run_now", { task_id: taskId });
      let catalogChecks = 0;
      f.driver.catalog = async () => {
        if (++catalogChecks === 1) await admission.promise;
        return catalog;
      };
      jest.advanceTimersByTime(0);
      await flushTasks();
      expect(catalogChecks).toBe(1);
      expect(starts).toBe(0);
      jest.advanceTimersByTime(60_000);
      await flushTasks();
      jest.advanceTimersByTime(0);
      await flushTasks();
      expect(f.service.peek().tasks![0]!.next_run_at).toBeNull();
      if (safety === "revoked permission")
        await f.service.handle("configure", {
          ...configured,
          allowed_workspaces: [],
        });
      if (safety === "replaced identity")
        f.context.restoreScope = async () => {
          throw new Error("Workspace identity changed");
        };
      admission.reject(new Error("Transient provider catalog failure"));
      await flushTasks();
      jest.advanceTimersByTime(0);
      await flushTasks();
      const detail = await f.service.taskDetail({ task_id: taskId });
      expect(detail.runs).toHaveLength(2);
      expect(detail.runs[1]!.status).toBe("failed");
      expect(detail.runs[0]!).toMatchObject({
        scheduled_at: "2026-10-04T00:01:00.000Z",
        status: safety === "ready" ? "succeeded" : "failed",
      });
      expect(starts).toBe(safety === "ready" ? 1 : 0);
      const checks = catalogChecks;
      jest.advanceTimersByTime(600_000);
      await flushTasks();
      expect(catalogChecks).toBe(checks);
      expect(starts).toBe(safety === "ready" ? 1 : 0);
    },
  );

  test("model connection edits defer task admission and cannot replace credentials during an active task", async () => {
    jest.useFakeTimers({ now: Date.parse("2026-10-05T00:00:00Z") });
    const editing = Promise.withResolvers<void>();
    const saved = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    let calls = 0;
    const f = setup(
      {
        configureModel: async () => {
          editing.resolve();
          await saved.promise;
        },
      },
      () => ({
        catalog: async () => catalog,
        login: async () => {},
        stop: async () => {
          finished.resolve();
        },
        dispose: async () => {
          finished.resolve();
        },
        run: async (input) => {
          calls++;
          await finished.promise;
          input.message("Done");
          return [];
        },
      }),
    );
    stableTaskIdentity(f.context);
    await f.service.handle("configure", configured);
    const task = await f.service.handle("task.create", {
      request_id: randomUUID(),
      title: "Scheduled check",
      prompt: "Check later",
      scope: configured.allowed_workspaces,
      schedule: { type: "interval", minutes: 60 },
    });
    await f.service.resume();
    await f.service.handle("task.run_now", { task_id: task.tasks![0].id });
    const connection = {
      provider: "custom-endpoint",
      model: "model",
      base_url: "http://localhost:1234/v1",
      api: "openai-completions",
      api_key: "synthetic-key",
      credential_source: "assistant",
    };
    const edit = f.service.handle("configure_model", connection);
    await editing.promise;
    jest.advanceTimersByTime(0);
    for (let count = 0; count < 5; count++) await flushTasks();
    expect(calls).toBe(0);
    expect(f.service.peek().tasks![0].current_run?.status).toBe("queued");
    saved.resolve();
    await edit;
    jest.advanceTimersByTime(5000);
    for (let count = 0; count < 5; count++) await flushTasks();
    expect(calls).toBe(1);
    expect(f.service.peek().tasks![0].current_run?.status).toBe("running");
    await expect(
      f.service.handle("configure_model", connection),
    ).rejects.toThrow("Stop the running Ranger task");
    finished.resolve();
    for (let count = 0; count < 5; count++) await flushTasks();
  });

  test("confirmed monitoring tasks send custom notifications and retain context without routine poll alerts", async () => {
    jest.useFakeTimers({ now: Date.parse("2026-10-05T00:00:00Z") });
    const inputs: Parameters<AssistantDriver["run"]>[0][] = [];
    const results: unknown[] = [];
    const f = setup(
      {
        run: async (input) => {
          expect(input.notify).toBeUndefined();
          input.message("Monitoring schedule can be proposed in chat.");
          return [];
        },
      },
      () => ({
        catalog: async () => catalog,
        login: async () => {},
        stop: async () => {},
        dispose: async () => {},
        run: async (input) => {
          inputs.push(input);
          await input.read("status", {});
          const result = await input.notify!({
            event_key:
              inputs.length < 3
                ? "pane-1:turn-7:completed"
                : "pane-1:turn-8:blocked",
            kind: inputs.length < 3 ? "completed" : "attention",
            title:
              inputs.length < 3
                ? "Agent finished verification"
                : "Agent needs your decision",
            body:
              inputs.length < 3
                ? "The tests passed. Open the task to review the evidence."
                : "The Agent needs input before continuing.",
          });
          results.push(JSON.parse(result.text));
          input.message("Checked Agent state and notification outcome.");
          return [];
        },
      }),
    );
    stableTaskIdentity(f.context);
    await f.service.handle("configure", { config: configured });
    await f.service.handle("send", {
      text: "Monitor later",
      request_id: "monitor-chat",
    });
    await flushTasks();
    expect(f.notifications).toEqual([]);
    const created = await f.service.handle("task.create", {
      request_id: randomUUID(),
      title: "Monitor Agent",
      prompt:
        "Notify only when the Agent finishes verification or needs input.",
      scope: configured.allowed_workspaces,
      schedule: { type: "interval", minutes: 60 },
      notification_mode: "agent",
    });
    const taskId = created.tasks![0]!.id;
    await f.service.resume();
    for (let index = 0; index < 3; index++) {
      await f.service.handle("task.run_now", { task_id: taskId });
      jest.advanceTimersByTime(0);
      for (let count = 0; count < 5; count++) await flushTasks();
      expect(f.service.peek().tasks![0].last_run?.status).toBe("succeeded");
    }
    expect(results).toEqual([
      { accepted: true, delivery: "best_effort" },
      { accepted: false, reason: "already_notified" },
      { accepted: true, delivery: "best_effort" },
    ]);
    expect(f.notifications).toHaveLength(2);
    expect(f.notifications[0]).toMatchObject({
      task_id: taskId,
      run_id: inputs[0].requestId,
      status: "succeeded",
      title: "Agent finished verification",
    });
    expect(f.notifications[1]).toMatchObject({
      task_id: taskId,
      run_id: inputs[2].requestId,
      status: "waiting",
      title: "Agent needs your decision",
    });
    expect(inputs[1].text).toContain("pane-1:turn-7:completed");
    expect(inputs[1].text).toContain("The tests passed.");
    await expect(
      inputs[2].notify!({
        event_key: "too-late",
        kind: "attention",
        title: "Late notice",
        body: "Must not send after completion.",
      }),
    ).rejects.toThrow("no longer active");
    expect(f.notifications).toHaveLength(2);
  });
  test("notifications recheck workspace identity after awaiting the provider catalog", async () => {
    jest.useFakeTimers({ now: Date.parse("2026-10-05T00:00:00Z") });
    const pendingCatalog = Promise.withResolvers<typeof catalog>();
    const done = Promise.withResolvers<unknown[]>();
    let delayCatalog = false;
    let catalogEntered = false;
    let input: Parameters<AssistantDriver["run"]>[0] | undefined;
    const f = setup(
      {
        catalog: async () => {
          if (!delayCatalog) return catalog;
          catalogEntered = true;
          return pendingCatalog.promise;
        },
      },
      () => ({
        catalog: async () => catalog,
        login: async () => {},
        stop: async () => {
          done.resolve([]);
        },
        dispose: async () => {
          done.resolve([]);
        },
        run: async (value) => {
          input = value;
          return done.promise;
        },
      }),
    );
    stableTaskIdentity(f.context);
    await f.service.handle("configure", { config: configured });
    const created = await f.service.handle("task.create", {
      request_id: randomUUID(),
      title: "Identity guard",
      prompt: "Notify when the Agent finishes.",
      scope: configured.allowed_workspaces,
      schedule: { type: "interval", minutes: 60 },
      notification_mode: "agent",
    });
    await f.service.resume();
    await f.service.handle("task.run_now", { task_id: created.tasks![0]!.id });
    jest.advanceTimersByTime(0);
    await flushTasks();
    expect(input).toBeDefined();
    const notification = {
      event_key: "agent-turn-1-completed",
      kind: "completed" as const,
      title: "Agent finished",
      body: "Open Ranger to review the result.",
    };
    delayCatalog = true;
    const attempt = input!.notify!(notification);
    await flushTasks();
    expect(catalogEntered).toBe(true);
    const restore = f.context.restoreScope!;
    f.context.restoreScope = async () => {
      throw new Error("The original workspace identity changed");
    };
    pendingCatalog.resolve(catalog);
    await expect(attempt).rejects.toThrow();
    expect(f.notifications).toEqual([]);
    f.context.restoreScope = restore;
    delayCatalog = false;
    expect(JSON.parse((await input!.notify!(notification)).text)).toEqual({
      accepted: true,
      delivery: "best_effort",
    });
    expect(f.notifications).toHaveLength(1);
    done.resolve([]);
    await flushTasks();
  });
  test("task tools filter the current turn, freeze proposals and require explicit confirmation", async () => {
    let listed = "";
    const pointer = [{ type: "ranger-durable", id: randomUUID() }];
    const done = Promise.withResolvers<unknown[]>();
    const input = {
      title: "Check later",
      prompt: "Read verified status",
      scope: configured.allowed_workspaces,
      schedule: {
        type: "once",
        at: new Date(Date.now() + 3_600_000).toISOString(),
      },
    };
    const f = setup({
      run: async (turn) => {
        turn.checkpoint!(pointer);
        listed = (await turn.task!("list", {})).text;
        await expect(
          turn.task!("create", {
            ...input,
            scope: [{ connection_id: "local", workspace_id: "other" }],
          }),
        ).rejects.toThrow("authorized");
        await turn.task!("create", input);
        return done.promise;
      },
      dispose: async () => {
        done.resolve(pointer);
      },
    });
    stableTaskIdentity(f.context);
    f.context.captureScope = async (refs) =>
      refs.map((ref) => ({ ...workspace, workspace_id: ref.workspace_id }));
    await f.service.handle("configure", {
      config: {
        ...configured,
        allowed_workspaces: [
          ...configured.allowed_workspaces,
          { connection_id: "local", workspace_id: "other" },
        ],
      },
    });
    await f.service.handle("task.create", {
      ...input,
      request_id: randomUUID(),
    });
    await f.service.handle("task.create", {
      ...input,
      title: "Other private task",
      scope: [{ connection_id: "local", workspace_id: "other" }],
      request_id: randomUUID(),
    });
    await f.service.handle("send", {
      text: "Schedule a check",
      request_id: "proposal-turn",
      scope: configured.allowed_workspaces,
    });
    await until(
      () => !!f.service.peek().messages.at(-1)?.task_proposals?.length,
    );
    const before = f.service.peek();
    expect(before.error).toBeNull();
    expect(before.tasks).toHaveLength(2);
    expect(before.messages.at(-1)?.task_proposals?.[0]?.status).toBe("pending");
    expect(listed).toContain("Check later");
    expect(listed).not.toContain("Other private task");
    expect(listed).not.toContain("endpoint_fingerprint");
    expect(JSON.parse(listed)).toMatchObject({
      time_zone: expect.any(String),
      now: expect.any(String),
    });
    const id = before.messages.at(-1)!.task_proposals![0]!.id;
    await expect(
      f.service.handle("task.confirm_proposal", {
        proposal_id: id,
        prompt: "Changed by browser",
      }),
    ).rejects.toThrow("only");
    await Promise.all([
      f.service.handle("task.confirm_proposal", { proposal_id: id }),
      f.service.handle("task.confirm_proposal", { proposal_id: id }),
    ]);
    const confirmed = f.service.peek();
    expect(confirmed.tasks).toHaveLength(3);
    expect(confirmed.messages.at(-1)?.task_proposals?.[0]?.status).toBe(
      "confirmed",
    );
    expect(confirmed.tasks?.[0]?.prompt).toBe(input.prompt);
    expect(isAssistantSnapshot(confirmed)).toBe(true);
    const saved = JSON.parse(
      readFileSync(join(f.directory, "state.json"), "utf8"),
    );
    expect(saved.messages.at(-1).task_proposals[0].status).toBe("confirmed");
    expect(saved.entries).toEqual(pointer);
    expect(saved.active_run.request_id).toBe("proposal-turn");
    expect(confirmed.running).toBe(true);
    done.resolve(pointer);
    await until(() => !f.service.peek().running);
  });

  test("an isolated child can run beside the main chat and waits for a human before a workspace write", async () => {
    jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
    const mainDone = Promise.withResolvers<unknown[]>();
    const childDone = Promise.withResolvers<unknown[]>();
    const childInputs: Parameters<AssistantDriver["run"]>[0][] = [];
    let writes = 0;
    const childDriver: AssistantDriver = {
      catalog: async () => catalog,
      login: async () => {},
      run: async (input) => {
        childInputs.push(input);
        input.signal.addEventListener("abort", () => childDone.resolve([]));
        return childDone.promise;
      },
      stop: async () => {
        childDone.resolve([]);
      },
      dispose: async () => {
        childDone.resolve([]);
      },
    };
    const f = setup(
      {
        run: async (input) => {
          input.message("Main chat answer");
          return mainDone.promise;
        },
        dispose: async () => {
          mainDone.resolve([]);
        },
      },
      () => childDriver,
    );
    stableTaskIdentity(f.context);
    f.context.prepareAction = async () => ({
      preview: {
        ...workspace,
        workspace_label: workspace.label,
        kind: "send_prompt",
        params: { prompt: "Inspect" },
        summary: "Send Inspect",
      },
      execute: async () => {
        writes++;
        return { status: "succeeded", detail: "Accepted" };
      },
    });
    await f.service.handle("configure", { config: configured });
    const created = await f.service.handle("task.create", {
      request_id: randomUUID(),
      title: "Independent run",
      prompt: "Read status",
      scope: configured.allowed_workspaces,
      schedule: { type: "interval", minutes: 1 },
    });
    const taskId = created.tasks![0]!.id;
    await f.service.resume();
    await f.service.handle("send", {
      text: "Continue main chat",
      request_id: "main-busy",
    });
    await f.service.handle("task.run_now", { task_id: taskId });
    jest.advanceTimersByTime(0);
    await flushTasks();
    expect(childInputs).toHaveLength(1);
    expect(childInputs[0]!.task).toBeUndefined();
    expect(f.service.peek().running).toBe(true);
    expect((await childInputs[0]!.read("status", {})).sources).toHaveLength(1);
    await childInputs[0]!.propose!("send_prompt", {
      connection_id: "local",
      workspace_id: "ws",
      pane_id: "pane",
      prompt: "Inspect",
    });
    childInputs[0]!.message("Scheduled answer");
    childDone.resolve([]);
    await flushTasks();
    const waiting = await f.service.taskDetail({
      task_id: taskId,
      run_id: childInputs[0]!.requestId,
    });
    expect(waiting.task.current_run?.status).toBe("waiting");
    expect(waiting.run?.messages.at(-1)?.text).toBe("Scheduled answer");
    expect(f.service.peek().messages.at(-1)?.text).toBe("Main chat answer");
    expect(writes).toBe(0);
    expect(f.notifications).toEqual([
      {
        task_id: taskId,
        run_id: childInputs[0]!.requestId!,
        status: "waiting",
        title: "Ranger task needs confirmation",
        body: "Independent run: needs your confirmation. Open Ranger to review the pending action.",
      },
    ]);
    const action = waiting.run!.messages.at(-1)!.actions![0]!;
    await f.service.handle("task.action.confirm", {
      task_id: taskId,
      run_id: childInputs[0]!.requestId,
      action_id: action.id,
    });
    await flushTasks();
    expect(writes).toBe(1);
    expect(
      (await f.service.taskDetail({ task_id: taskId })).task.last_run?.status,
    ).toBe("succeeded");
    mainDone.resolve([]);
    await flushTasks();
    expect(f.notifications.map((notification) => notification.status)).toEqual([
      "waiting",
      "succeeded",
    ]);
  });

  test("a model that completes during child admission still records its final receipt once", async () => {
    jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
    let starts = 0;
    const f = setup({}, () => ({
      catalog: async () => catalog,
      login: async () => {},
      run: async () => {
        starts++;
        return [];
      },
      stop: async () => {},
      dispose: async () => {},
    }));
    stableTaskIdentity(f.context);
    await f.service.handle("configure", configured);
    const task = (
      await f.service.handle("task.create", {
        request_id: randomUUID(),
        title: "Immediate response",
        prompt: "Inspect",
        scope: configured.allowed_workspaces,
        schedule: { type: "once", at: "2026-10-04T00:00:01.000Z" },
      })
    ).tasks![0]!;
    await f.service.resume();
    jest.advanceTimersByTime(1_000);
    await flushTasks();
    expect(
      (await f.service.taskDetail({ task_id: task.id })).runs[0]!.status,
    ).toBe("succeeded");
    await Promise.all([f.service.resume(), f.service.resume()]);
    expect(starts).toBe(1);
    expect(
      (await f.service.taskDetail({ task_id: task.id })).runs,
    ).toHaveLength(1);
  });

  test.each([2, 3, 4])(
    "a fresh task disconnecting during scope check %s requeues before any model admission",
    async (disconnectAt) => {
      jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
      const disposalGate = Promise.withResolvers<void>();
      const offline = { connection_id: "offline", workspace_id: "ws" };
      const inputs: Parameters<AssistantDriver["run"]>[0][] = [];
      const children: {
        done: ReturnType<typeof Promise.withResolvers<unknown[]>>;
        disposed: boolean;
      }[] = [];
      const f = setup({}, () => {
        const firstChild = children.length === 0;
        const child = {
          done: Promise.withResolvers<unknown[]>(),
          disposed: false,
        };
        children.push(child);
        return {
          catalog: async () => catalog,
          login: async () => {},
          run: async (input) => {
            inputs.push(input);
            return child.done.promise;
          },
          stop: async () => child.done.resolve([]),
          dispose: async () => {
            if (firstChild) await disposalGate.promise;
            child.disposed = true;
            child.done.resolve([]);
          },
        };
      });
      stableTaskIdentity(f.context);
      const capture = (refs: typeof configured.allowed_workspaces) =>
        refs.map((ref) => ({ ...workspace, ...ref }));
      f.context.captureScope = async (refs) => capture(refs);
      let armed = false;
      let blocked = false;
      let checks = 0;
      f.context.restoreScope = async (targets) => {
        if (
          targets.some(
            (target) => target.connection_id === offline.connection_id,
          )
        ) {
          checks++;
          if (armed && checks === disconnectAt) blocked = true;
          if (blocked)
            throw new AssistantRecoveryNotReadyError(
              "Private connection detail",
            );
        }
        return capture(targets);
      };
      await f.service.handle("configure", {
        ...configured,
        allowed_workspaces: [...configured.allowed_workspaces, offline],
      });
      const first = (
        await f.service.handle("task.create", {
          request_id: randomUUID(),
          title: "Fresh interrupted admission",
          prompt: "Inspect the offline workspace",
          scope: [offline],
          schedule: { type: "once", at: "2026-10-04T00:00:01.000Z" },
        })
      ).tasks![0]!;
      const second = (
        await f.service.handle("task.create", {
          request_id: randomUUID(),
          title: "Ready workspace",
          prompt: "Inspect the ready workspace",
          scope: configured.allowed_workspaces,
          schedule: { type: "interval", minutes: 1 },
        })
      ).tasks![0]!;
      await f.service.resume();
      checks = 0;
      armed = true;
      jest.advanceTimersByTime(1_000);
      await flushTasks();
      try {
        expect(
          (await f.service.taskDetail({ task_id: first.id })).runs[0]!.status,
        ).toBe("running");
        expect(inputs).toHaveLength(0);
        expect(children[0]!.disposed).toBe(false);
        await f.service.handle("task.pause", { task_id: second.id });
        await f.service.handle("task.resume", { task_id: second.id });
        expect(
          (await f.service.taskDetail({ task_id: first.id })).runs[0]!.status,
        ).toBe("running");
      } finally {
        disposalGate.resolve();
      }
      await flushTasks();
      const waiting = await f.service.taskDetail({ task_id: first.id });
      const original = waiting.runs[0]!;
      expect(original.status).toBe("queued");
      expect(original.started_at).toBeUndefined();
      expect(original.finished_at).toBeUndefined();
      expect(original.error).toContain("Waiting");
      expect(original.error).not.toContain("Private connection detail");
      expect(f.service.peek().error).toBeNull();
      expect(
        f.snapshots.every(
          (snapshot) =>
            !snapshot.tasks?.find((task) => task.id === first.id)?.last_run,
        ),
      ).toBe(true);
      expect(inputs).toHaveLength(0);
      expect(children).toHaveLength(1);
      expect(children[0]!.disposed).toBe(true);
      jest.advanceTimersByTime(4_000);
      await flushTasks();
      expect(children).toHaveLength(1);
      await f.service.handle("task.run_now", { task_id: second.id });
      jest.advanceTimersByTime(0);
      await flushTasks();
      expect(inputs).toHaveLength(1);
      expect(inputs[0]!.text).toContain("Inspect the ready workspace");
      armed = false;
      blocked = false;
      await Promise.all([f.service.resume(), f.service.resume()]);
      await flushTasks();
      expect(inputs).toHaveLength(1);
      children.at(-1)!.done.resolve([]);
      await flushTasks();
      jest.advanceTimersByTime(0);
      await flushTasks();
      expect(inputs).toHaveLength(2);
      expect(inputs[1]!.requestId).toBe(original.id);
      expect(inputs[1]!.recover).toBe(false);
      expect(inputs[1]!.entries).toEqual([]);
      await Promise.all([f.service.resume(), f.service.resume()]);
      expect(inputs).toHaveLength(2);
      children.at(-1)!.done.resolve([]);
      await flushTasks();
      const finished = await f.service.taskDetail({ task_id: first.id });
      expect(finished.runs).toHaveLength(1);
      expect(finished.runs[0]!.id).toBe(original.id);
      expect(finished.runs[0]!.scheduled_at).toBe(original.scheduled_at);
      expect(finished.runs[0]!.status).toBe("succeeded");
      expect(Date.parse(finished.runs[0]!.started_at!)).toBeGreaterThan(
        Date.parse(original.scheduled_at),
      );
    },
  );

  test.each([false, true])(
    "recovery waiting for a connection releases the task slot without losing checkpoints (disconnect after admission: %s)",
    async (disconnectAfterAdmission) => {
      jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
      const offline = { connection_id: "offline", workspace_id: "ws" };
      const inputs: Parameters<AssistantDriver["run"]>[0][] = [];
      const children: {
        done: ReturnType<typeof Promise.withResolvers<unknown[]>>;
        disposed: boolean;
      }[] = [];
      const checkpoint = [{ saved_read: "already completed" }];
      const createDriver = (): AssistantDriver => {
        const child = {
          done: Promise.withResolvers<unknown[]>(),
          disposed: false,
        };
        children.push(child);
        return {
          catalog: async () => catalog,
          login: async () => {},
          run: async (input) => {
            inputs.push(input);
            input.checkpoint?.(checkpoint);
            return child.done.promise;
          },
          stop: async () => {
            child.done.resolve(checkpoint);
          },
          dispose: async () => {
            child.disposed = true;
            child.done.resolve(checkpoint);
          },
        };
      };
      const f = setup({}, createDriver);
      stableTaskIdentity(f.context);
      const capture = (refs: typeof configured.allowed_workspaces) =>
        refs.map((ref) => ({ ...workspace, ...ref }));
      f.context.captureScope = async (refs) => capture(refs);
      let ready = true;
      let restoreChecks = 0;
      f.context.restoreScope = async (targets) => {
        if (
          targets.some(
            (target) => target.connection_id === offline.connection_id,
          )
        ) {
          restoreChecks++;
          if (!ready && !(disconnectAfterAdmission && restoreChecks === 1))
            throw new AssistantRecoveryNotReadyError(
              "Original connection is not ready",
            );
        }
        return capture(targets);
      };
      await f.service.handle("configure", {
        ...configured,
        allowed_workspaces: [...configured.allowed_workspaces, offline],
      });
      const first = (
        await f.service.handle("task.create", {
          request_id: randomUUID(),
          title: "Interrupted original run",
          prompt: "Inspect the offline workspace",
          scope: [offline],
          schedule: { type: "once", at: "2026-10-04T00:00:01.000Z" },
        })
      ).tasks![0]!;
      const second = (
        await f.service.handle("task.create", {
          request_id: randomUUID(),
          title: "Ready workspace",
          prompt: "Inspect the ready workspace",
          scope: configured.allowed_workspaces,
          schedule: { type: "interval", minutes: 1 },
        })
      ).tasks![0]!;
      await f.service.resume();
      jest.advanceTimersByTime(1_000);
      await flushTasks();
      expect(inputs).toHaveLength(1);
      const original = (await f.service.taskDetail({ task_id: first.id }))
        .runs[0]!;
      await f.service.handle("task.pause", { task_id: first.id });
      await f.service.handle("task.run_now", { task_id: second.id });
      await f.service.dispose();
      ready = false;
      restoreChecks = 0;
      const restored = createAssistantService({
        directory: f.directory,
        context: f.context,
        driver: f.driver,
        createDriver,
        publish: () => {},
      });
      services.push(restored);
      await restored.resume();
      await flushTasks();
      const waiting = await restored.taskDetail({
        task_id: first.id,
        run_id: original.id,
      });
      expect(waiting.run?.status).toBe("queued");
      expect(waiting.run?.started_at).toBe(original.started_at);
      expect(waiting.run?.finished_at).toBeUndefined();
      expect(waiting.run?.error).toContain("Waiting");
      expect(inputs).toHaveLength(1);
      if (disconnectAfterAdmission) expect(children[1]!.disposed).toBe(true);
      const statePath = join(
        f.directory,
        "tasks",
        first.id,
        "runs",
        original.id,
        "state.json",
      );
      const saved = JSON.parse(readFileSync(statePath, "utf8"));
      expect(saved.active_run.request_id).toBe(original.id);
      expect(saved.entries).toEqual(checkpoint);
      jest.advanceTimersByTime(0);
      await flushTasks();
      expect(inputs).toHaveLength(2);
      const healthy = inputs[1]!;
      expect(healthy.text).toContain("Inspect the ready workspace");
      ready = true;
      await Promise.all([restored.resume(), restored.resume()]);
      await flushTasks();
      expect(inputs).toHaveLength(2);
      children.at(-1)!.done.resolve([]);
      await flushTasks();
      jest.advanceTimersByTime(0);
      await flushTasks();
      expect(inputs).toHaveLength(3);
      expect(inputs[2]!.requestId).toBe(original.id);
      expect(inputs[2]!.recover).toBe(true);
      expect(inputs[2]!.entries).toEqual(checkpoint);
      await Promise.all([restored.resume(), restored.resume()]);
      expect(inputs).toHaveLength(3);
      children.at(-1)!.done.resolve(checkpoint);
      await flushTasks();
      const finished = await restored.taskDetail({ task_id: first.id });
      expect(finished.runs).toHaveLength(1);
      expect(finished.runs[0]!.status).toBe("succeeded");
      expect(finished.runs[0]!.started_at).toBe(original.started_at);
      expect(finished.task.status).toBe("paused");
    },
  );

  test("workspace identity reuse and global permission tightening fail closed throughout a child read", async () => {
    jest.useFakeTimers({ now: Date.parse("2026-10-04T00:00:00Z") });
    const done = Promise.withResolvers<unknown[]>();
    const readDone = Promise.withResolvers<{ text: string; sources: [] }>();
    let input: Parameters<AssistantDriver["run"]>[0] | undefined;
    const childDriver: AssistantDriver = {
      catalog: async () => catalog,
      login: async () => {},
      run: async (value) => {
        input = value;
        value.signal.addEventListener("abort", () => done.resolve([]));
        return done.promise;
      },
      stop: async () => {
        done.resolve([]);
      },
      dispose: async () => {
        done.resolve([]);
      },
    };
    const f = setup({}, () => childDriver);
    stableTaskIdentity(f.context);
    await f.service.handle("configure", { config: configured });
    const taskId = (
      await f.service.handle("task.create", {
        request_id: randomUUID(),
        title: "Scope guard",
        prompt: "Inspect",
        scope: configured.allowed_workspaces,
        schedule: { type: "interval", minutes: 1 },
      })
    ).tasks![0]!.id;
    await f.service.resume();
    await f.service.handle("task.run_now", { task_id: taskId });
    jest.advanceTimersByTime(0);
    await flushTasks();
    const restore = f.context.restoreScope!;
    f.context.restoreScope = async () => {
      throw new Error("Same workspace ID now points at a different repository");
    };
    await expect(input!.read("status", {})).rejects.toThrow();
    expect(f.reads).toHaveLength(0);
    await expect(
      f.service.handle("task.run_now", { task_id: taskId }),
    ).rejects.toThrow();
    f.context.restoreScope = restore;
    f.context.read = async () => readDone.promise;
    const read = input!.read("status", {});
    await flushTasks();
    await f.service.handle("configure", {
      config: { ...configured, allowed_workspaces: [] },
    });
    readDone.resolve({ text: "New private contents", sources: [] });
    await expect(read).rejects.toThrow();
    expect(input!.signal.aborted).toBe(true);
    expect(
      (await f.service.taskDetail({ task_id: taskId })).task.last_run?.status,
    ).toBe("stopped");
    await expect(
      f.service.handle("task.resume", { task_id: taskId }),
    ).rejects.toThrow();
  });
});

describe("bridge-global assistant", () => {
  test("interactive not-ready errors remain sanitized and release admission for a retry", async () => {
    const f = setup();
    await f.service.handle("configure", configured);
    const capture = f.context.captureScope;
    f.context.captureScope = async () => {
      throw new AssistantRecoveryNotReadyError("Private connection detail");
    };
    const params = { request_id: "interactive-retry", text: "Inspect" };
    const error = await f.service
      .handle("send", params)
      .catch((error) => error);
    expect(error).not.toBeInstanceOf(AssistantRecoveryNotReadyError);
    expect(error.cause).toBeUndefined();
    expect(error.message).toBe(
      "The workspace scope or provider connection is unavailable",
    );
    expect(f.service.peek().running).toBe(false);
    expect(JSON.stringify(f.snapshots)).not.toContain(
      "Private connection detail",
    );
    f.context.captureScope = capture;
    await f.service.handle("send", params);
    await until(() => !f.service.peek().running);
    expect(f.service.peek().messages.at(-1)?.text).toBe("Hello");
  });

  test("operation receipts from another workspace or runtime are excluded from model context", async () => {
    const inputs: Parameters<AssistantDriver["run"]>[0][] = [];
    const f = setup({
      run: async (input) => {
        inputs.push(input);
        if (inputs.length === 1)
          await input.propose!("send_prompt", {
            connection_id: "local",
            workspace_id: "ws",
            pane_id: "p1",
            prompt: "PRIVATE_REVIEW_CONTENT",
          });
        return [{ old: "private context" }];
      },
    });
    let generation = 7;
    f.context.captureScope = async (refs) =>
      refs.map((ref) => ({
        ...workspace,
        ...ref,
        runtime_generation: generation,
      }));
    f.context.prepareAction = async () => ({
      preview: {
        connection_id: "local",
        workspace_id: "ws",
        runtime_generation: 7,
        connection_label: "Local",
        workspace_label: "Workspace",
        kind: "send_prompt",
        summary: "Send feedback",
        params: { pane_id: "p1", prompt: "PRIVATE_REVIEW_CONTENT" },
      },
      execute: async () => ({ status: "uncertain", detail: "Accepted" }),
    });
    await f.service.handle("configure", {
      config: {
        ...configured,
        allowed_workspaces: [
          workspace,
          { connection_id: "local", workspace_id: "other" },
        ],
      },
    });
    await f.service.handle("send", {
      request_id: "one",
      text: "Send feedback",
      scope: [workspace],
    });
    await until(() => f.snapshots.at(-1)?.running === false);
    await f.service.handle("send", {
      request_id: "two",
      text: "Other workspace",
      scope: [{ connection_id: "local", workspace_id: "other" }],
    });
    await until(() => f.snapshots.at(-1)?.running === false);
    expect(inputs[1]!.text).not.toContain("PRIVATE_REVIEW_CONTENT");
    expect(inputs[1]!.entries).toEqual([]);
    generation = 8;
    await f.service.handle("send", {
      request_id: "three",
      text: "Replaced runtime",
      scope: [workspace],
    });
    await until(() => f.snapshots.at(-1)?.running === false);
    expect(inputs[2]!.text).not.toContain("PRIVATE_REVIEW_CONTENT");
    expect(inputs[2]!.entries).toEqual([]);
  });

  test("only explicit confirmation writes, persists admission first, and deduplicates concurrent confirmations", async () => {
    let calls = 0;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const f = setup({
      run: async (input) => {
        await input.propose!("create_workspace", {
          connection_id: "local",
          workspace_id: "ws",
          label: "Task",
        });
        input.message("Review the operation preview.");
        return [];
      },
    });
    f.context.prepareAction = async () => ({
      preview: {
        connection_id: "local",
        workspace_id: "ws",
        runtime_generation: 7,
        connection_label: "Local",
        workspace_label: "Workspace",
        kind: "create_workspace",
        summary: "Create Task",
        params: { cwd: "/repo", label: "Task" },
      },
      execute: async () => {
        calls++;
        const saved = JSON.parse(
          readFileSync(join(f.directory, "state.json"), "utf8"),
        );
        expect(saved.messages.at(-1).actions[0].status).toBe("executing");
        await gate;
        return { status: "succeeded", detail: "Workspace creation verified." };
      },
    });
    await f.service.handle("configure", { config: configured });
    await f.service.handle("send", {
      request_id: "proposal",
      text: "Create Task",
    });
    await until(() => f.snapshots.at(-1)?.running === false);
    const proposal = (await f.service.snapshot()).messages.at(-1)!.actions![0];
    expect(calls).toBe(0);
    expect(proposal.status).toBe("pending");
    await expect(
      f.service.handle("action.confirm", {
        action_id: proposal.id,
        params: { cwd: "/elsewhere" },
      }),
    ).rejects.toThrow("only the action identifier");
    await Promise.all([
      f.service.handle("action.confirm", { action_id: proposal.id }),
      f.service.handle("action.confirm", { action_id: proposal.id }),
    ]);
    expect(calls).toBe(1);
    await expect(
      f.service.handle("send", { request_id: "busy", text: "Hello" }),
    ).rejects.toThrow("busy");
    await expect(
      f.service.handle("configure", { config: configured }),
    ).rejects.toThrow("busy");
    await expect(
      f.service.handle("select_session", {
        session_id: (await f.service.snapshot()).session_id,
      }),
    ).rejects.toThrow("busy");
    await f.service.handle("stop", {});
    expect(
      (await f.service.snapshot()).messages.at(-1)!.actions![0].status,
    ).toBe("executing");
    finish();
    await until(
      () =>
        f.snapshots.at(-1)?.messages.at(-1)?.actions?.[0].status ===
        "succeeded",
    );
    await f.service.handle("action.confirm", { action_id: proposal.id });
    expect(calls).toBe(1);
    expect(isAssistantSnapshot(await f.service.snapshot())).toBe(true);
  });

  test("pending previews expire on cancellation, scope changes, new questions and bridge restart", async () => {
    let calls = 0;
    const f = setup({
      run: async (input) => {
        await input.propose!("start_agent", {
          connection_id: "local",
          workspace_id: "ws",
          pane_id: "p1",
          agent: "pi",
        });
        return [];
      },
    });
    f.context.prepareAction = async () => ({
      preview: {
        connection_id: "local",
        workspace_id: "ws",
        runtime_generation: 7,
        connection_label: "Local",
        workspace_label: "Workspace",
        kind: "start_agent",
        summary: "Start Pi",
        params: { pane_id: "p1", agent: "pi" },
      },
      execute: async () => {
        calls++;
        return { status: "succeeded", detail: "Started" };
      },
    });
    await f.service.handle("configure", { config: configured });
    const propose = async (id: string) => {
      await f.service.handle("send", { request_id: id, text: "Start Pi" });
      await until(() => f.snapshots.at(-1)?.running === false);
      return (await f.service.snapshot()).messages.at(-1)!.actions![0];
    };
    const first = await propose("one");
    await f.service.handle("action.cancel", { action_id: first.id });
    await f.service.handle("action.confirm", { action_id: first.id });
    expect(calls).toBe(0);
    const second = await propose("two");
    await propose("three");
    expect(
      (await f.service.snapshot()).messages
        .flatMap((message) => message.actions ?? [])
        .find((action) => action.id === second.id)?.status,
    ).toBe("cancelled");
    await f.service.handle("configure", {
      config: { ...configured, allowed_workspaces: [] },
    });
    expect(
      (await f.service.snapshot()).messages.at(-1)!.actions![0].status,
    ).toBe("cancelled");
    await f.service.handle("configure", { config: configured });
    const last = await propose("four");
    await f.service.dispose();
    const saved = JSON.parse(
      readFileSync(join(f.directory, "state.json"), "utf8"),
    );
    // Also exercise an interrupted receipt without issuing any real operation.
    saved.messages
      .at(-1)
      .actions.push({ ...last, id: "interrupted", status: "executing" });
    writeFileSync(join(f.directory, "state.json"), JSON.stringify(saved));
    const restored = createAssistantService({
      directory: f.directory,
      context: f.context,
      driver: f.driver,
      publish: () => {},
    });
    services.push(restored);
    const actions = (await restored.snapshot()).messages.flatMap(
      (message) => message.actions ?? [],
    );
    expect(actions.find((action) => action.id === last.id)?.status).toBe(
      "cancelled",
    );
    expect(actions.find((action) => action.id === "interrupted")?.status).toBe(
      "uncertain",
    );
    await restored.handle("action.confirm", { action_id: "interrupted" });
    await restored.handle("action.confirm", { action_id: last.id });
    expect(calls).toBe(0);
  });

  test("an unsaved confirmation cannot execute, and invalid action snapshots are rejected", async () => {
    let calls = 0;
    const f = setup({
      run: async (input) => {
        await input.propose!("send_prompt", {
          connection_id: "local",
          workspace_id: "ws",
          pane_id: "p1",
          prompt: "Review this change",
        });
        return [];
      },
    });
    f.context.prepareAction = async () => ({
      preview: {
        connection_id: "local",
        workspace_id: "ws",
        runtime_generation: 7,
        connection_label: "Local",
        workspace_label: "Workspace",
        kind: "send_prompt",
        summary: "Send review feedback",
        params: { pane_id: "p1", prompt: "Review this change" },
      },
      execute: async () => {
        calls++;
        throw new Error("secret=/private/token");
      },
    });
    await f.service.handle("configure", { config: configured });
    await f.service.handle("send", {
      request_id: "one",
      text: "Send feedback",
    });
    await until(() => f.snapshots.at(-1)?.running === false);
    const snapshot = await f.service.snapshot();
    const id = snapshot.messages.at(-1)!.actions![0].id;
    const tampered = structuredClone(snapshot);
    (
      tampered.messages.at(-1)!.actions![0].params as Record<string, unknown>
    ).prompt = { html: "invalid" };
    expect(isAssistantSnapshot(tampered)).toBe(false);
    rmSync(join(f.directory, "state.json"));
    mkdirSync(join(f.directory, "state.json"));
    await expect(
      f.service.handle("action.confirm", { action_id: id }),
    ).rejects.toThrow("Nothing was executed");
    expect(calls).toBe(0);
    rmSync(join(f.directory, "state.json"), { recursive: true });
    await f.service.handle("action.confirm", { action_id: id });
    await until(
      () =>
        f.snapshots.at(-1)?.messages.at(-1)?.actions?.[0].status ===
        "uncertain",
    );
    expect(calls).toBe(1);
    expect(JSON.stringify(await f.service.snapshot())).not.toContain("secret=");
    await f.service.handle("action.confirm", { action_id: id });
    expect(calls).toBe(1);
  });

  test("streams a bounded snapshot, deduplicates browser sends, freezes scope and rejects mutations while running", async () => {
    let calls = 0;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { service, snapshots, reads } = setup({
      run: async (input) => {
        calls++;
        expect(input.config.allowed_workspaces).toEqual(
          configured.allowed_workspaces,
        );
        expect(input.text).toContain('"runtime_generation":7');
        input.tool("read", "workspace_status", "running");
        expect(await input.read("status", {})).toMatchObject({
          text: "Workspace is working",
          sources: [{ id: "source-1", kind: "status" }],
        });
        input.delta("Answer ");
        input.delta("stream");
        await pending;
        input.message("Answer stream");
        input.tool("read", "workspace_status", "completed");
        return [{ finalized: true }];
      },
      stop: async () => {
        finish();
      },
    });
    await service.handle("configure", configured);
    const admitted = await service.handle("bridge.assistant.send", {
      request_id: "same",
      text: "How is it going?",
    });
    expect(admitted.running).toBe(true);
    await service.handle("send", { request_id: "same", text: "duplicate" });
    expect(calls).toBe(1);
    expect(reads[0]?.scope[0]?.runtime_generation).toBe(7);
    await expect(
      service.handle("send", { request_id: "new", text: "other" }),
    ).rejects.toThrow("busy");
    await expect(service.handle("configure", configured)).rejects.toThrow(
      "busy",
    );
    await expect(service.handle("new_session", {})).rejects.toThrow("busy");
    await expect(
      service.handle("select_session", { session_id: admitted.session_id }),
    ).rejects.toThrow("busy");
    const stopped = await service.handle("stop", {});
    expect(stopped.running).toBe(false);
    expect(stopped.messages[1]?.text).toBe("Answer stream");
    expect(stopped.messages[1]?.sources[0]?.id).toBe("source-1");
    expect(snapshots.at(-1)?.running).toBe(false);
  });

  test("persists finalized turns privately and restores deduplication after reconnect/restart", async () => {
    const { service, directory, context, driver, snapshots } = setup();
    await service.handle("configure", configured);
    await service.handle("send", {
      request_id: "persisted",
      text: "Remember this",
    });
    await until(() => snapshots.at(-1)?.running === false);
    const saved = JSON.parse(
      readFileSync(join(directory, "state.json"), "utf8"),
    );
    expect(saved.entries).toEqual([{ persisted: true }]);
    expect(saved.messages[1].text).toBe("Hello");
    if (process.platform !== "win32") {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(join(directory, "state.json")).mode & 0o777).toBe(0o600);
    }
    await service.dispose();
    const restored = createAssistantService({
      directory,
      context,
      driver,
      publish: () => {},
    });
    services.push(restored);
    const snapshot = await restored.handle("send", {
      request_id: "persisted",
      text: "duplicate after restart",
    });
    expect(snapshot.messages).toHaveLength(2);
    await expect(
      restored.handle("send", {
        request_id: "escape",
        text: "read outside",
        scope: [{ connection_id: "local", workspace_id: "outside" }],
      }),
    ).rejects.toThrow("authorized");
    await restored.handle("new_session", {});
    expect((await restored.snapshot()).messages).toEqual([]);
  });

  test("keeps separate conversations and restores transcript, SDK history and dedup IDs without reverting global configuration", async () => {
    const inputs: Parameters<AssistantDriver["run"]>[0][] = [];
    const f = setup({
      run: async (input) => {
        inputs.push(input);
        input.message(`Answer ${inputs.length}`);
        return [{ turn: inputs.length }];
      },
    });
    await f.service.handle("configure", configured);
    await f.service.handle("send", {
      request_id: "same-request",
      text: "First conversation\nMore details",
    });
    await until(() => f.snapshots.at(-1)?.running === false);
    const first = await f.service.snapshot();
    expect(first.sessions).toEqual([
      expect.objectContaining({
        id: first.session_id,
        title: "First conversation",
        message_count: 2,
      }),
    ]);
    const empty = await f.service.handle("new_session", {});
    expect(empty.session_id).not.toBe(first.session_id);
    expect(empty.messages).toEqual([]);
    expect(empty.sessions).toHaveLength(2);
    await f.service.handle("send", {
      request_id: "same-request",
      text: "Second conversation",
    });
    await until(() => f.snapshots.at(-1)?.running === false);
    const second = await f.service.snapshot();
    await f.service.handle("configure", {
      ...configured,
      credential_source: "pi",
    });
    const selected = await f.service.handle("select_session", {
      session_id: first.session_id,
    });
    expect(selected.messages).toEqual(first.messages);
    expect(selected.config.credential_source).toBe("pi");
    await f.service.handle("send", {
      request_id: "same-request",
      text: "Duplicate",
    });
    expect(inputs).toHaveLength(2);
    await f.service.handle("send", {
      request_id: "continue",
      text: "Continue",
    });
    await until(() => f.snapshots.at(-1)?.running === false);
    expect(inputs[2]?.entries).toEqual([{ turn: 1 }]);
    expect(inputs[2]?.config.credential_source).toBe("pi");
    if (process.platform !== "win32") {
      expect(statSync(join(f.directory, "sessions")).mode & 0o777).toBe(0o700);
      expect(
        statSync(join(f.directory, "sessions", `${first.session_id}.json`))
          .mode & 0o777,
      ).toBe(0o600);
    }
    await f.service.dispose();
    const restored = createAssistantService({
      directory: f.directory,
      context: f.context,
      driver: f.driver,
      publish: () => {},
    });
    services.push(restored);
    const restart = await restored.snapshot();
    expect(restart.session_id).toBe(first.session_id);
    expect(restart.sessions).toHaveLength(2);
    const old = await restored.handle("select_session", {
      session_id: second.session_id,
    });
    expect(old.messages).toEqual(second.messages);
    expect(old.config.credential_source).toBe("pi");
    await restored.handle("send", {
      request_id: "same-request",
      text: "Duplicate after switching and restarting",
    });
    expect(inputs).toHaveLength(3);
    expect(isAssistantSnapshot(await restored.snapshot())).toBe(true);
  });

  test("migrates the existing single chat and avoids accumulating empty conversations", async () => {
    const f = setup();
    await f.service.handle("configure", configured);
    await f.service.handle("send", {
      request_id: "old",
      text: `${"Long title ".repeat(20)}\nPrivate second line`,
    });
    await until(() => f.snapshots.at(-1)?.running === false);
    await f.service.dispose();
    const path = join(f.directory, "state.json");
    const legacy = JSON.parse(readFileSync(path, "utf8"));
    delete legacy.session_id;
    delete legacy.sessions;
    writeFileSync(path, JSON.stringify(legacy));
    const restored = createAssistantService({
      directory: f.directory,
      context: f.context,
      driver: f.driver,
      publish: () => {},
    });
    services.push(restored);
    const original = await restored.snapshot();
    expect(original.messages).toEqual(legacy.messages);
    expect(JSON.parse(readFileSync(path, "utf8")).session_id).toBe(
      original.session_id,
    );
    expect(original.sessions?.[0]?.title).toBe(
      legacy.messages[0].text.split("\n")[0].slice(0, 72),
    );
    const empty = await restored.handle("new_session", {});
    expect(empty.sessions).toHaveLength(2);
    const another = await restored.handle("new_session", {});
    expect(another.sessions).toHaveLength(2);
    expect(
      another.sessions?.find((session) => session.id === another.session_id)
        ?.title,
    ).toBe("New chat");
    expect(
      another.sessions?.some((session) => session.id === empty.session_id),
    ).toBe(false);
    expect(
      (
        await restored.handle("select_session", {
          session_id: original.session_id,
        })
      ).messages,
    ).toEqual(legacy.messages);
    expect((await restored.snapshot()).sessions).toHaveLength(1);
  });

  test("accepts legacy snapshots but rejects malformed session metadata without leaving an unusable service", async () => {
    const f = setup();
    const snapshot = await f.service.snapshot();
    const legacy = { ...snapshot };
    delete legacy.session_id;
    delete legacy.sessions;
    expect(isAssistantSnapshot(legacy)).toBe(true);
    expect(
      isAssistantSnapshot({ ...legacy, session_id: snapshot.session_id }),
    ).toBe(false);
    expect(
      isAssistantSnapshot({ ...legacy, sessions: snapshot.sessions }),
    ).toBe(false);
    expect(
      isAssistantSnapshot({
        ...snapshot,
        sessions: [{ ...snapshot.sessions![0]!, id: "../secret" }],
      }),
    ).toBe(false);
    expect(
      isAssistantSnapshot({
        ...snapshot,
        sessions: [...snapshot.sessions!, ...snapshot.sessions!],
      }),
    ).toBe(false);
    expect(
      isAssistantSnapshot({
        ...snapshot,
        sessions: [{ ...snapshot.sessions![0]!, message_count: -1 }],
      }),
    ).toBe(false);
    await f.service.handle("configure", configured);
    await f.service.dispose();
    const path = join(f.directory, "state.json");
    const saved = JSON.parse(readFileSync(path, "utf8"));
    for (const malformed of [
      { ...saved, sessions: undefined },
      { ...saved, session_id: undefined },
      null,
      42,
    ]) {
      writeFileSync(path, JSON.stringify(malformed));
      const restored = createAssistantService({
        directory: f.directory,
        context: f.context,
        driver: f.driver,
        publish: () => {},
      });
      services.push(restored);
      const result = await restored.snapshot();
      expect(result.error).toBe(
        "The saved Ranger session could not be loaded.",
      );
      expect(isAssistantSnapshot(result)).toBe(true);
      expect((await restored.handle("new_session", {})).messages).toEqual([]);
      await restored.dispose();
    }
  });

  test("rejects stale browser sends and invalid session selection without reading arbitrary paths or damaging the active chat", async () => {
    const f = setup();
    await f.service.handle("configure", configured);
    await f.service.handle("send", { request_id: "one", text: "Saved" });
    await until(() => f.snapshots.at(-1)?.running === false);
    const saved = await f.service.snapshot();
    const active = await f.service.handle("new_session", {});
    await expect(
      f.service.handle("send", {
        request_id: "one",
        text: "Wrong chat",
        session_id: saved.session_id,
      }),
    ).rejects.toThrow("active Ranger chat changed");
    for (const id of [
      "../state",
      "/tmp/secret",
      "",
      "00000000-0000-0000-0000-000000000000",
    ])
      await expect(
        f.service.handle("select_session", { session_id: id }),
      ).rejects.toThrow();
    await expect(
      f.service.handle("select_session", {
        session_id: saved.session_id,
        path: "state.json",
      }),
    ).rejects.toThrow("only a saved session identifier");
    const path = join(f.directory, "sessions", `${saved.session_id}.json`);
    const original = readFileSync(path, "utf8");
    writeFileSync(path, "secret=/private/provider-token");
    await expect(
      f.service.handle("select_session", { session_id: saved.session_id }),
    ).rejects.toThrow("The saved Ranger chat could not be loaded.");
    expect((await f.service.snapshot()).session_id).toBe(active.session_id);
    expect((await f.service.snapshot()).messages).toEqual([]);
    writeFileSync(path, "a".repeat(3_000_001));
    await expect(
      f.service.handle("select_session", { session_id: saved.session_id }),
    ).rejects.toThrow("The saved Ranger chat could not be loaded.");
    rmSync(path);
    symlinkSync(join(f.directory, "state.json"), path);
    await expect(
      f.service.handle("select_session", { session_id: saved.session_id }),
    ).rejects.toThrow("The saved Ranger chat could not be loaded.");
    rmSync(path);
    writeFileSync(path, original);
    expect(
      (
        await f.service.handle("select_session", {
          session_id: saved.session_id,
        })
      ).messages,
    ).toEqual(saved.messages);
  });

  test("restored conversations retain confirmed outcomes while their pending previews can never execute", async () => {
    let calls = 0;
    const f = setup({
      run: async (input) => {
        await input.propose!("start_agent", {
          connection_id: "local",
          workspace_id: "ws",
          pane_id: "p1",
          agent: "pi",
        });
        return [{ remembered: true }];
      },
    });
    f.context.prepareAction = async () => ({
      preview: {
        connection_id: "local",
        workspace_id: "ws",
        runtime_generation: 7,
        connection_label: "Local",
        workspace_label: "Workspace",
        kind: "start_agent",
        summary: "Start Pi",
        params: { pane_id: "p1", agent: "pi" },
      },
      execute: async () => {
        calls++;
        return { status: "succeeded", detail: "Started" };
      },
    });
    await f.service.handle("configure", configured);
    await f.service.handle("send", { request_id: "confirmed", text: "Start" });
    await until(() => f.snapshots.at(-1)?.running === false);
    const confirmed = (await f.service.snapshot()).messages.at(-1)!
      .actions![0]!;
    await f.service.handle("action.confirm", { action_id: confirmed.id });
    await until(
      () =>
        f.snapshots.at(-1)?.messages.at(-1)?.actions?.[0]?.status ===
        "succeeded",
    );
    await f.service.handle("send", { request_id: "pending", text: "Another" });
    await until(() => f.snapshots.at(-1)?.running === false);
    const old = await f.service.snapshot();
    const pending = old.messages.at(-1)!.actions![0]!;
    await f.service.handle("new_session", {});
    const archived = JSON.parse(
      readFileSync(
        join(f.directory, "sessions", `${old.session_id}.json`),
        "utf8",
      ),
    );
    expect(archived.messages.at(-1).actions[0].status).toBe("cancelled");
    const selected = await f.service.handle("select_session", {
      session_id: old.session_id,
    });
    expect(selected.messages[1]?.actions?.[0]).toEqual({
      ...confirmed,
      status: "succeeded",
      detail: "Started",
    });
    expect(selected.messages.at(-1)?.actions?.[0]?.status).toBe("cancelled");
    await f.service.handle("action.confirm", { action_id: pending.id });
    await f.service.handle("action.confirm", { action_id: confirmed.id });
    expect(calls).toBe(1);
  });

  test("archive and active save failures leave the previous conversation, history and pending confirmation intact", async () => {
    let calls = 0;
    const f = setup({
      run: async (input) => {
        await input.propose!("start_agent", {
          connection_id: "local",
          workspace_id: "ws",
          pane_id: "p1",
          agent: "pi",
        });
        return [{ current: true }];
      },
    });
    f.context.prepareAction = async () => ({
      preview: {
        connection_id: "local",
        workspace_id: "ws",
        runtime_generation: 7,
        connection_label: "Local",
        workspace_label: "Workspace",
        kind: "start_agent",
        summary: "Start Pi",
        params: { pane_id: "p1", agent: "pi" },
      },
      execute: async () => {
        calls++;
        return { status: "succeeded", detail: "Started" };
      },
    });
    await f.service.handle("configure", configured);
    await f.service.handle("send", { request_id: "first", text: "First" });
    await until(() => f.snapshots.at(-1)?.running === false);
    const first = await f.service.snapshot();
    await f.service.handle("new_session", {});
    await f.service.handle("send", { request_id: "second", text: "Second" });
    await until(() => f.snapshots.at(-1)?.running === false);
    const before = await f.service.snapshot();
    const index = join(f.directory, "state.json");
    const indexBefore = readFileSync(index, "utf8");
    const archivePath = join(
      f.directory,
      "sessions",
      `${before.session_id}.json`,
    );
    mkdirSync(archivePath);
    await expect(f.service.handle("new_session", {})).rejects.toThrow(
      "could not be saved",
    );
    expect(readFileSync(index, "utf8")).toBe(indexBefore);
    expect((await f.service.snapshot()).messages).toEqual(before.messages);
    expect((await f.service.snapshot()).sessions).toEqual(before.sessions);
    rmSync(archivePath, { recursive: true });
    renameSync(index, `${index}.backup`);
    mkdirSync(index);
    await expect(
      f.service.handle("select_session", { session_id: first.session_id }),
    ).rejects.toThrow("could not be saved");
    expect((await f.service.snapshot()).session_id).toBe(before.session_id);
    expect((await f.service.snapshot()).messages).toEqual(before.messages);
    expect((await f.service.snapshot()).sessions).toEqual(before.sessions);
    expect(readFileSync(`${index}.backup`, "utf8")).toBe(indexBefore);
    expect(
      JSON.parse(readFileSync(archivePath, "utf8")).messages.at(-1).actions[0]
        .status,
    ).toBe("cancelled");
    rmSync(index, { recursive: true });
    renameSync(`${index}.backup`, index);
    await f.service.handle("send", { request_id: "second", text: "Duplicate" });
    expect((await f.service.snapshot()).messages).toEqual(before.messages);
    await f.service.handle("action.confirm", {
      action_id: before.messages.at(-1)!.actions![0]!.id,
    });
    await until(
      () =>
        f.snapshots.at(-1)?.messages.at(-1)?.actions?.[0]?.status ===
        "succeeded",
    );
    expect(calls).toBe(1);
  });

  test("switching a saved chat keeps workspace scope and runtime safeguards and rejects switching during login", async () => {
    const histories: unknown[][] = [];
    const f = setup({
      run: async (input) => {
        histories.push(input.entries);
        input.message("Done");
        return [{ private_context: true }];
      },
      login: async (_provider, _method, interaction) => {
        await interaction.prompt({ type: "secret", message: "Key" });
      },
    });
    await f.service.handle("configure", configured);
    await f.service.handle("send", { request_id: "first", text: "Read" });
    await until(() => f.snapshots.at(-1)?.running === false);
    const first = await f.service.snapshot();
    await f.service.handle("new_session", {});
    await f.service.handle("auth.start", {
      provider: "test",
      method: "api_key",
    });
    await expect(
      f.service.handle("select_session", { session_id: first.session_id }),
    ).rejects.toThrow("busy");
    await f.service.handle("auth.cancel", {});
    await f.service.handle("configure", {
      ...configured,
      allowed_workspaces: [],
    });
    const selected = await f.service.handle("select_session", {
      session_id: first.session_id,
    });
    expect(selected.config.allowed_workspaces).toEqual([]);
    await expect(
      f.service.handle("send", { request_id: "escape", text: "Continue" }),
    ).rejects.toThrow("authorized");
    await f.service.handle("configure", configured);
    f.context.captureScope = async () => [
      { ...workspace, runtime_generation: 8 },
    ];
    await f.service.handle("send", {
      request_id: "generation",
      text: "New runtime",
    });
    await until(() => f.snapshots.at(-1)?.running === false);
    expect(histories[1]).toEqual([]);
  });

  test("maps async authentication prompts and never broadcasts submitted secrets or provider errors", async () => {
    const secret = "test-secret-with-private-token";
    const { service, snapshots } = setup({
      login: async (_provider, _method, interaction) => {
        const value = await interaction.prompt({
          type: "secret",
          message: "API key",
        });
        expect(value).toBe(secret);
        throw new Error(`Provider failed with ${value}`);
      },
    });
    await service.handle("configure", configured);
    const started = await service.handle("auth.start", {
      provider: "test",
      method: "api_key",
    });
    expect(started.auth?.prompt?.type).toBe("secret");
    await expect(
      service.handle("auth.respond", {
        auth_id: "old",
        prompt_id: "old",
        value: secret,
      }),
    ).rejects.toThrow("no longer active");
    await service.handle("auth.respond", {
      auth_id: started.auth?.id,
      prompt_id: started.auth?.prompt?.id,
      value: secret,
    });
    await until(() => snapshots.at(-1)?.auth?.status === "failed");
    expect(JSON.stringify(snapshots)).not.toContain(secret);
    expect((await service.snapshot()).messages).toEqual([]);
  });

  test("cancels OAuth and reads Pi credentials only after explicitly switching source", async () => {
    const sources: string[] = [];
    const loginSources: string[] = [];
    const { service, snapshots } = setup({
      catalog: async (source) => {
        sources.push(source);
        return structuredClone(catalog);
      },
      login: async (_provider, _method, interaction) => {
        loginSources.push(interaction.credential_source);
        interaction.notify({
          type: "device_code",
          userCode: "ABCD",
          verificationUri: "https://example.com/device",
        });
        await interaction.prompt({
          type: "manual_code",
          message: "Code",
          signal: interaction.signal,
        });
      },
    });
    expect(sources).toEqual([]);
    await service.handle("get", {});
    expect(sources).toEqual(["assistant"]);
    await service.handle("configure", configured);
    const start = await service.handle("auth.start", {
      provider: "test",
      method: "oauth",
    });
    expect(start.auth?.user_code).toBe("ABCD");
    await expect(
      service.handle("configure", {
        ...configured,
        credential_source: "pi",
      }),
    ).rejects.toThrow("busy");
    expect((await service.snapshot()).config.credential_source).toBe(
      "assistant",
    );
    const cancelled = await service.handle("auth.cancel", {
      auth_id: start.auth?.id,
    });
    expect(cancelled.auth?.status).toBe("failed");
    expect(snapshots.at(-1)?.auth?.url).toBeUndefined();
    await service.handle("configure", {
      ...configured,
      credential_source: "pi",
    });
    expect(sources.at(-1)).toBe("pi");
    const piStart = await service.handle("auth.start", {
      provider: "test",
      method: "oauth",
    });
    expect(piStart.auth?.user_code).toBe("ABCD");
    expect(loginSources).toEqual(["assistant", "pi"]);
    await expect(service.handle("configure", configured)).rejects.toThrow(
      "busy",
    );
    await service.handle("auth.cancel", { auth_id: piStart.auth?.id });
    const switched = await service.handle("configure", configured);
    expect(switched.auth).toBeNull();
    expect(switched.config.credential_source).toBe("assistant");
  });

  test("real Pi catalog enumeration does not execute stored credential commands", async () => {
    const directory = mkdtempSync(join(tmpdir(), "roamgate-pi-metadata-"));
    temporary.push(directory);
    const sentinel = join(directory, "executed");
    writeFileSync(
      join(directory, "auth.json"),
      JSON.stringify({
        anthropic: { type: "api_key", key: `!touch '${sentinel}'` },
      }),
    );
    const driver = createPiDriver(directory);
    const result = await driver.catalog("assistant");
    expect(
      result.providers.find((provider) => provider.id === "anthropic")
        ?.configured,
    ).toBe(true);
    expect(
      result.providers.find((provider) => provider.id === "anthropic")
        ?.credential_method,
    ).toBe("api_key");
    expect(() => readFileSync(sentinel)).toThrow();
    writeFileSync(
      join(directory, "auth.json"),
      JSON.stringify({
        openai: { type: "api_key", key: "test-not-a-real-key" },
        "openai-codex": {
          type: "oauth",
          access: "synthetic-access",
          refresh: "synthetic-refresh",
          expires: 0,
        },
      }),
    );
    const refreshed = await driver.catalog("assistant");
    expect(
      refreshed.providers.find((provider) => provider.id === "openai")
        ?.configured,
    ).toBe(true);
    expect(
      refreshed.providers.find((provider) => provider.id === "anthropic")
        ?.configured,
    ).toBe(false);
    expect(refreshed.models.some((model) => model.provider === "openai")).toBe(
      true,
    );
    expect(
      refreshed.providers.find((provider) => provider.id === "openai")
        ?.credential_method,
    ).toBe("api_key");
    expect(
      refreshed.providers.find((provider) => provider.id === "openai-codex")
        ?.credential_method,
    ).toBe("oauth");
    expect(
      refreshed.providers.find((provider) => provider.id === "openai-codex")
        ?.configured,
    ).toBe(true);
    expect(
      refreshed.providers.find((provider) => provider.id === "anthropic")
        ?.credential_method,
    ).toBeUndefined();
    expect(JSON.stringify(refreshed)).not.toContain("synthetic-access");
    expect(JSON.stringify(refreshed)).not.toContain("synthetic-refresh");
    await driver.dispose();
  });

  test("custom model connections validate input, preserve configuration, and use their saved endpoint and key", async () => {
    const f = setup();
    Object.assign(f.driver, createPiDriver(f.directory));
    const requests: { path: string; key: string | null }[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push({
          path: new URL(request.url).pathname,
          key: request.headers.get("x-api-key"),
        });
        await request.json();
        const events = [
          {
            type: "message_start",
            message: {
              id: "custom-answer",
              type: "message",
              role: "assistant",
              model: "local-model",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Custom model answer." },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 4 },
          },
          { type: "message_stop" },
        ];
        return new Response(
          events
            .map(
              (event) =>
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
            .join(""),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    const input = {
      provider: "Local.test",
      model: "local-model",
      base_url: server.url.href,
      api: "anthropic-messages",
      api_key: "synthetic-first-key",
      credential_source: "assistant",
    };
    const path = join(f.directory, "models.json");
    try {
      await expect(
        f.service.handle("configure_model", { ...input, api_key: undefined }),
      ).rejects.toThrow("could not be saved");
      const connected = await f.service.handle("configure_model", {
        ...input,
        models: [input.model, "second-model", input.model],
      });
      expect(connected.config.provider).toBe("");
      expect(
        connected.providers.find((provider) => provider.id === input.provider),
      ).toMatchObject({
        configured: true,
        credential_method: "api_key",
        custom: { base_url: server.url.href, api: "anthropic-messages" },
      });
      const saved = JSON.parse(readFileSync(path, "utf8"));
      expect(saved.providers[input.provider].models).toEqual([
        { id: input.model },
        { id: "second-model" },
      ]);
      expect(readFileSync(path, "utf8")).not.toContain(input.api_key);
      saved.providers.other = {
        baseUrl: "http://localhost:1234/v1",
        api: "openai-completions",
        apiKey: "synthetic-other-key",
        models: [{ id: "other-model" }],
      };
      saved.providers[input.provider].apiKey = "synthetic-imported-key";
      saved.providers[input.provider].models = [
        {
          id: input.model,
          name: "Local model",
          contextWindow: 8192,
          baseUrl: "http://localhost:1",
          api: "openai-completions",
        },
        { id: "second-model", name: "Second model", contextWindow: 4096 },
      ];
      writeFileSync(path, JSON.stringify(saved));
      expect(
        (await f.service.snapshot()).models.find(
          (model) => model.id === input.model,
        )?.custom,
      ).toEqual({ base_url: "http://localhost:1", api: "openai-completions" });
      const key = "synthetic-replacement-key";
      const batch = await f.service.handle("configure_model", {
        ...input,
        models: [input.model, " third-model ", "second-model", "third-model"],
        api_key: key,
      });
      expect(
        batch.models
          .filter((model) => model.provider === input.provider)
          .map((model) => model.id),
      ).toEqual([input.model, "second-model", "third-model"]);
      const updated = JSON.parse(readFileSync(path, "utf8"));
      expect(updated.providers.other).toEqual(saved.providers.other);
      expect(updated.providers[input.provider].baseUrl).toBe(
        saved.providers[input.provider].baseUrl,
      );
      expect(updated.providers[input.provider].api).toBe(
        saved.providers[input.provider].api,
      );
      expect(updated.providers[input.provider].models).toEqual([
        {
          ...saved.providers[input.provider].models[0],
          baseUrl: server.url.href,
          api: input.api,
        },
        {
          ...saved.providers[input.provider].models[1],
          baseUrl: server.url.href,
          api: input.api,
        },
        { id: "third-model", baseUrl: server.url.href, api: input.api },
      ]);
      await f.service.handle("configure_model", {
        ...input,
        api_key: undefined,
      });
      expect(
        JSON.parse(readFileSync(join(f.directory, "auth.json"), "utf8"))[
          input.provider
        ].key,
      ).toBe(key);
      const before = readFileSync(path, "utf8");
      const authBefore = readFileSync(join(f.directory, "auth.json"), "utf8");
      for (const invalid of [
        { provider: "anthropic" },
        { provider: "__proto__" },
        { base_url: "javascript:secret-value" },
        { base_url: "https://secret:password@example.com" },
        { base_url: "https://example.com?api_key=secret-value" },
        { api: "unsupported" },
        { api_key: "!touch secret-value" },
        { api_key: "$SECRET_VALUE" },
        { credential_source: "pi" },
        { models: "local-model,second-model" },
        { models: null },
        { models: [] },
        { models: ["other-model"] },
        { models: [input.model, "new-model", " "] },
        { models: [input.model, "new-model", 123] },
        { models: [input.model, "new-model", "x".repeat(501)] },
        { models: [input.model, "new-model", "bad\u0000model"] },
        {
          models: Array.from(
            { length: ASSISTANT_MAX_CUSTOM_MODELS + 1 },
            () => input.model,
          ),
        },
      ]) {
        await expect(
          f.service.handle("configure_model", {
            ...input,
            api_key: "synthetic-should-not-save-key",
            ...invalid,
          }),
        ).rejects.toThrow("could not be saved");
        expect(readFileSync(path, "utf8")).toBe(before);
        expect(readFileSync(join(f.directory, "auth.json"), "utf8")).toBe(
          authBefore,
        );
      }
      await f.service.handle("configure", {
        ...configured,
        provider: input.provider,
        model: input.model,
      });
      await f.service.handle("send", {
        request_id: "custom-first",
        text: "Say hello",
      });
      await until(() => !f.service.peek().running);
      expect(f.service.peek().messages.at(-1)?.text).toBe(
        "Custom model answer.",
      );
      updated.providers[input.provider].baseUrl = `${server.url.href}refreshed`;
      updated.providers[input.provider].models.push({ id: "external-model" });
      writeFileSync(path, JSON.stringify(updated));
      expect(
        (await f.service.snapshot()).models.some(
          (model) => model.id === "external-model",
        ),
      ).toBe(true);
      await f.service.handle("configure", {
        ...configured,
        provider: input.provider,
        model: "external-model",
      });
      await f.service.handle("send", {
        request_id: "custom-refreshed",
        text: "Say hello again",
      });
      await until(() => !f.service.peek().running);
      expect(requests).toEqual([
        { path: "/v1/messages", key },
        { path: "/refreshed/v1/messages", key },
      ]);
      expect(JSON.stringify(f.snapshots)).not.toContain(key);
      expect(
        readFileSync(join(f.directory, "state.json"), "utf8"),
      ).not.toContain(key);
      if (process.platform !== "win32") {
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(statSync(join(f.directory, "auth.json")).mode & 0o777).toBe(
          0o600,
        );
      }
      writeFileSync(path, "private-malformed-model-configuration");
      expect((await f.service.snapshot()).error).toBe(
        "The provider catalog could not be loaded.",
      );
      expect(JSON.stringify(f.snapshots)).not.toContain("private-malformed");
    } finally {
      await f.service.dispose();
      server.stop(true);
    }
  });

  test("validates optional credential metadata while retaining old snapshot compatibility", async () => {
    const { service } = setup();
    const snapshot = await service.snapshot();
    expect(isAssistantSnapshot(snapshot)).toBe(true);
    snapshot.providers[0]!.credential_method = "oauth";
    expect(isAssistantSnapshot(snapshot)).toBe(true);
    expect(
      isAssistantSnapshot({
        ...snapshot,
        providers: [{ ...snapshot.providers[0], credential_method: "expired" }],
      }),
    ).toBe(false);
  });

  test("a changed workspace generation clears historical model context", async () => {
    const histories: unknown[][] = [];
    const { service, context, snapshots } = setup({
      run: async (input) => {
        histories.push(input.entries);
        input.message("Done");
        return [{ last_generation: 7 }];
      },
    });
    await service.handle("configure", configured);
    await service.handle("send", { request_id: "first", text: "Read status" });
    await until(() => snapshots.at(-1)?.running === false);
    await service.handle("send", { request_id: "second", text: "Continue" });
    await until(() => snapshots.at(-1)?.running === false);
    expect(histories[1]).toEqual([{ last_generation: 7 }]);
    context.captureScope = async () => [
      { ...workspace, runtime_generation: 8 },
    ];
    await service.handle("send", {
      request_id: "third",
      text: "Read new runtime",
    });
    await until(() => snapshots.at(-1)?.running === false);
    expect(histories[2]).toEqual([]);
  });

  test("failed admission can retry the same request and save failures roll back mutations", async () => {
    const { service, context, directory, snapshots } = setup();
    await service.handle("configure", configured);
    const capture = context.captureScope;
    context.captureScope = async () => {
      throw new Error("Disconnected");
    };
    await expect(
      service.handle("send", { request_id: "retry", text: "Hello" }),
    ).rejects.toThrow("unavailable");
    context.captureScope = capture;
    await service.handle("send", { request_id: "retry", text: "Hello" });
    await until(() => snapshots.at(-1)?.running === false);
    expect((await service.snapshot()).messages).toHaveLength(2);
    const statePath = join(directory, "state.json");
    rmSync(statePath);
    mkdirSync(statePath);
    await expect(
      service.handle("configure", { ...configured, provider: "", model: "" }),
    ).rejects.toThrow("could not be saved");
    expect((await service.snapshot()).config.provider).toBe("test");
    await expect(service.handle("new_session", {})).rejects.toThrow(
      "could not be saved",
    );
    expect((await service.snapshot()).messages).toHaveLength(2);
  });

  test("keeps the transcript and SDK history within storage and snapshot ceilings", async () => {
    const { service, directory, snapshots } = setup({
      run: async (input) => {
        input.delta("a".repeat(100_000));
        input.message("a".repeat(100_000));
        return [{ too_large: "a".repeat(1_100_000) }];
      },
    });
    await service.handle("configure", configured);
    await service.handle("send", { request_id: "large", text: "Answer" });
    await until(() => snapshots.at(-1)?.running === false);
    const state = await service.snapshot();
    expect(state.messages[1]?.text.length).toBe(32_000);
    expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThan(4_000_000);
    expect(
      JSON.parse(readFileSync(join(directory, "state.json"), "utf8")).entries,
    ).toEqual([]);
  });

  test("persists the admitted run before execution and resumes its original model with fresh leases", async () => {
    const closed = Promise.withResolvers<void>();
    const f = setup({
      run: async (input) => {
        input.checkpoint?.([{ type: "ranger-durable", id: "context" }]);
        input.replace?.("Interrupted partial");
        await closed.promise;
        return input.entries;
      },
      dispose: async () => {
        closed.resolve();
      },
    });
    const targets = [
      {
        connection_id: "local",
        workspace_id: "ws",
        endpoint_fingerprint: "a".repeat(64),
        workspace_identity: "b".repeat(64),
        herdr_boot_id: "same-herdr",
      },
    ];
    f.context.recoveryScope = async () => targets;
    await f.service.handle("configure", configured);
    await f.service.handle("send", {
      request_id: "durable",
      text: "Read status",
    });
    await until(
      () =>
        JSON.parse(readFileSync(join(f.directory, "state.json"), "utf8"))
          .entries[0]?.type === "ranger-durable",
    );
    const admitted = JSON.parse(
      readFileSync(join(f.directory, "state.json"), "utf8"),
    );
    expect(admitted.active_run.request_id).toBe("durable");
    expect(admitted.active_run.config).toEqual(configured);
    await f.service.dispose();
    expect(
      JSON.parse(readFileSync(join(f.directory, "state.json"), "utf8"))
        .active_run,
    ).toBeDefined();
    const inputs: Parameters<AssistantDriver["run"]>[0][] = [];
    let restored = false;
    const driver: AssistantDriver = {
      ...f.driver,
      run: async (input) => {
        expect(restored).toBe(true);
        inputs.push(input);
        input.replace?.("Recovered answer");
        await input.read("status", {});
        return input.entries;
      },
    };
    f.context.restoreScope = async (saved) => {
      expect(saved).toEqual(targets);
      restored = true;
      return [{ ...workspace, runtime_generation: 8 }];
    };
    const service = createAssistantService({
      directory: f.directory,
      context: f.context,
      driver,
      publish: (snapshot) => f.snapshots.push(snapshot),
    });
    services.push(service);
    await service.resume();
    await until(() => f.snapshots.at(-1)?.running === false);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      recover: true,
      requestId: "durable",
      config: configured,
    });
    expect(f.reads[0]?.scope[0]?.runtime_generation).toBe(8);
    const snapshot = await service.snapshot();
    expect(
      snapshot.messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);
    expect(snapshot.messages[1]?.text).toBe("Recovered answer");
    expect(
      JSON.parse(readFileSync(join(f.directory, "state.json"), "utf8"))
        .active_run,
    ).toBeUndefined();
    await service.handle("send", { request_id: "durable", text: "Duplicate" });
    expect(inputs).toHaveLength(1);
  });

  test("Stop durably revokes recovery before awaiting the driver's abort", async () => {
    const completed = Promise.withResolvers<void>();
    const f = setup({
      run: async (input) => {
        await completed.promise;
        return input.entries;
      },
      dispose: async () => {
        completed.resolve();
      },
    });
    f.driver.stop = async () => {
      const saved = JSON.parse(
        readFileSync(join(f.directory, "state.json"), "utf8"),
      );
      expect(saved.active_run).toBeUndefined();
      expect(saved.entries).toEqual([]);
      completed.resolve();
    };
    await f.service.handle("configure", configured);
    await f.service.handle("send", {
      request_id: "cancel-before-abort",
      text: "Read",
    });
    expect(
      JSON.parse(readFileSync(join(f.directory, "state.json"), "utf8"))
        .active_run,
    ).toBeDefined();
    await f.service.handle("stop", {});
    expect((await f.service.snapshot()).running).toBe(false);
  });

  test.each(["removed permission", "changed endpoint", "unsupported identity"])(
    "rejects recovery for %s without starting a model",
    async (reason) => {
      const closed = Promise.withResolvers<void>();
      const f = setup({
        run: async (input) => {
          await closed.promise;
          return input.entries;
        },
        dispose: async () => {
          closed.resolve();
        },
      });
      f.context.recoveryScope = async () =>
        reason === "unsupported identity"
          ? []
          : [
              {
                ...workspace,
                endpoint_fingerprint: "a".repeat(64),
                workspace_identity: "b".repeat(64),
                herdr_boot_id: "same",
              },
            ];
      await f.service.handle("configure", configured);
      await f.service.handle("send", { request_id: "blocked", text: "Read" });
      await f.service.dispose();
      if (reason === "removed permission") {
        const path = join(f.directory, "state.json");
        const state = JSON.parse(readFileSync(path, "utf8"));
        state.config.allowed_workspaces = [];
        writeFileSync(path, JSON.stringify(state));
      }
      let starts = 0;
      f.context.restoreScope = async () => {
        throw new Error("Target changed");
      };
      const service = createAssistantService({
        directory: f.directory,
        context: f.context,
        driver: {
          ...f.driver,
          run: async () => {
            starts++;
            return [];
          },
        },
        publish: () => {},
      });
      services.push(service);
      await service.resume();
      expect(starts).toBe(0);
      const state = await service.snapshot();
      expect(state.running).toBe(false);
      expect(state.error).toContain("could not safely resume");
    },
  );

  test.each([false, true])(
    "waiting recovery can resume or be explicitly cancelled (cancel: %s)",
    async (cancel) => {
      const closed = Promise.withResolvers<void>();
      const f = setup({
        run: async (input) => {
          input.tool("interrupted-read", "workspace_status", "running");
          input.checkpoint?.(input.entries);
          await closed.promise;
          return input.entries;
        },
        dispose: async () => {
          closed.resolve();
        },
      });
      f.context.recoveryScope = async () => [
        {
          ...workspace,
          endpoint_fingerprint: "a".repeat(64),
          workspace_identity: "b".repeat(64),
          herdr_boot_id: "same",
        },
      ];
      await f.service.handle("configure", configured);
      await f.service.handle("send", { request_id: "waiting", text: "Read" });
      await f.service.dispose();
      let starts = 0;
      let ready = false;
      f.context.restoreScope = async () => {
        if (!ready) throw new AssistantRecoveryNotReadyError("Not ready");
        return [workspace];
      };
      const service = createAssistantService({
        directory: f.directory,
        context: f.context,
        driver: {
          ...f.driver,
          run: async () => {
            starts++;
            return [];
          },
        },
        publish: () => {},
      });
      services.push(service);
      await service.resume();
      const waiting = await service.snapshot();
      expect(waiting.running).toBe(true);
      expect(waiting.error).toContain("Waiting");
      expect(starts).toBe(0);
      if (cancel) await service.handle("stop", {});
      ready = true;
      await Promise.all([service.resume(), service.resume()]);
      expect(starts).toBe(cancel ? 0 : 1);
      expect((await service.snapshot()).running).toBe(false);
      expect((await service.snapshot()).messages.at(-1)?.tools[0]?.status).toBe(
        "failed",
      );
      expect(
        JSON.parse(readFileSync(join(f.directory, "state.json"), "utf8"))
          .active_run,
      ).toBeUndefined();
    },
  );
});

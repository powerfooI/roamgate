import { expect, jest, mock, spyOn, test } from "bun:test";
import * as React from "react";
import type {
  AssistantSnapshot,
  AssistantTask,
  AssistantTaskDetail,
  AssistantTaskInput,
  AssistantTaskRun,
  AssistantTaskProposal,
} from "../../../shared/assistant";
import * as assistant from "../assistant";
import type { RangerTaskNotificationTarget } from "../taskNotifications";
import { AssistantTasks, TaskProposalCard } from "./AssistantTasks";
import * as select from "./ThemedSelect";

const workspace = {
  connection_id: "local",
  workspace_id: "project",
  connection_label: "Local",
  label: "Project",
  runtime_generation: 1,
};
const now = "2026-10-04T00:00:00Z";
function task(id: string, input: Partial<AssistantTask> = {}): AssistantTask {
  return {
    id,
    title: `Task ${id}`,
    prompt: "Inspect workspace status",
    scope: [
      {
        connection_id: workspace.connection_id,
        workspace_id: workspace.workspace_id,
      },
    ],
    workspaces: [workspace],
    schedule: { type: "interval", minutes: 60 },
    status: "active",
    created_at: now,
    updated_at: now,
    next_run_at: now,
    model: { provider: "provider", id: "model" },
    ...input,
  };
}
function snapshot(tasks: AssistantTask[] = []): AssistantSnapshot {
  return {
    instance_id: "bridge",
    revision: 1,
    config: {
      provider: "provider",
      model: "model",
      credential_source: "assistant",
      allowed_workspaces: [workspace],
    },
    providers: [
      {
        id: "provider",
        label: "Provider",
        methods: ["api_key"],
        configured: true,
      },
    ],
    models: [{ provider: "provider", id: "model", label: "Model" }],
    messages: [],
    running: true,
    auth: null,
    error: null,
    tasks,
  };
}
function run(
  taskId: string,
  id = "run",
  status: AssistantTaskRun["status"] = "succeeded",
): AssistantTaskRun {
  return {
    id,
    task_id: taskId,
    status,
    scheduled_at: now,
    started_at: now,
    error: null,
  };
}

// Isolate React DOM from other component tests' hook spies.
if (process.env.ROAMGATE_ASSISTANT_TASK_DOM_TEST !== "1") {
  test("Ranger task controls and transcripts in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_ASSISTANT_TASK_DOM_TEST: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
    expect(code).toBe(0);
  }, 15_000);
} else {
  async function install(consumeRequests = false) {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost" });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      DOMParser: browser.DOMParser,
      NodeFilter: browser.NodeFilter,
      HTMLElement: browser.HTMLElement,
      HTMLButtonElement: browser.HTMLButtonElement,
      Element: browser.Element,
      Node: browser.Node,
      Event: browser.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    }
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let current = snapshot();
    let active = true;
    let currentRequested: RangerTaskNotificationTarget | null = null;
    const details = new Map<string, AssistantTaskDetail>();
    const get = spyOn(assistant, "getAssistantTask").mockImplementation(
      async (id) => {
        const item = details.get(id);
        if (item) return item;
        const entry = current.tasks?.find((item) => item.id === id);
        if (!entry) throw new Error("Task not found");
        return { task: entry, runs: [] };
      },
    );
    const call = spyOn(assistant, "callAssistant").mockImplementation(
      async (action, params) => {
        let tasks = current.tasks ?? [];
        if (action === "task.create")
          tasks = [...tasks, task("new", params as AssistantTaskInput)];
        else if (action === "task.delete")
          tasks = tasks.filter((item) => item.id !== params?.task_id);
        else
          tasks = tasks.map((item) =>
            item.id !== params?.task_id
              ? item
              : {
                  ...item,
                  ...(action === "task.update"
                    ? (params as AssistantTaskInput)
                    : {}),
                  ...(action === "task.pause"
                    ? { status: "paused" as const }
                    : {}),
                  ...(action === "task.resume"
                    ? { status: "active" as const }
                    : {}),
                  ...(action === "task.cancel"
                    ? { status: "cancelled" as const, current_run: undefined }
                    : {}),
                },
          );
        current = { ...current, revision: current.revision + 1, tasks };
        renderCurrent();
        return current;
      },
    );
    const themed = spyOn(select, "ThemedSelect").mockImplementation((props) =>
      React.createElement(
        "select",
        {
          value: props.value,
          disabled: props.disabled,
          "aria-label": props["aria-label"],
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
            props.onChange(event.currentTarget.value),
        },
        props.options.map((option) =>
          React.createElement(
            "option",
            { key: option.value, value: option.value },
            option.label,
          ),
        ),
      ),
    );
    const source = mock(() => {});
    const settings = mock(() => {});
    const requestedHandled = mock(() => {
      currentRequested = null;
      renderCurrent();
    });
    const renderCurrent = () =>
      root.render(
        React.createElement(AssistantTasks, {
          active,
          requestedTask: currentRequested,
          onRequestedTaskHandled: consumeRequests
            ? requestedHandled
            : undefined,
          snapshot: current,
          connected: true,
          workspaces: [workspace],
          onOpenSettings: settings,
          onOpenSource: source,
        }),
      );
    const render = async (
      value = current,
      visible = active,
      requestedTask = currentRequested,
    ) => {
      current = value;
      active = visible;
      currentRequested = requestedTask;
      await React.act(async () => renderCurrent());
    };
    const button = (name: string, parent: ParentNode = container) => {
      const result = Array.from(
        parent.querySelectorAll<HTMLButtonElement>("button"),
      ).find(
        (button) =>
          button.textContent?.trim() === name ||
          button.getAttribute("aria-label") === name,
      );
      if (!result) throw new Error(`Missing button ${name}`);
      return result;
    };
    const click = async (name: string, parent?: ParentNode) => {
      await React.act(async () => button(name, parent).click());
    };
    const input = async (label: string, value: string) => {
      const element = container.querySelector<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >(`[aria-label="${label}"]`)!;
      const prototype =
        element.tagName === "TEXTAREA"
          ? browser.HTMLTextAreaElement.prototype
          : element.tagName === "SELECT"
            ? browser.HTMLSelectElement.prototype
            : browser.HTMLInputElement.prototype;
      await React.act(async () => {
        Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
          element,
          value,
        );
        element.dispatchEvent(
          new Event(element.tagName === "SELECT" ? "change" : "input", {
            bubbles: true,
          }),
        );
      });
    };
    const submit = async () => {
      await React.act(async () =>
        container
          .querySelector("form")!
          .dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          ),
      );
    };
    return {
      browser,
      container,
      root,
      details,
      get,
      call,
      source,
      settings,
      requestedHandled,
      render,
      button,
      click,
      input,
      submit,
      get current() {
        return current;
      },
      get requestedTask() {
        return currentRequested;
      },
      async close() {
        jest.useRealTimers();
        await React.act(async () => root.unmount());
        for (const spy of [get, call, themed]) spy.mockRestore();
        await browser.happyDOM.close();
        for (const [key, descriptor] of originals) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else Reflect.deleteProperty(globalThis, key);
        }
      },
    };
  }

  test("task editors hide removed workspace rows but require an explicit scope change", async () => {
    const ui = await install();
    try {
      const missing = {
        ...workspace,
        workspace_id: "gone-project",
        label: "Removed project",
      };
      const entry = task("existing", {
        scope: [
          {
            connection_id: workspace.connection_id,
            workspace_id: workspace.workspace_id,
          },
          {
            connection_id: missing.connection_id,
            workspace_id: missing.workspace_id,
          },
        ],
        workspaces: [workspace, missing],
      });
      await ui.render({
        ...snapshot(),
        tasks: [entry],
        config: {
          ...snapshot().config,
          approval_mode: "auto",
          workspace_scope: "all",
          allowed_workspaces: [],
        },
      });
      await React.act(async () =>
        ui.container
          .querySelector<HTMLButtonElement>(".assistant-task-row")!
          .click(),
      );
      await ui.click("Edit");
      expect(
        ui.container.querySelectorAll(
          ".assistant-task-scope .assistant-workspace-choice",
        ),
      ).toHaveLength(1);
      expect(
        ui.container.querySelector(".assistant-task-scope")?.textContent,
      ).not.toContain("Removed project");
      expect(ui.container.textContent).toContain(
        "The saved scope is unchanged",
      );
      expect(ui.container.textContent).toContain(
        "All available workspaces are allowed",
      );
      expect(ui.button("Save changes").disabled).toBe(true);
      await ui.submit();
      expect(ui.call).not.toHaveBeenCalled();
      expect(entry.scope).toHaveLength(2);
      await ui.click("Remove unavailable selections");
      expect(ui.button("Save changes").disabled).toBe(false);
      await ui.submit();
      expect(ui.call).toHaveBeenLastCalledWith(
        "task.update",
        expect.objectContaining({
          task_id: "existing",
          scope: [
            {
              connection_id: workspace.connection_id,
              workspace_id: workspace.workspace_id,
            },
          ],
        }),
      );
    } finally {
      await ui.close();
    }
  });

  test("task forms require scope, convert local time, validate schedules and preserve paused edits", async () => {
    const ui = await install();
    try {
      await ui.render();
      await ui.click("New task");
      expect(
        ui.container.querySelector(
          ".assistant-task-scope .assistant-workspaces",
        ),
      ).not.toBeNull();
      expect(document.activeElement?.getAttribute("aria-label")).toBe(
        "Task name",
      );
      await ui.input("Task name", "  Workspace check  ");
      await ui.input("Task prompt", "  Summarize progress  ");
      await ui.input("Run at", "2030-05-01T08:30");
      expect(ui.button("Save and enable").disabled).toBe(true);
      await React.act(async () =>
        ui.container
          .querySelector<HTMLInputElement>('[type="checkbox"]')!
          .click(),
      );
      expect(ui.button("Save and enable").disabled).toBe(false);
      ui.call.mockRejectedValueOnce(new Error("Reply lost"));
      await ui.submit();
      const originalRequest = ui.call.mock.calls[0][1];
      await ui.submit();
      expect(ui.call).toHaveBeenCalledWith("task.create", {
        title: "Workspace check",
        prompt: "Summarize progress",
        scope: [{ connection_id: "local", workspace_id: "project" }],
        schedule: {
          type: "once",
          at: new Date("2030-05-01T08:30").toISOString(),
        },
        request_id: expect.stringMatching(/^[\da-f-]{36}$/),
      });
      expect(ui.call.mock.calls[1][1]).toEqual(originalRequest);
      expect(ui.container.textContent).toContain("Workspace check");
      await ui.render();
      await ui.click("Edit");
      await ui.input("Task schedule", "daily");
      expect(
        ui.container.querySelector<HTMLInputElement>(
          '[aria-label="Task timezone"]',
        )?.value,
      ).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
      await ui.input("Daily time", "03:40");
      await ui.input("Task timezone", "Invalid/Timezone");
      await ui.submit();
      expect(
        ui.container.querySelector('[role="alert"]')?.textContent,
      ).toContain("valid schedule");
      expect(ui.call).toHaveBeenCalledTimes(2);
      await ui.input("Task timezone", "Europe/Paris");
      await ui.input("Task notifications", "agent");
      await ui.submit();
      expect(ui.call).toHaveBeenLastCalledWith(
        "task.update",
        expect.objectContaining({
          task_id: "new",
          schedule: { type: "daily", time: "03:40", timezone: "Europe/Paris" },
          notification_mode: "agent",
        }),
      );
      await ui.render();
      await ui.click("Pause");
      await ui.render();
      await ui.click("Edit");
      expect(ui.container.textContent).toContain("stay paused after saving");
      expect(
        ui.container.querySelector<HTMLSelectElement>(
          '[aria-label="Task notifications"]',
        )?.value,
      ).toBe("agent");
      await ui.input("Task notifications", "status");
      await ui.input("Task schedule", "interval");
      await ui.input("Interval minutes", "1.5");
      await ui.submit();
      expect(ui.call).toHaveBeenCalledTimes(4);
      await ui.input("Interval minutes", "15");
      await ui.submit();
      expect(ui.call).toHaveBeenLastCalledWith(
        "task.update",
        expect.objectContaining({
          task_id: "new",
          schedule: { type: "interval", minutes: 15 },
          notification_mode: "status",
        }),
      );
      expect(ui.current.tasks?.[0].status).toBe("paused");
      expect(
        ui.call.mock.calls.some(([action]) => action === "task.resume"),
      ).toBe(false);
      await ui.render();
      expect(ui.button("Run now").disabled).toBe(false);
      await ui.click("Run now");
      expect(ui.call).toHaveBeenLastCalledWith("task.run_now", {
        task_id: "new",
      });
      expect(ui.current.tasks?.[0].status).toBe("paused");
      await ui.click("Cancel task");
      const dialog = ui.container.querySelector('[role="dialog"]')!;
      expect(dialog.textContent).toContain("Run history will stay available");
      await ui.click("Cancel task", dialog);
      await ui.render();
      expect(ui.button("Delete task").disabled).toBe(false);
      expect(
        ui.container.querySelector(".assistant-task-buttons")?.textContent,
      ).not.toContain("Resume");
      await ui.click("All tasks");
      expect(ui.container.querySelector(".assistant-task-row")).toBeNull();
      await React.act(async () =>
        ui.container
          .querySelector<HTMLInputElement>('[type="checkbox"]')!
          .click(),
      );
      await React.act(async () =>
        ui.container
          .querySelector<HTMLButtonElement>(".assistant-task-row")!
          .click(),
      );
      await ui.click("Delete task");
      const deletion = ui.container.querySelector('[role="dialog"]')!;
      expect(deletion.textContent).toContain(
        "Permanently delete this task and all of its run history",
      );
      await ui.click("Delete task", deletion);
      expect(ui.call).toHaveBeenLastCalledWith("task.delete", {
        task_id: "new",
      });
      expect(ui.current.tasks).toEqual([]);
    } finally {
      await ui.close();
    }
  });

  test("task editing preserves bound targets and removes references outside the selected workspace scope", async () => {
    const ui = await install();
    const local = {
      kind: "workspace" as const,
      ...workspace,
      workspace_label: workspace.label,
    };
    const remote = {
      ...local,
      connection_id: "offline",
      connection_label: "Offline",
    };
    try {
      await ui.render(
        snapshot([
          task("bound", {
            scope: [local, remote].map(({ connection_id, workspace_id }) => ({
              connection_id,
              workspace_id,
            })),
            mentions: [local, remote],
          }),
        ]),
      );
      await React.act(async () =>
        ui.container
          .querySelector<HTMLButtonElement>(".assistant-task-row")!
          .click(),
      );
      await ui.click("Edit");
      expect(ui.container.textContent).toContain(
        "References: Project (Local), Project (Offline)",
      );
      await ui.click("Remove unavailable selections");
      await ui.submit();
      expect(ui.call).toHaveBeenLastCalledWith(
        "task.update",
        expect.objectContaining({
          task_id: "bound",
          scope: [
            {
              connection_id: local.connection_id,
              workspace_id: local.workspace_id,
            },
          ],
          mentions: [local],
        }),
      );
      await ui.render();
      await ui.click("Edit");
      await ui.input("Task prompt", "Inspect again");
      await ui.submit();
      expect(ui.call).toHaveBeenLastCalledWith(
        "task.update",
        expect.objectContaining({ mentions: [local] }),
      );
    } finally {
      await ui.close();
    }
  });

  test("notification requests open their historical run and refresh repeated or different targets", async () => {
    const ui = await install();
    try {
      const running = run("a", "current", "running");
      const older = run("a", "older");
      const other = run("b", "other", "failed");
      const a = task("a", { current_run: running });
      const b = task("b", { last_run: other });
      const target: RangerTaskNotificationTarget = {
        type: "ranger_task",
        taskId: "a",
        runId: "older",
      };
      ui.get.mockImplementation(async (id, runId) => {
        const selected = id === "a" ? older : other;
        expect(runId).toBe(selected.id);
        return {
          task: id === "a" ? a : b,
          runs: id === "a" ? [running, older] : [other],
          run: {
            ...selected,
            messages: [
              {
                id: "output",
                role: "assistant",
                text: `${selected.id} notification result`,
                sent_at: now,
                tools: [],
                sources: [],
              },
            ],
          },
        };
      });
      await ui.render(snapshot([a, b]), true, target);
      expect(ui.get).toHaveBeenLastCalledWith("a", "older");
      expect(ui.container.textContent).toContain("older notification result");
      expect(
        ui.container.querySelector<HTMLSelectElement>('[aria-label="Task run"]')
          ?.value,
      ).toBe("older");
      await ui.click("All tasks");
      await ui.click("New task");
      expect(ui.container.querySelector("form")).not.toBeNull();
      const reads = ui.get.mock.calls.length;
      await ui.render(ui.current, true, { ...target });
      expect(ui.get).toHaveBeenCalledTimes(reads + 1);
      expect(ui.container.querySelector("form")).toBeNull();
      expect(ui.container.textContent).toContain("older notification result");
      await ui.render(ui.current, true, {
        type: "ranger_task",
        taskId: "b",
        runId: "other",
      });
      expect(ui.get).toHaveBeenLastCalledWith("b", "other");
      expect(ui.container.textContent).toContain("other notification result");
      expect(ui.container.textContent).not.toContain(
        "older notification result",
      );
      await ui.render(ui.current, false);
      await ui.render(ui.current, true);
      expect(ui.get).toHaveBeenLastCalledWith("b", "other");
      expect(ui.container.textContent).toContain("other notification result");
    } finally {
      await ui.close();
    }
  });

  test("handled notifications do not interrupt later task navigation when their task disappears", async () => {
    const ui = await install(true);
    try {
      const a = task("a");
      const b = task("b");
      const old = run("b", "old");
      ui.details.set("b", {
        task: b,
        runs: [old],
        run: { ...old, messages: [] },
      });
      await ui.render(snapshot([a, b]), true, {
        type: "ranger_task",
        taskId: "b",
        runId: "old",
      });
      expect(ui.get).toHaveBeenLastCalledWith("b", "old");
      expect(ui.requestedHandled).toHaveBeenCalledTimes(1);
      expect(ui.requestedTask).toBeNull();
      await ui.click("All tasks");
      await React.act(async () =>
        ui.container
          .querySelector<HTMLButtonElement>(".assistant-task-row")!
          .click(),
      );
      expect(ui.get).toHaveBeenLastCalledWith("a", undefined);
      expect(
        ui.container.querySelector(".assistant-task-heading h3")?.textContent,
      ).toBe("Task a");
      await ui.render(snapshot([a]));
      expect(
        ui.container.querySelector(".assistant-task-heading h3")?.textContent,
      ).toBe("Task a");
      expect(ui.container.querySelector('[role="alert"]')).toBeNull();
      expect(ui.requestedHandled).toHaveBeenCalledTimes(1);
      expect(ui.get).toHaveBeenLastCalledWith("a", undefined);
    } finally {
      await ui.close();
    }
  });

  test("missing tasks and expired runs report notification errors without stale output", async () => {
    const ui = await install();
    try {
      const a = task("a");
      const request = (
        taskId: string,
        runId: string,
      ): RangerTaskNotificationTarget => ({
        type: "ranger_task",
        taskId,
        runId,
      });
      await ui.render(snapshot([a]), true, request("missing", "old"));
      expect(ui.get).not.toHaveBeenCalled();
      expect(
        ui.container.querySelector('[role="alert"]')?.textContent,
      ).toContain("no longer available");
      ui.get.mockRejectedValueOnce(new Error("Task run not found"));
      await ui.render(ui.current, true, request("a", "expired"));
      expect(ui.get).toHaveBeenLastCalledWith("a", "expired");
      expect(
        ui.container.querySelector('[role="alert"]')?.textContent,
      ).toContain("Task run not found");
      expect(ui.container.querySelector(".assistant-task-run")).toBeNull();

      const pending = Promise.withResolvers<AssistantTaskDetail>();
      ui.get.mockImplementationOnce(() => pending.promise);
      await ui.render(ui.current, true, request("a", "pending"));
      await ui.render(ui.current, true, request("missing", "old"));
      await React.act(async () =>
        pending.resolve({
          task: a,
          runs: [run("a", "pending")],
          run: {
            ...run("a", "pending"),
            messages: [
              {
                id: "stale",
                role: "assistant",
                text: "Stale notification output",
                sent_at: now,
                tools: [],
                sources: [],
              },
            ],
          },
        }),
      );
      expect(
        ui.container.querySelector('[role="alert"]')?.textContent,
      ).toContain("no longer available");
      expect(ui.container.textContent).not.toContain(
        "Stale notification output",
      );
    } finally {
      await ui.close();
    }
  });

  test("only the selected task polls, stale replies stay hidden and waiting actions keep their own run identity", async () => {
    const ui = await install();
    try {
      const a = task("a");
      const running = run("b", "current", "running");
      const b = task("b", { current_run: running });
      let resolveA: (value: AssistantTaskDetail) => void = () => {};
      ui.get.mockImplementation(async (id, runId) =>
        id === "a"
          ? await new Promise<AssistantTaskDetail>((resolve) => {
              resolveA = resolve;
            })
          : { ...ui.details.get(id)!, ...(runId ? {} : { run: undefined }) },
      );
      ui.details.set("b", {
        task: b,
        runs: [running],
        run: { ...running, messages: [] },
      });
      await ui.render(snapshot([a, b]));
      expect(ui.get).not.toHaveBeenCalled();
      await React.act(async () =>
        ui.container
          .querySelectorAll<HTMLButtonElement>(".assistant-task-row")[0]
          .click(),
      );
      await ui.click("All tasks");
      jest.useFakeTimers();
      await React.act(async () =>
        ui.container
          .querySelectorAll<HTMLButtonElement>(".assistant-task-row")[1]
          .click(),
      );
      expect(ui.button("Stop run").disabled).toBe(false);
      expect(ui.button("Cancel task").disabled).toBe(false);
      expect(ui.button("Run now").disabled).toBe(true);
      await React.act(async () =>
        resolveA({ task: { ...a, title: "Stale task title" }, runs: [] }),
      );
      expect(ui.container.textContent).not.toContain("Stale task title");
      const waiting = { ...running, status: "waiting" as const };
      const source = {
        ...workspace,
        id: "source",
        kind: "status" as const,
        title: "Project status",
        read_at: now,
      };
      const action = {
        ...workspace,
        workspace_label: workspace.label,
        id: "proposal",
        kind: "send_prompt" as const,
        status: "pending" as const,
        created_at: now,
        summary: "Ask agent",
        params: { prompt: "Review", pane_id: "pane" },
        detail: "",
      };
      ui.details.set("b", {
        task: { ...b, current_run: waiting },
        runs: [waiting],
        run: {
          ...waiting,
          messages: [
            {
              id: "answer",
              role: "assistant",
              text: "Waiting for approval",
              sent_at: now,
              tools: [
                { id: "tool", name: "workspace_status", status: "completed" },
              ],
              sources: [source],
              actions: [action],
            },
          ],
        },
      });
      await React.act(async () => {
        jest.advanceTimersByTime(1000);
      });
      expect(ui.get.mock.calls.map(([id]) => id)).toEqual(["a", "b", "b", "b"]);
      await ui.render(ui.current, false);
      const hiddenCount = ui.get.mock.calls.length;
      expect(
        ui.container.querySelector<HTMLElement>(".assistant-tasks")!.hidden,
      ).toBe(true);
      await React.act(async () => {
        jest.advanceTimersByTime(5000);
      });
      expect(ui.get).toHaveBeenCalledTimes(hiddenCount);
      await ui.render(ui.current, true);
      expect(ui.get).toHaveBeenLastCalledWith("b", "current");
      expect(ui.container.textContent).toContain("Waiting for approval");
      expect(ui.container.textContent).toContain("Workspace status");
      const activity =
        ui.container.querySelector<HTMLDetailsElement>(".assistant-tools")!;
      expect(activity.open).toBe(false);
      expect(activity.querySelector(".assistant-sources")).not.toBeNull();
      await React.act(async () => activity.querySelector("summary")!.click());
      expect(activity.open).toBe(true);
      expect(ui.button("Confirm action").disabled).toBe(false);
      await React.act(async () =>
        ui.container
          .querySelector<HTMLButtonElement>(".assistant-sources button")!
          .click(),
      );
      expect(ui.source).toHaveBeenCalledWith(source);
      await ui.click("Confirm action");
      expect(ui.call).toHaveBeenLastCalledWith("task.action.confirm", {
        action_id: "proposal",
        task_id: "b",
        run_id: "current",
      });
      await ui.click("Stop run");
      expect(ui.call).toHaveBeenLastCalledWith("task.stop", { task_id: "b" });
      const old = run("b", "old");
      const completed = { ...running, status: "succeeded" as const };
      ui.details.set("b", {
        task: { ...b, current_run: undefined, last_run: completed },
        runs: [completed, old],
        run: { ...completed, messages: [] },
      });
      await React.act(async () => {
        jest.advanceTimersByTime(1000);
      });
      const afterCompletion = ui.get.mock.calls.length;
      await React.act(async () => {
        jest.advanceTimersByTime(5000);
      });
      expect(ui.get).toHaveBeenCalledTimes(afterCompletion);
      ui.get.mockImplementation(async () => ({
        ...ui.details.get("b")!,
        run: {
          ...old,
          messages: [
            {
              id: "old-output",
              role: "assistant",
              text: "Earlier result",
              sent_at: now,
              tools: [],
              sources: [],
            },
          ],
        },
      }));
      await ui.input("Task run", "old");
      expect(ui.get).toHaveBeenLastCalledWith("b", "old");
      expect(ui.container.textContent).toContain("Earlier result");
      await ui.render(ui.current, false);
      await ui.render(ui.current, true);
      expect(ui.get).toHaveBeenLastCalledWith("b", "old");
      expect(
        ui.container.querySelector<HTMLSelectElement>(
          '[aria-label="Task run"]',
        )!.value,
      ).toBe("old");
      await ui.click("All tasks");
      const count = ui.get.mock.calls.length;
      await React.act(async () => {
        jest.advanceTimersByTime(5000);
      });
      expect(ui.get).toHaveBeenCalledTimes(count);
      const proposal: AssistantTaskProposal = {
        ...a,
        id: "task-proposal",
        status: "pending",
      };
      const propose = mock(async () => true);
      await React.act(async () =>
        ui.root.render(
          React.createElement(TaskProposalCard, {
            proposal,
            busy: false,
            run: propose,
          }),
        ),
      );
      expect(propose).not.toHaveBeenCalled();
      await ui.click("Confirm task");
      expect(propose).toHaveBeenLastCalledWith("task.confirm_proposal", {
        proposal_id: "task-proposal",
      });
      await ui.click("Cancel");
      expect(propose).toHaveBeenLastCalledWith("task.cancel_proposal", {
        proposal_id: "task-proposal",
      });
    } finally {
      await ui.close();
    }
  });

  test("deleting a selected task ignores an older detail failure between publication and acknowledgement", async () => {
    const ui = await install();
    try {
      const saved = task("deleted", { status: "cancelled", next_run_at: null });
      const oldDetail = Promise.withResolvers<AssistantTaskDetail>();
      const acknowledgement = Promise.withResolvers<AssistantSnapshot>();
      ui.get.mockReturnValueOnce(oldDetail.promise);
      ui.call.mockReturnValueOnce(acknowledgement.promise);
      await ui.render(snapshot([saved]));
      await React.act(async () =>
        ui.container
          .querySelector<HTMLInputElement>('[type="checkbox"]')!
          .click(),
      );
      await React.act(async () =>
        ui.container
          .querySelector<HTMLButtonElement>(".assistant-task-row")!
          .click(),
      );
      expect(ui.get).toHaveBeenCalledTimes(1);
      await ui.click("Delete task");
      await ui.click(
        "Delete task",
        ui.container.querySelector('[role="dialog"]')!,
      );
      expect(ui.call).toHaveBeenCalledWith("task.delete", {
        task_id: "deleted",
      });
      await ui.render(snapshot([]));
      await React.act(async () =>
        oldDetail.reject(new Error("This task is no longer available.")),
      );
      expect(ui.container.querySelector('[role="alert"]')).toBeNull();
      await React.act(async () => acknowledgement.resolve(ui.current));
      expect(ui.container.textContent).toContain("No tasks yet");
      expect(ui.container.querySelector('[role="alert"]')).toBeNull();
      expect(ui.get).toHaveBeenCalledTimes(1);
    } finally {
      await ui.close();
    }
  });

  test.each([
    ["update", "Edit task", "Updated", "Existing runs keep their instructions"],
    ["pause", "Pause task", "Paused", "already-started run will continue"],
    ["resume", "Resume task", "Resumed", "resume scheduled runs"],
    ["cancel", "Cancel task", "Task cancelled", "stop its active run"],
    [
      "delete",
      "Delete task",
      "Deleted",
      "private run history. This cannot be undone",
    ],
  ] as const)(
    "%s task proposals identify their target and accurately describe confirmation",
    async (operation, label, status, warning) => {
      const ui = await install();
      try {
        const proposal: AssistantTaskProposal = {
          ...task("original-task"),
          id: "preview",
          task_id: "original-task",
          operation,
          status: "pending",
        };
        const confirm = mock(async () => true);
        await React.act(async () =>
          ui.root.render(
            React.createElement(TaskProposalCard, {
              proposal,
              busy: false,
              run: confirm,
            }),
          ),
        );
        expect(confirm).not.toHaveBeenCalled();
        expect(ui.container.textContent).toContain(label);
        expect(ui.container.textContent).toContain("Task ID: original-task");
        expect(ui.container.textContent).toContain(warning);
        expect(ui.container.textContent).not.toContain("Enabled");
        await ui.click(`Confirm ${operation}`);
        expect(confirm).toHaveBeenCalledWith("task.confirm_proposal", {
          proposal_id: "preview",
        });
        await React.act(async () =>
          ui.root.render(
            React.createElement(TaskProposalCard, {
              proposal: {
                ...proposal,
                status: "confirmed",
                detail: "Operation completed with a cleanup warning",
              },
              busy: false,
              run: confirm,
            }),
          ),
        );
        expect(ui.container.textContent).toContain(status);
        expect(ui.container.textContent).toContain(
          "Operation completed with a cleanup warning",
        );
        expect(ui.container.textContent).not.toContain("Enabled");
        expect(ui.container.querySelectorAll("button")).toHaveLength(0);
      } finally {
        await ui.close();
      }
    },
  );
}

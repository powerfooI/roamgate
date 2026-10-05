import { describe, expect, jest, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import {
  listenForTaskNotificationActivation,
  prepareTaskNotifications,
  showTaskNotification,
  TASK_NOTIFICATION_ACTIVATE_EVENT,
} from "./taskNotifications";
import { __storeTesting, emptyServerSessionState, store } from "./store";
import { bridge, type ConnectionClient } from "./api";

const origin = "https://roamgate.example";
const target = {
  connectionId: "alpha",
  runtimeGeneration: 1,
  workspaceId: "w1",
  paneId: "p1",
};

async function withBrowser(
  overrides: Record<string, unknown>,
  run: () => Promise<void>,
) {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const previousState = store.get();
  const defaults = {
    window: { location: new URL(origin), Notification: {} },
    navigator: {},
    localStorage: { setItem() {} },
    Notification: class {
      static permission = "granted";
      constructor() {
        throw new TypeError(
          "Use ServiceWorkerRegistration.showNotification instead.",
        );
      }
    },
  };
  for (const [key, value] of Object.entries({ ...defaults, ...overrides })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  try {
    await run();
  } finally {
    __storeTesting.replaceState(previousState);
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function registration() {
  return {
    active: {
      scriptURL: origin + "/task-notifications-sw.js?v=2",
      state: "activated" as ServiceWorkerState,
    },
    showNotification: mock(async () => {}),
  };
}

describe("task notification transport", () => {
  test.each(["succeeded", "failed", "waiting"] as const)(
    "Ranger %s respects preferences and avoids duplicate system delivery with push",
    async (status) => {
      const rangerTarget = {
        type: "ranger_task",
        taskId: "11111111-1111-4111-8111-111111111111",
        runId: "22222222-2222-4222-8222-222222222222",
      };
      const active = registration();
      await withBrowser(
        {
          navigator: { serviceWorker: { getRegistration: async () => active } },
        },
        async () => {
          for (const transport of ["local", "push"] as const) {
            for (const enabled of [true, false]) {
              active.showNotification.mockClear();
              const kind = status === "succeeded" ? "completed" : "blocked";
              __storeTesting.replaceState({
                ...store.get(),
                notice: null,
                connections: [],
                activeConnectionId: "another-host",
                taskNotificationsEnabled: true,
                taskNotificationBusy: false,
                taskNotificationTransport: transport,
                taskNotificationPreferences: {
                  completed: true,
                  blocked: true,
                  [kind]: enabled,
                },
              });
              __storeTesting.notifyRangerTask({
                task_id: rangerTarget.taskId,
                run_id: rangerTarget.runId,
                status,
                title: "Ranger update",
                body: "Check the scheduled task.",
              });
              for (let index = 0; index < 8; index++) await Promise.resolve();
              if (enabled) {
                expect(store.get().notice).toMatchObject({
                  kind:
                    status === "failed"
                      ? "error"
                      : status === "succeeded"
                        ? "success"
                        : "info",
                  actionLabel: "Open Ranger task",
                  actionRangerTaskId: rangerTarget.taskId,
                  actionRangerRunId: rangerTarget.runId,
                });
              } else expect(store.get().notice).toBeNull();
              if (enabled && transport === "local") {
                expect(active.showNotification).toHaveBeenCalledWith(
                  "Ranger update",
                  {
                    body: "Check the scheduled task.",
                    tag: JSON.stringify([
                      "roamgate-ranger-task",
                      rangerTarget.taskId,
                      rangerTarget.runId,
                    ]),
                    data: {
                      type: TASK_NOTIFICATION_ACTIVATE_EVENT,
                      target: rangerTarget,
                    },
                  },
                );
              } else expect(active.showNotification).not.toHaveBeenCalled();
            }
          }
          __storeTesting.replaceState({
            ...store.get(),
            notice: null,
            taskNotificationsEnabled: false,
          });
          __storeTesting.notifyRangerTask({
            task_id: rangerTarget.taskId,
            run_id: rangerTarget.runId,
            status,
            title: "Ranger update",
            body: "",
          });
          expect(store.get().notice).toBeNull();
        },
      );
    },
  );
  test("uses an active worker when the mobile page constructor throws", async () => {
    const active = registration();
    const register = mock();
    await withBrowser(
      {
        navigator: {
          serviceWorker: { getRegistration: async () => active, register },
        },
      },
      async () => {
        await showTaskNotification(
          "Completed",
          { body: "Agent", tag: "task" },
          target,
          () => true,
        );
        expect(register).not.toHaveBeenCalled();
        expect(active.showNotification).toHaveBeenCalledWith("Completed", {
          body: "Agent",
          tag: "task",
          data: { type: TASK_NOTIFICATION_ACTIVATE_EVENT, target },
        });
      },
    );
  });

  test("registers and waits for activation, then drops a canceled delivery", async () => {
    const active = registration();
    const pending = { ...active, active: null as typeof active.active | null };
    const ready = Promise.withResolvers<void>();
    const register = mock(async () => pending);
    const serviceWorker = {
      getRegistration: async () => undefined,
      register,
      ready: ready.promise,
    };
    await withBrowser({ navigator: { serviceWorker } }, async () => {
      const showing = showTaskNotification(
        "Completed",
        {},
        target,
        () => false,
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(active.showNotification).not.toHaveBeenCalled();
      expect(register).toHaveBeenCalledWith("/task-notifications-sw.js?v=2", {
        updateViaCache: "none",
      });
      pending.active = active.active;
      ready.resolve();
      await showing;
      expect(active.showNotification).not.toHaveBeenCalled();
    });
  });

  test("upgrades the legacy worker before delivery even when ready already resolves", async () => {
    const replacement = Object.assign(new EventTarget(), {
      scriptURL: origin + "/task-notifications-sw.js?v=2",
      state: "installing" as ServiceWorkerState,
    });
    const active = {
      ...registration(),
      active: {
        scriptURL: origin + "/task-notifications-sw.js",
        state: "activated" as ServiceWorkerState,
      },
      installing: replacement as typeof replacement | null,
    };
    const registered = Promise.withResolvers<void>();
    const register = mock(async () => {
      registered.resolve();
      return active;
    });
    const addListener = mock(replacement.addEventListener.bind(replacement));
    replacement.addEventListener = addListener;
    await withBrowser(
      {
        navigator: {
          serviceWorker: {
            getRegistration: async () => active,
            register,
            ready: Promise.resolve(active),
          },
        },
      },
      async () => {
        const showing = showTaskNotification(
          "Ranger update",
          {},
          target,
          () => true,
        );
        await registered.promise;
        await Promise.resolve();
        expect(register).toHaveBeenCalledWith("/task-notifications-sw.js?v=2", {
          updateViaCache: "none",
        });
        for (const state of ["installed", "activating"] as const) {
          replacement.state = state;
          replacement.dispatchEvent(new Event("statechange"));
          await Promise.resolve();
          expect(active.showNotification).not.toHaveBeenCalled();
        }
        replacement.state = "activated";
        active.active = replacement;
        active.installing = null;
        replacement.dispatchEvent(new Event("statechange"));
        await showing;
        expect(active.showNotification).toHaveBeenCalledTimes(1);
        expect(
          (addListener.mock.calls[0]?.[2] as AddEventListenerOptions)?.signal
            ?.aborted,
        ).toBe(true);
        await prepareTaskNotifications();
        expect(register).toHaveBeenCalledTimes(1);
      },
    );
  });

  test.each(["redundant", "timeout"])(
    "rejects a replacement that becomes %s and removes its listener",
    async (failure) => {
      jest.useFakeTimers();
      try {
        const worker = Object.assign(new EventTarget(), {
          state: "installing" as ServiceWorkerState,
        });
        const addListener = mock(worker.addEventListener.bind(worker));
        worker.addEventListener = addListener;
        const active = { ...registration(), installing: worker };
        await withBrowser(
          {
            navigator: {
              serviceWorker: { getRegistration: async () => active },
            },
          },
          async () => {
            const preparing = prepareTaskNotifications().catch(
              (error) => error,
            );
            await Promise.resolve();
            if (failure === "redundant") {
              worker.state = "redundant";
              worker.dispatchEvent(new Event("statechange"));
            } else jest.advanceTimersByTime(10_000);
            expect((await preparing).message).toContain(
              failure === "redundant"
                ? "could not activate"
                : "did not become ready",
            );
            expect(
              (addListener.mock.calls[0]?.[2] as AddEventListenerOptions)
                ?.signal?.aborted,
            ).toBe(true);
            expect(active.showNotification).not.toHaveBeenCalled();
          },
        );
      } finally {
        jest.useRealTimers();
      }
    },
  );

  test("keeps the page notification fallback and its click handler", async () => {
    const notification = { close() {}, onclick: null };
    const Notification = mock(function () {
      return notification;
    });
    await withBrowser({ Notification }, async () => {
      await showTaskNotification(
        "Completed",
        { body: "Agent", tag: "task" },
        target,
        () => true,
      );
      expect(Notification).toHaveBeenCalledWith("Completed", {
        body: "Agent",
        tag: "task",
      });
      expect(typeof notification.onclick).toBe("function");
    });
  });

  test("bounds unavailable worker activation and reports registration errors", async () => {
    jest.useFakeTimers();
    try {
      await withBrowser(
        {
          navigator: {
            serviceWorker: { getRegistration: () => new Promise(() => {}) },
          },
        },
        async () => {
          const preparing = prepareTaskNotifications().catch((error) => error);
          jest.advanceTimersByTime(10_000);
          expect((await preparing).message).toContain("did not become ready");
        },
      );
    } finally {
      jest.useRealTimers();
    }
    await withBrowser(
      {
        navigator: {
          serviceWorker: {
            getRegistration: async () => {
              throw new Error("Worker blocked");
            },
          },
        },
      },
      async () => {
        await expect(prepareTaskNotifications()).rejects.toThrow(
          "Worker blocked",
        );
      },
    );
  });

  test("does not hide showNotification rejection", async () => {
    const active = {
      ...registration(),
      showNotification: async () => {
        throw new Error("Delivery denied");
      },
    };
    await withBrowser(
      { navigator: { serviceWorker: { getRegistration: async () => active } } },
      async () => {
        await expect(
          showTaskNotification("Completed", {}, target, () => true),
        ).rejects.toThrow("Delivery denied");
      },
    );
  });

  test("keeps a failed transport disabled and explains the failure", async () => {
    await withBrowser(
      {
        navigator: {
          serviceWorker: {
            getRegistration: async () => {
              throw new Error("Worker blocked");
            },
          },
        },
      },
      async () => {
        await store.setTaskNotificationsEnabled(true);
        expect(store.get().taskNotificationsEnabled).toBe(false);
        expect(store.get().notice).toMatchObject({
          kind: "error",
          message: "Task notifications are unavailable",
          detail: "Worker blocked",
        });
      },
    );
  });

  test.each([
    ["done", "local", true, true],
    ["blocked", "local", true, true],
    ["done", "push", true, false],
    ["blocked", "push", true, false],
    ["done", "local", false, false],
    ["blocked", "local", false, false],
  ] as const)(
    "task %s via %s respects preference %s and reports local failure %s",
    async (status, transport, enabled, fails) => {
      const active = {
        ...registration(),
        showNotification: async () => {
          throw new Error("Delivery denied");
        },
      };
      await withBrowser(
        {
          navigator: { serviceWorker: { getRegistration: async () => active } },
        },
        async () => {
          const previousConnection = bridge.connection;
          const pane = {
            pane_id: "p1",
            workspace_id: "w1",
            terminal_id: "t1",
            tab_id: "tab1",
            focused: false,
            agent: "Agent",
            agent_status: "working",
            revision: 1,
          };
          bridge.connection = (() =>
            ({
              connectionId: "alpha",
              generation: 10,
              isCurrent: () => true,
              call: async (method: string) =>
                method === "pane.list" ? { panes: [{ ...pane }] } : {},
            }) as ConnectionClient) as typeof bridge.connection;
          __storeTesting.replaceState({
            ...store.get(),
            ...emptyServerSessionState(1),
            status: "connected",
            connectionPaused: false,
            activeConnectionId: "alpha",
            connectionGeneration: 10,
            connections: [
              {
                id: "alpha",
                label: "Alpha",
                source: "test",
                is_default: true,
                state: "ready",
                generation: 1,
              },
            ],
            taskNotificationsEnabled: true,
            taskNotificationTransport: transport,
            taskNotificationPreferences: {
              completed: status === "done" ? enabled : true,
              blocked: status === "blocked" ? enabled : true,
            },
            taskNotificationPermission: "granted",
          });
          const failed = Promise.withResolvers<void>();
          const unsubscribe = store.subscribe(() => {
            if (
              store.get().notice?.message ===
              "Task notifications are unavailable"
            )
              failed.resolve();
          });
          try {
            await store.refresh();
            pane.agent_status = status;
            await store.refresh();
            if (fails) {
              await failed.promise;
              expect(store.get().taskNotificationsEnabled).toBe(false);
              expect(store.get().notice).toMatchObject({
                kind: "error",
                detail: "Delivery denied",
              });
            } else {
              for (let index = 0; index < 10; index++) await Promise.resolve();
              expect(store.get().taskNotificationsEnabled).toBe(true);
              expect(store.get().notice?.kind).not.toBe("error");
            }
          } finally {
            unsubscribe();
            bridge.connection = previousConnection;
          }
        },
      );
    },
  );

  test("requests permission in the gesture and cannot re-enable after a later disable", async () => {
    const permission = Promise.withResolvers<NotificationPermission>();
    const requestPermission = mock(() => permission.promise);
    await withBrowser(
      { Notification: { permission: "default", requestPermission } },
      async () => {
        const enabling = store.setTaskNotificationsEnabled(true);
        expect(requestPermission).toHaveBeenCalledTimes(1);
        await store.setTaskNotificationsEnabled(false);
        permission.resolve("granted");
        await enabling;
        expect(store.get().taskNotificationsEnabled).toBe(false);
      },
    );
  });

  test.each([
    target,
    {
      type: "ranger_task",
      taskId: "11111111-1111-4111-8111-111111111111",
      runId: "22222222-2222-4222-8222-222222222222",
    },
  ])(
    "validates worker messages, consumes launch fragments and removes listeners for %j",
    async (activationTarget) => {
      const serviceWorker = new EventTarget();
      const activate = mock();
      const replaceState = mock();
      const location = new URL(
        origin +
          "/#roamgate-task=" +
          encodeURIComponent(JSON.stringify(activationTarget)),
      );
      await withBrowser(
        {
          navigator: { serviceWorker },
          window: {
            location,
            history: { replaceState, state: { scroll: 10 } },
          },
        },
        async () => {
          const stop = listenForTaskNotificationActivation(activate);
          expect(activate).toHaveBeenCalledWith(activationTarget);
          expect(replaceState).toHaveBeenCalledWith({ scroll: 10 }, "", "/");
          activate.mockClear();
          const message = (messageOrigin: string, value: unknown) =>
            new MessageEvent("message", {
              origin: messageOrigin,
              data: { type: TASK_NOTIFICATION_ACTIVATE_EVENT, target: value },
            });
          serviceWorker.dispatchEvent(message("https://other.example", target));
          serviceWorker.dispatchEvent(
            message(origin, { ...target, runtimeGeneration: -1 }),
          );
          serviceWorker.dispatchEvent(
            message(origin, {
              type: "ranger_task",
              taskId: "../invalid",
              runId: "also-invalid",
            }),
          );
          expect(activate).not.toHaveBeenCalled();
          serviceWorker.dispatchEvent(message(origin, activationTarget));
          expect(activate).toHaveBeenCalledTimes(1);
          stop();
          serviceWorker.dispatchEvent(message(origin, activationTarget));
          expect(activate).toHaveBeenCalledTimes(1);
        },
      );
    },
  );
});

describe("notification service worker clicks", () => {
  test("push displays a visible notification with no open page, including malformed payloads", async () => {
    const listeners: Record<string, (event: any) => void> = {};
    const showNotification = mock(async () => {});
    runInNewContext(
      await readFile(
        new URL("../public/task-notifications-sw.js", import.meta.url),
        "utf8",
      ),
      {
        URL,
        self: {
          addEventListener: (name: string, handler: (event: any) => void) => {
            listeners[name] = handler;
          },
          registration: { showNotification },
        },
      },
    );
    let pending: Promise<void> | undefined;
    const message = {
      title: "Roamgate agent needs input",
      body: "Example agent",
      tag: "task",
      target,
    };
    listeners.push({
      data: { json: () => message },
      waitUntil: (value: Promise<void>) => {
        pending = value;
      },
    });
    await pending;
    expect(showNotification).toHaveBeenCalledWith(message.title, {
      body: message.body,
      tag: message.tag,
      data: { type: TASK_NOTIFICATION_ACTIVATE_EVENT, target },
    });
    listeners.push({
      data: {
        json: () => {
          throw new Error("Invalid JSON");
        },
      },
      waitUntil: (value: Promise<void>) => {
        pending = value;
      },
    });
    await pending;
    // Malformed and pane-less payloads still open the app on click.
    expect(showNotification.mock.calls.slice(-1)[0]).toMatchObject([
      "Roamgate agent update",
      { data: { type: TASK_NOTIFICATION_ACTIVATE_EVENT, target: null } },
    ]);
    listeners.push({
      data: {
        json: () => ({
          title: "codex needs input",
          body: "idle",
          target: null,
        }),
      },
      waitUntil: (value: Promise<void>) => {
        pending = value;
      },
    });
    await pending;
    expect(showNotification).toHaveBeenLastCalledWith("codex needs input", {
      body: "idle",
      tag: "roamgate-task",
      data: { type: TASK_NOTIFICATION_ACTIVATE_EVENT, target: null },
    });
  });
  test("focuses an app window or opens a same-origin pane link without caching", async () => {
    const listeners: Record<string, (event: any) => void> = {};
    const postMessage = mock();
    const focus = mock(async () => {
      throw new Error("Focus denied");
    });
    let windows: any[] = [
      { url: origin + "/login", focus: mock() },
      { url: origin + "/", focus, postMessage },
    ];
    const openWindow = mock(async () => {});
    runInNewContext(
      await readFile(
        new URL("../public/task-notifications-sw.js", import.meta.url),
        "utf8",
      ),
      {
        URL,
        self: {
          location: { origin },
          addEventListener: (name: string, handler: (event: any) => void) => {
            listeners[name] = handler;
          },
          clients: { matchAll: async () => windows, openWindow },
        },
      },
    );
    expect(Object.keys(listeners).sort()).toEqual([
      "install",
      "notificationclick",
      "push",
    ]);
    const close = mock();
    let pending: Promise<void> | undefined;
    const event = {
      notification: {
        close,
        data: { type: TASK_NOTIFICATION_ACTIVATE_EVENT, target },
      },
      waitUntil: (promise: Promise<void>) => {
        pending = promise;
      },
    };
    listeners.notificationclick(event);
    await pending;
    expect(close).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(event.notification.data);
    expect(openWindow).not.toHaveBeenCalled();
    windows = [{ url: "https://other.example/", focus: mock() }];
    listeners.notificationclick(event);
    await pending;
    expect(openWindow).toHaveBeenCalledWith(
      origin + "/#roamgate-task=" + encodeURIComponent(JSON.stringify(target)),
    );
  });
  test("pane-less clicks focus the app without navigating", async () => {
    const listeners: Record<string, (event: any) => void> = {};
    const postMessage = mock();
    const focus = mock(async () => {});
    let windows: any[] = [{ url: origin + "/", focus, postMessage }];
    const openWindow = mock(async () => {});
    runInNewContext(
      await readFile(
        new URL("../public/task-notifications-sw.js", import.meta.url),
        "utf8",
      ),
      {
        URL,
        self: {
          location: { origin },
          addEventListener: (name: string, handler: (event: any) => void) => {
            listeners[name] = handler;
          },
          clients: { matchAll: async () => windows, openWindow },
        },
      },
    );
    let pending: Promise<void> | undefined;
    const event = {
      notification: {
        close: mock(),
        data: { type: TASK_NOTIFICATION_ACTIVATE_EVENT, target: null },
      },
      waitUntil: (promise: Promise<void>) => {
        pending = promise;
      },
    };
    listeners.notificationclick(event);
    await pending;
    expect(focus).toHaveBeenCalledTimes(1);
    expect(postMessage).not.toHaveBeenCalled();
    windows = [];
    listeners.notificationclick(event);
    await pending;
    expect(openWindow).toHaveBeenCalledWith(origin + "/");
  });

  test("Ranger push and clicks retain valid task run targets and discard malformed ones", async () => {
    const listeners: Record<string, (event: any) => void> = {};
    const ranger = {
      type: "ranger_task",
      taskId: "e68b82c6-0d6b-4083-b6b3-c3a7de983f94",
      runId: "9023a84e-e705-4c34-bcce-77c951e2de56",
    };
    let data: Record<string, unknown> | undefined;
    const showNotification = mock(
      async (_title: string, options: NotificationOptions) => {
        data = options.data;
      },
    );
    const postMessage = mock();
    const focus = mock(async () => {});
    let windows: any[] = [];
    const openWindow = mock(async () => {});
    runInNewContext(
      await readFile(
        new URL("../public/task-notifications-sw.js", import.meta.url),
        "utf8",
      ),
      {
        URL,
        self: {
          location: { origin },
          addEventListener: (name: string, handler: (event: any) => void) => {
            listeners[name] = handler;
          },
          registration: { showNotification },
          clients: { matchAll: async () => windows, openWindow },
        },
      },
    );
    let pending: Promise<void> | undefined;
    const waitUntil = (value: Promise<void>) => {
      pending = value;
    };
    listeners.push({
      data: {
        json: () => ({ title: "Ranger task failed", target: ranger }),
      },
      waitUntil,
    });
    await pending;
    expect(data).toEqual({
      type: TASK_NOTIFICATION_ACTIVATE_EVENT,
      target: ranger,
    });
    const click = (targetData: unknown) => {
      listeners.notificationclick({
        notification: { close: mock(), data: targetData },
        waitUntil,
      });
      return pending;
    };
    await click(data);
    expect(openWindow).toHaveBeenLastCalledWith(
      origin + "/#roamgate-task=" + encodeURIComponent(JSON.stringify(ranger)),
    );
    windows = [{ url: origin + "/", focus, postMessage }];
    await click(data);
    expect(postMessage).toHaveBeenCalledWith(data);
    for (const target of [
      { ...ranger, taskId: "../escape" },
      { ...ranger, runId: null },
      { ...ranger, runId: "" },
    ]) {
      listeners.push({ data: { json: () => ({ target }) }, waitUntil });
      await pending;
      expect(data?.target).toBeNull();
      windows = [];
      // Validate click data independently of push parsing.
      await click({ type: TASK_NOTIFICATION_ACTIVATE_EVENT, target });
      expect(openWindow).toHaveBeenLastCalledWith(origin + "/");
    }
    expect(postMessage).toHaveBeenCalledTimes(1);
  });
});

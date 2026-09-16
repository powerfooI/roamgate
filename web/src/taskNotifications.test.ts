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
    active: { scriptURL: origin + "/task-notifications-sw.js" },
    showNotification: mock(async () => {}),
  };
}

describe("task notification transport", () => {
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
      expect(register).toHaveBeenCalledWith("/task-notifications-sw.js", {
        updateViaCache: "none",
      });
      pending.active = active.active;
      ready.resolve();
      await showing;
      expect(active.showNotification).not.toHaveBeenCalled();
    });
  });

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

  test("a completed task reports delivery failure instead of silently staying enabled", async () => {
    const active = {
      ...registration(),
      showNotification: async () => {
        throw new Error("Delivery denied");
      },
    };
    await withBrowser(
      { navigator: { serviceWorker: { getRegistration: async () => active } } },
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
          taskNotificationPermission: "granted",
        });
        const failed = Promise.withResolvers<void>();
        const unsubscribe = store.subscribe(() => {
          if (
            store.get().notice?.message === "Task notifications are unavailable"
          )
            failed.resolve();
        });
        try {
          await store.refresh();
          pane.agent_status = "done";
          await store.refresh();
          await failed.promise;
          expect(store.get().taskNotificationsEnabled).toBe(false);
          expect(store.get().notice).toMatchObject({
            kind: "error",
            detail: "Delivery denied",
          });
        } finally {
          unsubscribe();
          bridge.connection = previousConnection;
        }
      },
    );
  });

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

  test("validates worker messages, consumes launch fragments and removes listeners", async () => {
    const serviceWorker = new EventTarget();
    const activate = mock();
    const replaceState = mock();
    const location = new URL(
      origin + "/#roamgate-task=" + encodeURIComponent(JSON.stringify(target)),
    );
    await withBrowser(
      {
        navigator: { serviceWorker },
        window: { location, history: { replaceState, state: { scroll: 10 } } },
      },
      async () => {
        const stop = listenForTaskNotificationActivation(activate);
        expect(activate).toHaveBeenCalledWith(target);
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
        expect(activate).not.toHaveBeenCalled();
        serviceWorker.dispatchEvent(message(origin, target));
        expect(activate).toHaveBeenCalledTimes(1);
        stop();
        serviceWorker.dispatchEvent(message(origin, target));
        expect(activate).toHaveBeenCalledTimes(1);
      },
    );
  });
});

describe("notification service worker clicks", () => {
  test("focuses an app window or opens a same-origin pane link, without caching or push handlers", async () => {
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
});

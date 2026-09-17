import { expect, mock, test } from "bun:test";
import { syncTaskPush } from "./taskPush";

const origin = "https://roamgate.example";
const publicKey = btoa(String.fromCharCode(4, ...Array(64).fill(1)))
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");
const preferences = { completed: true, blocked: true };
async function browser(
  run: (value: ReturnType<typeof fixture>) => Promise<void>,
) {
  const f = fixture();
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: { location: new URL(origin), PushManager: {} },
    navigator: {
      serviceWorker: { getRegistration: async () => f.registration },
    },
    fetch: f.fetch,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  try {
    await run(f);
  } finally {
    for (const [key, value] of previous) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}
function fixture() {
  const f = {
    existing: null as PushSubscription | null,
    available: true,
    fail: "",
    calls: [] as Array<{ method: string; body: any }>,
    fetch: mock(async (_url: unknown, options: RequestInit) => {
      f.calls.push({
        method: options.method!,
        body: options.body ? JSON.parse(String(options.body)) : null,
      });
      expect(options.credentials).toBe("same-origin");
      expect(
        (options.headers as Record<string, string>)["X-Roamgate-Push"],
      ).toBe("1");
      return Response.json(
        options.method === "GET"
          ? { available: f.available, publicKey }
          : { ok: true },
        { status: options.method === f.fail ? 503 : 200 },
      );
    }),
    subscription: {
      endpoint: "https://fcm.googleapis.com/fcm/send/example-device",
      options: {},
      toJSON() {
        return {
          endpoint: this.endpoint,
          keys: { p256dh: "test-key", auth: "test-auth" },
        };
      },
      unsubscribe: mock(async () => {
        f.existing = null;
        return true;
      }),
    },
    registration: {
      active: { scriptURL: origin + "/task-notifications-sw.js" },
      showNotification() {},
      pushManager: {
        getSubscription: async () => f.existing,
        subscribe: mock(async (options: PushSubscriptionOptionsInit) => {
          expect(options.userVisibleOnly).toBe(true);
          f.existing = f.subscription as unknown as PushSubscription;
          return f.existing;
        }),
      },
    },
  };
  return f;
}

test("device enrollment, independent preference updates and revocation use the existing worker", async () => {
  await browser(async (f) => {
    expect(await syncTaskPush(true, preferences, true)).toBe("push");
    expect(f.registration.pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(
      f.registration.pushManager.subscribe.mock.calls[0]![0],
    ).toMatchObject({ userVisibleOnly: true });
    expect(f.calls.slice(-1)[0]?.body.preferences).toEqual(preferences);
    expect(await syncTaskPush(true, { completed: false, blocked: true })).toBe(
      "push",
    );
    expect(f.calls.slice(-1)[0]?.body.preferences).toEqual({
      completed: false,
      blocked: true,
    });
    expect(f.registration.pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(await syncTaskPush(false, preferences)).toBe("local");
    expect(f.calls.slice(-1)[0]).toEqual({
      method: "DELETE",
      body: { endpoint: f.subscription.endpoint },
    });
    expect(f.subscription.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

test("unconfigured servers fall back locally and passive restoration never prompts for a subscription", async () => {
  await browser(async (f) => {
    f.available = false;
    expect(await syncTaskPush(true, preferences, true)).toBe("local");
    f.available = true;
    expect(await syncTaskPush(true, preferences)).toBe("local");
    expect(f.registration.pushManager.subscribe).not.toHaveBeenCalled();
  });
});

test("failed enrollment unsubscribes, while failed revocation preserves a retryable subscription", async () => {
  await browser(async (f) => {
    f.fail = "POST";
    await expect(syncTaskPush(true, preferences, true)).rejects.toThrow(
      "Unable to update",
    );
    expect(f.subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(f.existing).toBeNull();
    f.fail = "";
    await syncTaskPush(true, preferences, true);
    f.fail = "DELETE";
    await expect(syncTaskPush(false, preferences)).rejects.toThrow(
      "Unable to update",
    );
    expect(f.subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(f.existing).not.toBeNull();
  });
});

test("late enrollment finishes before a queued revocation, never re-enabling the device", async () => {
  await browser(async (f) => {
    const gate = Promise.withResolvers<PushSubscription>();
    const started = Promise.withResolvers<void>();
    f.registration.pushManager.subscribe.mockImplementation(async () => {
      started.resolve();
      f.existing = await gate.promise;
      return f.existing;
    });
    const enabling = syncTaskPush(true, preferences, true);
    await started.promise;
    const disabling = syncTaskPush(false, preferences);
    gate.resolve(f.subscription as unknown as PushSubscription);
    expect(await enabling).toBe("push");
    expect(await disabling).toBe("local");
    expect(f.calls.map((call) => call.method)).toEqual([
      "GET",
      "POST",
      "DELETE",
    ]);
    expect(f.existing).toBeNull();
  });
});

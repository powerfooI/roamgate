import { prepareTaskNotifications } from "./taskNotifications";

export interface TaskNotificationPreferences {
  completed: boolean;
  blocked: boolean;
}

async function pushRequest(method: "GET" | "POST" | "DELETE", body?: unknown) {
  const response = await fetch("/api/notifications/push", {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Roamgate-Push": "1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(
      "Unable to update background notifications. Check the server connection and try again.",
    );
  return response.json() as Promise<{
    available?: boolean;
    publicKey?: string;
  }>;
}

let updates: Promise<unknown> = Promise.resolve();

/** Serialize subscription changes so a late enable cannot undo a device revocation. */
export function syncTaskPush(
  enabled: boolean,
  preferences: TaskNotificationPreferences,
  allowSubscribe = false,
): Promise<"push" | "local"> {
  const task = updates
    .catch(() => {})
    .then(async () => {
      if (
        typeof navigator === "undefined" ||
        !navigator.serviceWorker ||
        !("PushManager" in window)
      )
        return "local" as const;
      const registration = enabled
        ? await prepareTaskNotifications()
        : await navigator.serviceWorker.getRegistration("/");
      if (!registration?.pushManager) return "local" as const;
      let subscription = await registration.pushManager.getSubscription();
      if (!enabled) {
        if (subscription) {
          // Persist revocation first; offline errors must not look like successful removal.
          await pushRequest("DELETE", { endpoint: subscription.endpoint });
          if (!(await subscription.unsubscribe()))
            throw new Error(
              "The browser could not revoke its push subscription. Try again.",
            );
        }
        return "local" as const;
      }
      const config = await pushRequest("GET");
      if (!config.available || !config.publicKey) {
        if (subscription && !(await subscription.unsubscribe()))
          throw new Error("Unable to disable the previous push subscription.");
        return "local" as const;
      }
      const applicationServerKey = Uint8Array.from(
        atob(config.publicKey.replace(/-/g, "+").replace(/_/g, "/")),
        (char) => char.charCodeAt(0),
      );
      if (
        subscription?.options.applicationServerKey &&
        new Uint8Array(subscription.options.applicationServerKey).some(
          (byte, index) => byte !== applicationServerKey[index],
        )
      ) {
        await pushRequest("DELETE", { endpoint: subscription.endpoint });
        if (!(await subscription.unsubscribe()))
          throw new Error("Unable to replace the previous push subscription.");
        subscription = null;
      }
      let created = false;
      if (!subscription && allowSubscribe) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        });
        created = true;
      }
      if (!subscription) return "local" as const;
      try {
        await pushRequest("POST", {
          subscription: subscription.toJSON(),
          preferences,
        });
      } catch (error) {
        if (created) await subscription.unsubscribe();
        throw error;
      }
      return "push" as const;
    });
  updates = task;
  return task;
}

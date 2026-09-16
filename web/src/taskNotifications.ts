export const TASK_NOTIFICATION_ACTIVATE_EVENT =
  "roamgate:task-notification-activate";
const NOTIFICATION_WORKER = "/task-notifications-sw.js";
const NOTIFICATION_HASH = "#roamgate-task=";

export interface TaskNotificationTarget {
  connectionId: string;
  runtimeGeneration: number;
  workspaceId: string;
  paneId: string;
}

export function isTaskNotificationTarget(
  value: unknown,
): value is TaskNotificationTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Partial<TaskNotificationTarget>;
  return (
    typeof target.connectionId === "string" &&
    target.connectionId.length > 0 &&
    typeof target.runtimeGeneration === "number" &&
    Number.isSafeInteger(target.runtimeGeneration) &&
    target.runtimeGeneration >= 0 &&
    typeof target.workspaceId === "string" &&
    target.workspaceId.length > 0 &&
    typeof target.paneId === "string" &&
    target.paneId.length > 0
  );
}

/** Connect a system notification click to the in-app pane navigation path. */
export function bindTaskNotificationActivation(
  notification: Pick<Notification, "close" | "onclick">,
  target: TaskNotificationTarget,
  activate: (target: TaskNotificationTarget) => void = (nextTarget) => {
    window.dispatchEvent(
      new CustomEvent<TaskNotificationTarget>(
        TASK_NOTIFICATION_ACTIVATE_EVENT,
        {
          detail: nextTarget,
        },
      ),
    );
  },
  focusWindow: () => void = () => window.focus(),
) {
  notification.onclick = () => {
    try {
      notification.close();
    } catch {
      // Notification cleanup must not block navigation.
    }
    try {
      focusWindow();
    } catch {
      // Browsers may deny focus even for a notification click.
    }
    activate(target);
  };
}

export async function prepareTaskNotifications(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) return null;
  const serviceWorker = navigator.serviceWorker;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        let registration = await serviceWorker.getRegistration("/");
        if (
          registration?.active?.scriptURL !==
          new URL(NOTIFICATION_WORKER, window.location.origin).href
        ) {
          registration = await serviceWorker.register(NOTIFICATION_WORKER, {
            updateViaCache: "none",
          });
        }
        if (!registration.active) await serviceWorker.ready;
        if (!registration.active) {
          throw new Error(
            "The notification service worker could not activate.",
          );
        }
        return typeof registration.showNotification === "function"
          ? registration
          : null;
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "The notification service worker did not become ready. Check the connection and try again.",
              ),
            ),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function showTaskNotification(
  title: string,
  options: NotificationOptions,
  target: TaskNotificationTarget,
  isCurrent: () => boolean,
): Promise<void> {
  const registration = await prepareTaskNotifications();
  if (!isCurrent()) return;
  if (registration) {
    await registration.showNotification(title, {
      ...options,
      data: { type: TASK_NOTIFICATION_ACTIVATE_EVENT, target },
    });
  } else {
    bindTaskNotificationActivation(new Notification(title, options), target);
  }
}

/** Route worker clicks and newly opened notification windows through the same UI. */
export function listenForTaskNotificationActivation(
  activate: (target: TaskNotificationTarget) => void,
): () => void {
  const receive = (event: MessageEvent) => {
    if (
      event.origin !== window.location.origin ||
      event.data?.type !== TASK_NOTIFICATION_ACTIVATE_EVENT ||
      !isTaskNotificationTarget(event.data.target)
    )
      return;
    activate(event.data.target);
  };
  navigator.serviceWorker?.addEventListener("message", receive);
  if (window.location.hash.startsWith(NOTIFICATION_HASH)) {
    const encoded = window.location.hash.slice(NOTIFICATION_HASH.length);
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + window.location.search,
    );
    try {
      const target: unknown = JSON.parse(decodeURIComponent(encoded));
      if (isTaskNotificationTarget(target)) activate(target);
    } catch {
      // A malformed or stale deep link must not interrupt app startup.
    }
  }
  return () => navigator.serviceWorker?.removeEventListener("message", receive);
}

export const TASK_NOTIFICATION_ACTIVATE_EVENT =
  "roamgate:task-notification-activate";
// Bump when the notification payload contract changes.
const NOTIFICATION_WORKER = "/task-notifications-sw.js?v=2";
const NOTIFICATION_HASH = "#roamgate-task=";

export interface TaskNotificationTarget {
  connectionId: string;
  runtimeGeneration: number;
  workspaceId: string;
  paneId: string;
}

export interface RangerTaskNotificationTarget {
  type: "ranger_task";
  taskId: string;
  runId: string;
}

export type NotificationTarget =
  | TaskNotificationTarget
  | RangerTaskNotificationTarget;

export function isRangerTaskNotificationTarget(
  value: unknown,
): value is RangerTaskNotificationTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const target = value as Partial<RangerTaskNotificationTarget>;
  const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
  return (
    target.type === "ranger_task" &&
    typeof target.taskId === "string" &&
    uuid.test(target.taskId) &&
    typeof target.runId === "string" &&
    uuid.test(target.runId)
  );
}

export function isNotificationTarget(
  value: unknown,
): value is NotificationTarget {
  return (
    isRangerTaskNotificationTarget(value) || isTaskNotificationTarget(value)
  );
}

export function isTaskNotificationTarget(
  value: unknown,
): value is TaskNotificationTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const target = value as Partial<TaskNotificationTarget>;
  return (
    !("type" in target) &&
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

/** Connect a system notification click to its in-app navigation path. */
export function bindTaskNotificationActivation<T extends NotificationTarget>(
  notification: Pick<Notification, "close" | "onclick">,
  target: T,
  activate: (target: T) => void = (nextTarget) => {
    window.dispatchEvent(
      new CustomEvent<NotificationTarget>(TASK_NOTIFICATION_ACTIVATE_EVENT, {
        detail: nextTarget,
      }),
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
  const lifecycle = new AbortController();
  try {
    return await Promise.race([
      (async () => {
        let registration = await serviceWorker.getRegistration("/");
        const workerURL = new URL(NOTIFICATION_WORKER, window.location.origin)
          .href;
        if (registration?.active?.scriptURL !== workerURL) {
          registration = await serviceWorker.register(NOTIFICATION_WORKER, {
            updateViaCache: "none",
          });
        }
        const worker =
          registration.installing ??
          registration.waiting ??
          registration.active;
        if (worker && worker.state !== "activated") {
          await new Promise<void>((resolve, reject) => {
            const stateChanged = () => {
              if (worker.state === "activated") resolve();
              else if (worker.state === "redundant")
                reject(
                  new Error(
                    "The notification service worker could not activate.",
                  ),
                );
            };
            worker.addEventListener("statechange", stateChanged, {
              signal: lifecycle.signal,
            });
            stateChanged();
          });
        }
        if (!registration.active) await serviceWorker.ready;
        if (registration.active?.scriptURL !== workerURL) {
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
    lifecycle.abort();
  }
}

/** A notification without a target only focuses the app. */
export async function showTaskNotification(
  title: string,
  options: NotificationOptions,
  target: NotificationTarget | null,
  isCurrent: () => boolean,
): Promise<void> {
  const registration = await prepareTaskNotifications();
  if (!isCurrent()) return;
  if (registration) {
    await registration.showNotification(title, {
      ...options,
      data: { type: TASK_NOTIFICATION_ACTIVATE_EVENT, target },
    });
  } else if (target) {
    bindTaskNotificationActivation(new Notification(title, options), target);
  } else {
    const notification = new Notification(title, options);
    notification.onclick = () => {
      notification.close();
      window.focus();
    };
  }
}

/** Route worker clicks and newly opened notification windows through the same UI. */
export function listenForTaskNotificationActivation(
  activate: (target: NotificationTarget) => void,
): () => void {
  const receive = (event: MessageEvent) => {
    if (
      event.origin !== window.location.origin ||
      event.data?.type !== TASK_NOTIFICATION_ACTIVATE_EVENT ||
      !isNotificationTarget(event.data.target)
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
      if (isNotificationTarget(target)) activate(target);
    } catch {
      // A malformed or stale deep link must not interrupt app startup.
    }
  }
  return () => navigator.serviceWorker?.removeEventListener("message", receive);
}

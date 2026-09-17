/* global self, URL */

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let message;
      try {
        message = event.data?.json();
      } catch {
        /* Show a visible fallback for invalid payloads. */
      }
      const target = message?.target;
      const valid =
        target &&
        typeof target.connectionId === "string" &&
        target.connectionId &&
        Number.isSafeInteger(target.runtimeGeneration) &&
        target.runtimeGeneration >= 0 &&
        typeof target.workspaceId === "string" &&
        target.workspaceId &&
        typeof target.paneId === "string" &&
        target.paneId;
      await self.registration.showNotification(
        typeof message?.title === "string"
          ? message.title
          : "Roamgate agent update",
        {
          body:
            typeof message?.body === "string"
              ? message.body
              : "Open Roamgate to check your agents.",
          tag: typeof message?.tag === "string" ? message.tag : "roamgate-task",
          data: valid
            ? { type: "roamgate:task-notification-activate", target }
            : null,
        },
      );
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data;
  if (data?.type !== "roamgate:task-notification-activate") return;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const appWindows = windows.filter((client) => {
        const url = new URL(client.url);
        return (
          url.origin === self.location.origin &&
          (url.pathname === "/" || url.pathname === "/index.html")
        );
      });
      appWindows.sort((a, b) => Number(b.focused) - Number(a.focused));
      for (const client of appWindows) {
        try {
          await client.focus().catch(() => {});
          client.postMessage(data);
          return;
        } catch {
          // A window can close between discovery and activation.
        }
      }
      const url = new URL("/", self.location.origin);
      url.hash =
        "roamgate-task=" + encodeURIComponent(JSON.stringify(data.target));
      await self.clients.openWindow(url.href);
    })(),
  );
});

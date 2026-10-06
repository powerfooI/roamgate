import {
  instanceDisplayName,
  normalizeTitleSuffix,
  type InstanceSettings,
} from "../../shared/instanceName";

export function applyInstanceName(
  settings: InstanceSettings,
  target: Document = document,
) {
  const name = instanceDisplayName(settings.title_suffix);
  const changed = target.title !== name;
  target.title = name;
  for (const meta of target.querySelectorAll(
    'meta[name="apple-mobile-web-app-title"], meta[name="application-name"]',
  ))
    meta.setAttribute("content", name);
  if (changed) {
    // Reconnecting the link invalidates parsed manifest metadata in browsers
    // that keep it in memory; assigning the same href may leave it cached.
    // Keep the URL and all attributes so application identity stays stable.
    const manifest = target.querySelector('link[rel~="manifest"]');
    manifest?.replaceWith(manifest.cloneNode(true));
  }
}

function parseInstanceSettings(value: unknown): InstanceSettings {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid instance settings received from the server.");
  return {
    title_suffix: normalizeTitleSuffix(
      (value as Record<string, unknown>).title_suffix,
    ),
  };
}

export function createInstanceNameClient(
  fetcher: (url: string, init: RequestInit) => Promise<Response> = (...args) =>
    fetch(...args),
  apply: (settings: InstanceSettings) => void = applyInstanceName,
) {
  let sequence = 0;
  let latest: Promise<InstanceSettings>;
  let pendingSave: Promise<InstanceSettings> | null = null;

  const request = async (method: "GET" | "PUT", suffix?: string) => {
    // AbortSignal.timeout is newer than the supported browser baseline.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetcher("/api/instance-settings", {
        method,
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
        ...(method === "PUT"
          ? {
              headers: {
                "Content-Type": "application/json",
                "X-Roamgate-Settings": "1",
              },
              body: JSON.stringify({ title_suffix: suffix }),
            }
          : {}),
      });
      if (!response.ok) {
        let message = `Unable to ${method === "GET" ? "load" : "save"} the instance name (HTTP ${response.status}).`;
        try {
          const body: unknown = await response.json();
          if (
            body &&
            typeof body === "object" &&
            "error" in body &&
            typeof body.error === "string"
          )
            message = body.error;
        } catch {
          // A proxy or expired login may return an HTML error page.
        }
        throw new Error(message);
      }
      return parseInstanceSettings(await response.json());
    } finally {
      clearTimeout(timeout);
    }
  };

  const run = (method: "GET" | "PUT", suffix?: string) => {
    const current = ++sequence;
    latest = (async () => {
      try {
        const settings = await request(method, suffix);
        // A read started before a save (or a newer read) must not restore an
        // old title or return stale settings to a newly opened editor.
        if (current !== sequence) return latest;
        apply(settings);
        return settings;
      } catch (error) {
        if (current !== sequence) return latest;
        throw error;
      }
    })();
    return latest;
  };

  return {
    load(): Promise<InstanceSettings> {
      return pendingSave ?? run("GET");
    },
    save(suffix: string): Promise<InstanceSettings> {
      if (pendingSave) return pendingSave;
      const normalized = normalizeTitleSuffix(suffix);
      // Keep the mutation alive across view dismissal. Duplicate submissions
      // and new readers share its confirmed outcome.
      pendingSave = run("PUT", normalized).finally(() => {
        pendingSave = null;
      });
      return pendingSave;
    },
  };
}

export type InstanceNameClient = ReturnType<typeof createInstanceNameClient>;
export const instanceNameClient = createInstanceNameClient();

export function initializeInstanceName(
  client: InstanceNameClient = instanceNameClient,
  browser: Window = window,
) {
  let refreshing = false;
  let stopped = false;
  const refresh = () => {
    if (stopped || refreshing) return;
    refreshing = true;
    void client
      .load()
      .catch(() => {
        // Keep the last confirmed title while offline or signed out. Opening
        // the settings editor exposes load errors and an explicit retry.
      })
      .finally(() => {
        refreshing = false;
      });
  };
  const onVisible = () => {
    if (browser.document.visibilityState === "visible") refresh();
  };
  refresh();
  browser.addEventListener("focus", onVisible);
  browser.document.addEventListener("visibilitychange", onVisible);
  return () => {
    stopped = true;
    browser.removeEventListener("focus", onVisible);
    browser.document.removeEventListener("visibilitychange", onVisible);
  };
}

import { bridge } from "./api";

/** The hashed entry script an index page loads, e.g. `/assets/index-Ab12.js`. */
export function entryScript(html: string): string | null {
  return /\/assets\/index-[\w-]+\.js/.exec(html)?.[0] ?? null;
}

type FreshnessOptions = {
  /** Calls back each time the bridge connects; returns an unsubscribe. */
  onConnected?: (callback: () => void) => () => void;
  /** The index page the server serves now. */
  fetchIndex?: () => Promise<string | null>;
  reload?: () => void;
};

async function fetchServedIndex() {
  const response = await fetch("/", {
    cache: "no-store",
    credentials: "same-origin",
  });
  return response.ok ? response.text() : null;
}

/** True while the focused field holds text the user has not sent yet. */
function writing() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  const editable =
    active.isContentEditable ||
    active.tagName === "TEXTAREA" ||
    active.tagName === "INPUT";
  const text =
    active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement
      ? active.value
      : (active.textContent ?? "");
  return editable && text.trim() !== "";
}

/**
 * Reloads the page when the server now serves another frontend build. Without
 * it an open page keeps running the old code against the new server after an
 * upgrade made outside this page (another browser, a package manager, a
 * development deploy that keeps the version). Checked when the bridge
 * reconnects (a restart drops it) and when the page comes back to the
 * foreground (a phone reopening its installed app restores the page without
 * reloading it). A field holding unsent text delays the reload until it is
 * emptied or left.
 */
export function startFrontendFreshness({
  onConnected = (callback) =>
    bridge.onStatus((status) => {
      if (status === "connected") callback();
    }),
  fetchIndex = fetchServedIndex,
  reload = () => window.location.reload(),
}: FreshnessOptions = {}): () => void {
  const running = entryScript(
    document.querySelector<HTMLScriptElement>(
      'script[type="module"][src*="/assets/index-"]',
    )?.src ?? "",
  );
  // A development server (Vite) has no hashed entry: nothing to compare.
  if (!running) return () => {};
  let checking = false;
  let stale = false;
  let reloading = false;
  const reloadWhenFree = () => {
    if (reloading) return;
    if (writing()) {
      stale = true;
      return;
    }
    reloading = true;
    reload();
  };
  const onWritingEnds = () => {
    if (stale) setTimeout(reloadWhenFree, 0);
  };
  document.addEventListener("focusout", onWritingEnds, true);
  document.addEventListener("input", onWritingEnds, true);
  const check = async () => {
    if (checking || reloading) return;
    checking = true;
    try {
      const html = await fetchIndex();
      const served = html ? entryScript(html) : null;
      if (served && served !== running) reloadWhenFree();
    } catch {
      // Unreachable for now: the next reconnect checks again.
    } finally {
      checking = false;
    }
  };
  const offConnected = onConnected(() => void check());
  const onVisible = () => {
    if (document.visibilityState === "visible") void check();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    offConnected();
    document.removeEventListener("visibilitychange", onVisible);
    document.removeEventListener("focusout", onWritingEnds, true);
    document.removeEventListener("input", onWritingEnds, true);
  };
}

import { bridge } from "./api";
import { terminalComposerBusy } from "./terminalComposer";

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

/** Blurring a field does not save its contents. */
function writing() {
  if (terminalComposerBusy()) return true;
  if (document.querySelector('[role="dialog"], [role="alertdialog"]'))
    return true;
  return [
    ...document.querySelectorAll("input, textarea, [contenteditable]"),
  ].some((field) => {
    if (
      field instanceof HTMLInputElement ||
      field instanceof HTMLTextAreaElement
    ) {
      if (field.disabled || field.readOnly) return false;
      if (
        field instanceof HTMLInputElement &&
        /^(button|submit|reset|checkbox|radio|range|color|hidden)$/.test(
          field.type,
        )
      )
        return false;
      return field.value !== "";
    }
    return (
      field.getAttribute("contenteditable") !== "false" && !!field.textContent
    );
  });
}

/**
 * Reloads the page when the server now serves another frontend build. Without
 * it an open page keeps running the old code against the new server after an
 * upgrade made outside this page (another browser, a package manager, a
 * development deploy that keeps the version). Checked when the bridge
 * reconnects (a restart drops it) and when the page comes back to the
 * foreground (a phone reopening its installed app restores the page without
 * reloading it). A field holding unsent text delays the reload until it is
 * emptied or saved. Uploads and submissions must also finish first.
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
  let disposed = false;
  let retry: ReturnType<typeof setInterval> | undefined;
  const reloadWhenFree = () => {
    if (disposed || reloading) return;
    if (writing()) {
      stale = true;
      retry ??= setInterval(reloadWhenFree, 1000);
      return;
    }
    clearInterval(retry);
    reloading = true;
    reload();
  };
  const onWritingEnds = () => {
    if (stale) setTimeout(reloadWhenFree, 0);
  };
  document.addEventListener("focusout", onWritingEnds, true);
  document.addEventListener("input", onWritingEnds, true);
  const check = async () => {
    if (disposed || checking || reloading) return;
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
    disposed = true;
    clearInterval(retry);
    offConnected();
    document.removeEventListener("visibilitychange", onVisible);
    document.removeEventListener("focusout", onWritingEnds, true);
    document.removeEventListener("input", onWritingEnds, true);
  };
}

import { bridge } from "./api";
import { terminalComposerBusy } from "./terminalComposer";

/** The hashed entry script an index page loads, e.g. `/assets/index-Ab12.js`. */
export function entryScript(html: string): string | null {
  return /\/assets\/index-[\w-]+\.js/.exec(html)?.[0] ?? null;
}

/** Checked this often too, whatever else happens. */
export const POLL_MS = 5 * 60_000;
/** A keystroke this recent: the user is typing, the reload waits. */
export const TYPING_QUIET_MS = 5_000;
/** An open dialog is closed by the reload once the user left it this long. */
export const IDLE_RELOAD_MS = 2 * 60_000;
/** A short wait says nothing; past this, the notice shows. */
export const NOTICE_AFTER_MS = 15_000;

/**
 * What the page holds when a newer build is served: whether a reload now
 * loses something, and what.
 */
export type ReloadSituation = {
  /** A message or upload on its way. */
  sending: boolean;
  /** Text typed in a field that does not keep it across a reload. */
  unsaved: boolean;
  /** A key pressed within TYPING_QUIET_MS. */
  typing: boolean;
  /** A dialog shows: the reload closes it. */
  dialog: boolean;
};

/**
 * Why the reload waits: "wait" for a moment that comes by itself, "idle"
 * for the user to leave the page alone IDLE_RELOAD_MS (or hide it), "ask"
 * for the user only (the notice's button), as a reload would lose text.
 */
export type ReloadHold = { reason: string; until: "wait" | "idle" | "ask" };

/** What holds a reload back now; null: reload. */
export function reloadHold(situation: ReloadSituation): ReloadHold | null {
  if (situation.sending)
    return { reason: "the composer to finish sending", until: "wait" };
  if (situation.unsaved)
    return { reason: "unsaved text to be sent or cleared", until: "ask" };
  if (situation.typing) return { reason: "a pause in typing", until: "wait" };
  if (situation.dialog) return { reason: "the dialog to close", until: "idle" };
  return null;
}

/** What a page waiting for its reload shows. */
export type FreshnessState = {
  /** A newer build is served and this page has not taken it yet. */
  stale: boolean;
  /** Why the reload waits, for the notice; null when it shows none. */
  notice: string | null;
};

let state: FreshnessState = { stale: false, notice: null };
const listeners = new Set<() => void>();
let reloadNow: (() => void) | null = null;
let checkNow: (() => void) | null = null;

function publish(next: FreshnessState) {
  if (next.stale === state.stale && next.notice === state.notice) return;
  state = next;
  for (const listener of listeners) listener();
}

export function frontendFreshnessState(): FreshnessState {
  return state;
}

export function subscribeFrontendFreshness(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The notice's button: reload now, whatever waits. */
export function reloadForNewerBuild() {
  reloadNow?.();
}

/**
 * Asks whether the server serves another build: a page failing against the
 * server may be running old code.
 */
export function checkFrontendFreshness() {
  checkNow?.();
}

async function fetchServedIndex() {
  const response = await fetch("/", {
    cache: "no-store",
    credentials: "same-origin",
  });
  return response.ok ? response.text() : null;
}

const NOT_TEXT = /^(button|submit|reset|checkbox|radio|range|color|hidden)$/;

/**
 * The text a contenteditable holds, without what the editor shows in it but
 * the user did not write: CodeMirror's placeholder ("Message claude...")
 * made every empty chat box count as holding text, which held every reload
 * back for good.
 */
export function editableText(field: Element): string {
  let text = "";
  const walk = (node: Node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) text += child.nodeValue ?? "";
      else if (
        child.nodeType === 1 &&
        !(child as Element).matches(
          '[contenteditable="false"], [aria-hidden="true"], .cm-placeholder',
        )
      )
        walk(child);
    }
  };
  walk(field);
  return text.trim();
}

/**
 * Whether a field the user typed in holds text a reload would lose. The
 * composers keep their drafts in the browser (`data-draft-saved`), and
 * fields the page filled in itself (settings) lose nothing either.
 */
function unsavedText(typed: WeakSet<Element>): boolean {
  return [
    ...document.querySelectorAll("input, textarea, [contenteditable]"),
  ].some((field) => {
    if (!typed.has(field) || field.closest("[data-draft-saved]")) return false;
    if (
      field instanceof HTMLInputElement ||
      field instanceof HTMLTextAreaElement
    ) {
      if (field.disabled || field.readOnly) return false;
      if (field instanceof HTMLInputElement && NOT_TEXT.test(field.type))
        return false;
      return field.value !== "";
    }
    return (
      field.getAttribute("contenteditable") !== "false" && !!editableText(field)
    );
  });
}

/** The field an event is about: the editor around its target. */
function fieldOf(target: EventTarget | null): Element | null {
  if (!target || typeof (target as Element).closest !== "function") return null;
  return (target as Element).closest(
    'input, textarea, [contenteditable]:not([contenteditable="false"])',
  );
}

type FreshnessOptions = {
  /** Calls back each time the bridge connects; returns an unsubscribe. */
  onConnected?: (callback: () => void) => () => void;
  /** The index page the server serves now. */
  fetchIndex?: () => Promise<string | null>;
  reload?: () => void;
  now?: () => number;
};

/**
 * Reloads the page when the server now serves another frontend build. Without
 * it an open page keeps running the old code against the new server after an
 * upgrade made outside this page (another browser, a package manager, a
 * development deploy that keeps the version). Checked when the bridge
 * reconnects (a restart drops it), when the page comes back to the
 * foreground (a phone reopening its installed app restores the page without
 * reloading it), every POLL_MS, and when something fails
 * (checkFrontendFreshness).
 *
 * The reload happens at once unless it would lose something (reloadHold):
 * it waits for sending and uploads to finish, and for a pause in typing. The composers' drafts are kept in the browser and come
 * back. An open dialog is closed by it once the user leaves the page alone
 * IDLE_RELOAD_MS or hides it. Text typed in a field that does not keep it
 * holds the reload until the field is emptied. A reload held back longer
 * than NOTICE_AFTER_MS (or for the user) shows a notice with a button to
 * reload now: a page never stays on an old build without saying so.
 */
export function startFrontendFreshness({
  onConnected = (callback) =>
    bridge.onStatus((status) => {
      if (status === "connected") callback();
    }),
  fetchIndex = fetchServedIndex,
  reload = () => window.location.reload(),
  now = () => Date.now(),
}: FreshnessOptions = {}): () => void {
  const running = entryScript(
    document.querySelector<HTMLScriptElement>(
      'script[type="module"][src*="/assets/index-"]',
    )?.src ?? "",
  );
  // A development server (Vite) has no hashed entry: nothing to compare.
  if (!running) return () => {};
  let checking = false;
  let staleSince: number | null = null;
  let reloading = false;
  let disposed = false;
  let retry: ReturnType<typeof setInterval> | undefined;
  let lastKey = Number.NEGATIVE_INFINITY;
  let lastActive = now();
  const typed = new WeakSet<Element>();

  const situation = (): ReloadSituation => ({
    sending: terminalComposerBusy(),
    unsaved: unsavedText(typed),
    typing: now() - lastKey < TYPING_QUIET_MS,
    dialog: !!document.querySelector('[role="dialog"], [role="alertdialog"]'),
  });

  const doReload = () => {
    clearInterval(retry);
    reloading = true;
    reload();
  };

  const reloadWhenFree = () => {
    if (disposed || reloading || staleSince === null) return;
    const hold = reloadHold(situation());
    if (!hold) {
      doReload();
      return;
    }
    const idle =
      document.visibilityState === "hidden" ||
      now() - lastActive >= IDLE_RELOAD_MS;
    if (hold.until === "idle" && idle) {
      doReload();
      return;
    }
    publish({
      stale: true,
      notice:
        hold.until !== "wait" || now() - staleSince >= NOTICE_AFTER_MS
          ? hold.reason
          : null,
    });
    retry ??= setInterval(reloadWhenFree, 1000);
  };

  const onKey = (event: Event) => {
    lastKey = now();
    lastActive = lastKey;
    const field = fieldOf(event.target);
    if (field) typed.add(field);
  };
  const onTyped = (event: Event) => {
    lastActive = now();
    const field = fieldOf(event.target);
    if (field) typed.add(field);
    if (staleSince !== null) setTimeout(reloadWhenFree, 0);
  };
  const onActive = () => {
    lastActive = now();
  };
  const onWritingEnds = () => {
    if (staleSince !== null) setTimeout(reloadWhenFree, 0);
  };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("input", onTyped, true);
  document.addEventListener("paste", onTyped, true);
  document.addEventListener("pointerdown", onActive, true);
  document.addEventListener("wheel", onActive, {
    capture: true,
    passive: true,
  });
  document.addEventListener("focusout", onWritingEnds, true);

  const check = async () => {
    if (disposed || checking || reloading) return;
    checking = true;
    try {
      const html = await fetchIndex();
      const served = html ? entryScript(html) : null;
      if (disposed) return;
      if (served && served !== running) {
        staleSince ??= now();
        reloadWhenFree();
      }
    } catch {
      // Unreachable for now: the next reconnect checks again.
    } finally {
      checking = false;
    }
  };
  const offConnected = onConnected(() => void check());
  const onVisible = () => {
    if (document.visibilityState === "visible") void check();
    // Hidden, nobody looks at a dialog any more.
    else if (staleSince !== null) reloadWhenFree();
  };
  document.addEventListener("visibilitychange", onVisible);
  const poll = setInterval(() => void check(), POLL_MS);
  reloadNow = () => {
    if (!disposed && !reloading) doReload();
  };
  checkNow = () => void check();
  return () => {
    disposed = true;
    clearInterval(retry);
    clearInterval(poll);
    reloadNow = null;
    checkNow = null;
    publish({ stale: false, notice: null });
    offConnected();
    document.removeEventListener("visibilitychange", onVisible);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("input", onTyped, true);
    document.removeEventListener("paste", onTyped, true);
    document.removeEventListener("pointerdown", onActive, true);
    document.removeEventListener("wheel", onActive, true);
    document.removeEventListener("focusout", onWritingEnds, true);
  };
}

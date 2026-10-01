import { prepareTerminalPasteText } from "./terminalPaste";

/**
 * Draft storage for the mobile terminal composer.
 *
 * Drafts live only in memory: terminal input can contain secrets, so they
 * must never reach localStorage. Keys are scoped by connection identity
 * (including the reconnect generation) and pane ID, so a reconnect or a pane
 * switch never mixes drafts or sends text to the wrong pane.
 */
const drafts = new Map<string, string>();
const selections = new Map<string, { start: number; end: number }>();
const retiredDraftKeys = new Set<string>();
let activeDraftScopePrefix: string | null = null;
type TerminalComposerDraftListener = (text: string) => void;
type TerminalComposerSubmissionListener = (pending: boolean) => void;
type TerminalComposerUploadListener = (count: number) => void;
const draftListeners = new Map<string, Set<TerminalComposerDraftListener>>();
const pendingSubmissions = new Set<string>();
const submissionListeners = new Map<
  string,
  Set<TerminalComposerSubmissionListener>
>();
const pendingUploads = new Map<string, number>();
const uploadListeners = new Map<string, Set<TerminalComposerUploadListener>>();

function notifyTerminalComposerDraft(key: string, text: string): void {
  for (const listener of draftListeners.get(key) ?? []) listener(text);
}

function notifyTerminalComposerSubmission(key: string, pending: boolean): void {
  for (const listener of submissionListeners.get(key) ?? []) listener(pending);
}

function notifyTerminalComposerUpload(key: string, count: number): void {
  for (const listener of uploadListeners.get(key) ?? []) listener(count);
}

function clearTerminalComposerUploads(key: string): void {
  if (!pendingUploads.delete(key)) return;
  notifyTerminalComposerUpload(key, 0);
}

function terminalComposerDraftScopePrefix(
  connectionId: string,
  connectionGeneration: number,
): string {
  return `${JSON.stringify([connectionId, connectionGeneration]).slice(0, -1)},`;
}

function terminalComposerDraftKeyIsActive(key: string): boolean {
  return (
    !retiredDraftKeys.has(key) &&
    (activeDraftScopePrefix === null || key.startsWith(activeDraftScopePrefix))
  );
}

export function terminalComposerDraftKey(
  connectionId: string,
  connectionGeneration: number,
  paneId: string,
): string {
  // Structured key: plain concatenation would let a digit-ending connection
  // ID collide across generations ("srv1"+2 vs "srv"+12).
  return JSON.stringify([connectionId, connectionGeneration, paneId]);
}

export function readTerminalComposerDraft(key: string): string {
  return drafts.get(key) ?? "";
}

export function readTerminalComposerSelection(
  key: string,
): { start: number; end: number } | null {
  return selections.get(key) ?? null;
}

/** Records the live textarea selection so async uploads use the latest mount. */
export function writeTerminalComposerSelection(
  key: string,
  selectionStart: number,
  selectionEnd: number,
): void {
  if (!terminalComposerDraftKeyIsActive(key)) return;
  const length = readTerminalComposerDraft(key).length;
  if (length === 0) {
    selections.delete(key);
    return;
  }
  const start = Math.max(0, Math.min(selectionStart, length));
  const end = Math.max(start, Math.min(selectionEnd, length));
  selections.set(key, { start, end });
}

export function writeTerminalComposerDraft(key: string, text: string): void {
  if (!text) {
    clearTerminalComposerDraft(key);
    return;
  }
  if (!terminalComposerDraftKeyIsActive(key)) return;
  if (drafts.get(key) === text) return;
  drafts.set(key, text);
  notifyTerminalComposerDraft(key, text);
}

export function clearTerminalComposerDraft(key: string): void {
  selections.delete(key);
  if (!drafts.delete(key)) return;
  notifyTerminalComposerDraft(key, "");
}

/** Keeps mounted composers synchronized with async updates to their draft. */
export function subscribeTerminalComposerDraft(
  key: string,
  listener: TerminalComposerDraftListener,
): () => void {
  const listeners = draftListeners.get(key) ?? new Set();
  listeners.add(listener);
  draftListeners.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) draftListeners.delete(key);
  };
}

export function terminalComposerSubmissionPending(key: string): boolean {
  return pendingSubmissions.has(key);
}

/** Starts at most one submission for a pane draft, even across remounts. */
export function beginTerminalComposerSubmission(key: string): boolean {
  if (!terminalComposerDraftKeyIsActive(key)) return false;
  if (pendingSubmissions.has(key)) return false;
  pendingSubmissions.add(key);
  notifyTerminalComposerSubmission(key, true);
  return true;
}

export function finishTerminalComposerSubmission(key: string): void {
  if (!pendingSubmissions.delete(key)) return;
  notifyTerminalComposerSubmission(key, false);
}

export function subscribeTerminalComposerSubmission(
  key: string,
  listener: TerminalComposerSubmissionListener,
): () => void {
  const listeners = submissionListeners.get(key) ?? new Set();
  listeners.add(listener);
  submissionListeners.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) submissionListeners.delete(key);
  };
}

export function terminalComposerUploadCount(key: string): number {
  return pendingUploads.get(key) ?? 0;
}

/** Tracks uploads across composer remounts for the same pane draft. */
export function beginTerminalComposerUpload(key: string): boolean {
  if (!terminalComposerDraftKeyIsActive(key)) return false;
  const count = terminalComposerUploadCount(key) + 1;
  pendingUploads.set(key, count);
  notifyTerminalComposerUpload(key, count);
  return true;
}

export function finishTerminalComposerUpload(key: string): void {
  const count = terminalComposerUploadCount(key);
  if (count <= 0) return;
  if (count === 1) {
    clearTerminalComposerUploads(key);
    return;
  }
  pendingUploads.set(key, count - 1);
  notifyTerminalComposerUpload(key, count - 1);
}

export function subscribeTerminalComposerUpload(
  key: string,
  listener: TerminalComposerUploadListener,
): () => void {
  const listeners = uploadListeners.get(key) ?? new Set();
  listeners.add(listener);
  uploadListeners.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) uploadListeners.delete(key);
  };
}

/**
 * Activates the app's single browser routing scope. Drafts and submissions
 * outside it are unreachable, and retired async work cannot write them back.
 */
export function activateTerminalComposerDraftScope(
  connectionId: string,
  connectionGeneration: number,
): void {
  activeDraftScopePrefix = terminalComposerDraftScopePrefix(
    connectionId,
    connectionGeneration,
  );
  for (const key of drafts.keys()) {
    if (!terminalComposerDraftKeyIsActive(key)) clearTerminalComposerDraft(key);
  }
  for (const key of selections.keys()) {
    if (!terminalComposerDraftKeyIsActive(key)) selections.delete(key);
  }
  for (const key of pendingSubmissions) {
    if (!terminalComposerDraftKeyIsActive(key)) {
      finishTerminalComposerSubmission(key);
    }
  }
  for (const key of pendingUploads.keys()) {
    if (!terminalComposerDraftKeyIsActive(key)) {
      clearTerminalComposerUploads(key);
    }
  }
}

/** Atomically inserts into the latest shared draft and advances its caret. */
export function insertIntoTerminalComposerDraft(
  key: string,
  insertion: string,
): { text: string; caret: number } {
  const current = readTerminalComposerDraft(key);
  if (!terminalComposerDraftKeyIsActive(key)) {
    return { text: current, caret: current.length };
  }
  const { start = current.length, end = start } =
    readTerminalComposerSelection(key) ?? {};
  const next = terminalComposerInsertAtCaret(current, start, end, insertion);
  // Publish the selection before the draft notification so a remounted
  // subscriber restores this caret when it renders the inserted path.
  selections.set(key, { start: next.caret, end: next.caret });
  writeTerminalComposerDraft(key, next.text);
  return next;
}

/** Test hook: number of retained drafts. */
export function terminalComposerDraftCount(): number {
  return drafts.size;
}

/**
 * Returns the subset of paneIds that currently hold a non-empty draft. Close
 * flows use this to warn before the draft becomes unreachable.
 */
export function terminalComposerDraftPaneIds(
  connectionId: string,
  connectionGeneration: number,
  paneIds: readonly string[],
): string[] {
  return paneIds.filter(
    (paneId) =>
      readTerminalComposerDraft(
        terminalComposerDraftKey(connectionId, connectionGeneration, paneId),
      ) !== "",
  );
}

/** Discards drafts and retires async work for panes confirmed closing. */
export function clearTerminalComposerDrafts(
  connectionId: string,
  connectionGeneration: number,
  paneIds: readonly string[],
): void {
  for (const paneId of paneIds) {
    const key = terminalComposerDraftKey(
      connectionId,
      connectionGeneration,
      paneId,
    );
    retiredDraftKeys.add(key);
    clearTerminalComposerDraft(key);
    finishTerminalComposerSubmission(key);
    clearTerminalComposerUploads(key);
  }
}

/**
 * Sentence appended to a close-confirmation message when the close would
 * discard composer drafts. Returns "" when there is nothing to warn about.
 */
export function terminalComposerCloseWarning(draftCount: number): string {
  if (draftCount <= 0) return "";
  return draftCount === 1
    ? " The unsent composer draft will be discarded."
    : ` ${draftCount} unsent composer drafts will be discarded.`;
}

/**
 * Builds the mode-aware pane input request for a composer submission. The
 * server wraps the text in bracketed-paste markers only when the PTY has
 * bracketed paste enabled, and encodes the Enter key for the active terminal
 * mode. `submit: false` inserts the draft without executing it.
 */
export function terminalComposerRequest(
  paneId: string,
  text: string,
  submit: boolean,
) {
  return {
    method: "pane.send_input" as const,
    params: {
      pane_id: paneId,
      text: prepareTerminalPasteText(text),
      keys: submit ? ["enter"] : ([] as string[]),
    },
  };
}

/**
 * Inserts an uploaded image path at the composer caret, replacing the current
 * selection. A single space is added before the path when it would otherwise
 * touch non-whitespace text, and always after it unless whitespace follows,
 * so the path stays a separate shell word and continued typing cannot merge
 * into it. Returns the next draft text and the caret position after it.
 */
export function terminalComposerInsertAtCaret(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  insertion: string,
): { text: string; caret: number } {
  const before = text.slice(0, selectionStart);
  const after = text.slice(selectionEnd);
  const needsLeadingSpace = before !== "" && !/\s$/.test(before);
  const needsTrailingSpace = !/^\s/.test(after);
  const inserted = `${needsLeadingSpace ? " " : ""}${insertion}${
    needsTrailingSpace ? " " : ""
  }`;
  return {
    text: `${before}${inserted}${after}`,
    caret: before.length + inserted.length,
  };
}

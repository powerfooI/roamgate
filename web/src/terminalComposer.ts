import type { ConnectionClient, ConnectionSummary } from "./api";
import {
  roamgateLocalStorage,
  roamgateSessionStorage,
  subscribeLocalStorage,
} from "./browserStorage";
import { prepareTerminalPasteText } from "./terminalPaste";
import type { Pane } from "./types";

/**
 * Draft storage for the mobile terminal composer.
 *
 * Live operations keep their connection generation guard. Saved text belongs
 * to the connection destination, pane and terminal instead, so reconnecting
 * can recover it without reviving requests from the old connection.
 * Session storage preserves independent tab edits; local storage supplies
 * the last saved draft when the app is reopened. Sending, discarding and
 * logging out clear saved text, which may contain sensitive terminal input.
 */
const drafts = new Map<string, string>();
const DRAFT_STORAGE_PREFIX = "terminalComposerDraft:v1:";
const DRAFT_LOGOUT_KEY = "terminalComposerLogout";
let draftLogoutEpoch = roamgateLocalStorage.getItem(DRAFT_LOGOUT_KEY) ?? "";
const draftStorageKeys = new Map<string, string>();
const savedDrafts = new Map<string, string>();
const lastLocalWrites = new Map<string, string>();
const selections = new Map<string, { start: number; end: number }>();
const retiredDraftKeys = new Set<string>();
const recoveredUploadKeys = new Set<string>();
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

function clearStoredDrafts(storage: Storage, keepEpoch?: string): void {
  const keepPrefix =
    keepEpoch === undefined
      ? null
      : `${DRAFT_STORAGE_PREFIX}${JSON.stringify([keepEpoch]).slice(0, -1)},`;
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (
        key?.startsWith(DRAFT_STORAGE_PREFIX) &&
        (keepPrefix === null || !key.startsWith(keepPrefix))
      )
        storage.setItem(key, "");
    }
  } catch {
    // Storage access can be denied; logout must still proceed.
  }
}

function retireDraft(key: string): void {
  retiredDraftKeys.add(key);
  const storageKey = draftStorageKeys.get(key);
  if (storageKey) saveDraft(storageKey, "", true);
  draftStorageKeys.delete(key);
  clearTerminalComposerDraft(key);
  finishTerminalComposerSubmission(key);
  clearTerminalComposerUploads(key);
}

function retireLiveDrafts(): void {
  const keys = new Set([
    ...draftStorageKeys.keys(),
    ...drafts.keys(),
    ...pendingSubmissions,
    ...pendingUploads.keys(),
  ]);
  for (const key of keys) retiredDraftKeys.add(key);
  savedDrafts.clear();
  lastLocalWrites.clear();
  draftStorageKeys.clear();
  for (const key of keys) retireDraft(key);
}

function synchronizeDraftLogout(): void {
  const epoch = roamgateLocalStorage.getItem(DRAFT_LOGOUT_KEY) ?? "";
  if (epoch === draftLogoutEpoch) return;
  draftLogoutEpoch = epoch;
  clearStoredDrafts(roamgateSessionStorage, epoch);
  retireLiveDrafts();
}

clearStoredDrafts(roamgateSessionStorage, draftLogoutEpoch);
subscribeLocalStorage((key) => {
  if (key === null || key === DRAFT_LOGOUT_KEY) synchronizeDraftLogout();
});

function saveDraft(storageKey: string, text: string, forceClear = false): void {
  const previous = savedDrafts.get(storageKey) ?? "";
  savedDrafts.set(storageKey, text);
  for (const storage of [roamgateSessionStorage, roamgateLocalStorage]) {
    try {
      // Clearing this tab must not erase a newer draft saved by another tab.
      if (
        storage === roamgateLocalStorage &&
        !text &&
        !forceClear &&
        (storage.getItem(storageKey) ?? "") !==
          (lastLocalWrites.get(storageKey) ?? previous)
      )
        continue;
      // Empty values prevent a cleared tab draft falling back to another tab.
      storage.setItem(storageKey, text);
      if (storage === roamgateLocalStorage)
        lastLocalWrites.set(storageKey, text);
    } catch {
      // Keep editing and reconnect recovery working if storage is unavailable.
    }
  }
}

function restoreDraft(storageKey: string): string {
  if (savedDrafts.has(storageKey)) return savedDrafts.get(storageKey)!;
  const text =
    roamgateSessionStorage.getItem(storageKey) ??
    roamgateLocalStorage.getItem(storageKey) ??
    "";
  savedDrafts.set(storageKey, text);
  try {
    roamgateSessionStorage.setItem(storageKey, text);
  } catch {
    // The in-memory copy still isolates this tab's edits.
  }
  return text;
}

/** Remove sensitive drafts from this browser when its login session ends. */
export function clearSavedTerminalComposerDrafts(): void {
  for (const storage of [roamgateLocalStorage, roamgateSessionStorage]) {
    clearStoredDrafts(storage);
  }
  try {
    // Rotate after clearing text so even a full store has room for the marker.
    roamgateLocalStorage.setItem(
      DRAFT_LOGOUT_KEY,
      `${Date.now()}-${Math.random()}`,
    );
  } catch {
    // Storage access can be denied; logout must still proceed.
  }
  draftLogoutEpoch = roamgateLocalStorage.getItem(DRAFT_LOGOUT_KEY) ?? "";
  retireLiveDrafts();
}

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

export function terminalComposerDraftKeyIsActive(key: string): boolean {
  synchronizeDraftLogout();
  return (
    !retiredDraftKeys.has(key) &&
    (activeDraftScopePrefix === null || key.startsWith(activeDraftScopePrefix))
  );
}

export function terminalComposerDraftKey(
  connectionId: string,
  connectionGeneration: number,
  paneId: string,
  terminalId?: string,
): string {
  // Structured key: plain concatenation would let a digit-ending connection
  // ID collide across generations ("srv1"+2 vs "srv"+12).
  return JSON.stringify([
    connectionId,
    connectionGeneration,
    paneId,
    ...(terminalId === undefined ? [] : [terminalId]),
  ]);
}

export function readTerminalComposerDraft(key: string): string {
  synchronizeDraftLogout();
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
  if (!terminalComposerDraftKeyIsActive(key)) return;
  if (!text) {
    clearTerminalComposerDraft(key);
    return;
  }
  const storageKey = draftStorageKeys.get(key);
  if (storageKey) saveDraft(storageKey, text);
  if (drafts.get(key) === text) return;
  drafts.set(key, text);
  notifyTerminalComposerDraft(key, text);
}

export function clearTerminalComposerDraft(key: string): void {
  synchronizeDraftLogout();
  const storageKey = draftStorageKeys.get(key);
  if (storageKey) saveDraft(storageKey, "");
  recoveredUploadKeys.delete(key);
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

/**
 * Sends `draft` from the shared pane draft under the composer submission
 * contract. At most one submission runs per draft key. The submitted prefix
 * leaves the draft before the request, so an unmount/remount cannot expose it
 * as a second send while the first is pending; text typed meanwhile stays in
 * the draft. On failure the submitted text is restored ahead of that newer
 * text and the error is rethrown. Returns false when another submission for
 * the key is already pending. `onBegin` runs once the submission is claimed.
 */
export async function submitTerminalComposerDraft(
  key: string,
  draft: string,
  send: (text: string) => Promise<void>,
  onBegin?: () => void,
): Promise<boolean> {
  if (!beginTerminalComposerSubmission(key)) return false;
  try {
    onBegin?.();
    const current = readTerminalComposerDraft(key);
    const next = current.startsWith(draft)
      ? current.slice(draft.length)
      : current;
    if (next) writeTerminalComposerDraft(key, next);
    else clearTerminalComposerDraft(key);
    try {
      await send(draft);
    } catch (error) {
      const pendingText = readTerminalComposerDraft(key);
      writeTerminalComposerDraft(key, `${draft}${pendingText}`);
      throw error;
    }
    return true;
  } finally {
    finishTerminalComposerSubmission(key);
  }
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
  panes?: readonly Pick<Pane, "pane_id" | "terminal_id">[],
  connection?: ConnectionSummary,
): void {
  synchronizeDraftLogout();
  activeDraftScopePrefix = terminalComposerDraftScopePrefix(
    connectionId,
    connectionGeneration,
  );
  if (connection?.id === connectionId && panes) {
    const destination = [
      draftLogoutEpoch,
      connectionId,
      connection.source,
      connection.type,
      connection.control_socket_path,
      connection.ssh_destination,
      connection.remote_control_socket_path,
      connection.remote_session,
    ];
    const storagePrefix = `${DRAFT_STORAGE_PREFIX}${JSON.stringify(destination).slice(0, -1)},`;
    const targets = new Map(
      panes.map((pane) => [
        terminalComposerDraftKey(
          connectionId,
          connectionGeneration,
          pane.pane_id,
          pane.terminal_id,
        ),
        DRAFT_STORAGE_PREFIX +
          JSON.stringify([...destination, pane.pane_id, pane.terminal_id]),
      ]),
    );
    const survivingStorageKeys = new Set(targets.values());
    for (const [key, storageKey] of draftStorageKeys) {
      if (
        storageKey.startsWith(storagePrefix) &&
        !survivingStorageKeys.has(storageKey)
      ) {
        retireDraft(key);
      }
    }
    // Reloaded tabs have saved drafts but no live mappings for removed panes.
    const storedKeys = new Set(savedDrafts.keys());
    for (const storage of [roamgateSessionStorage, roamgateLocalStorage]) {
      try {
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (key) storedKeys.add(key);
        }
      } catch {
        // Live draft retirement still works when storage access is denied.
      }
    }
    for (const storageKey of storedKeys) {
      if (
        storageKey.startsWith(storagePrefix) &&
        !survivingStorageKeys.has(storageKey)
      )
        saveDraft(storageKey, "", true);
    }
    for (const [key, storageKey] of targets) {
      if (retiredDraftKeys.has(key)) continue;
      const previousStorageKey = draftStorageKeys.get(key);
      if (previousStorageKey === storageKey) continue;
      if (!previousStorageKey && drafts.has(key)) {
        saveDraft(storageKey, drafts.get(key)!);
      }
      draftStorageKeys.set(key, storageKey);
      const text = restoreDraft(storageKey);
      if (text) drafts.set(key, text);
      else drafts.delete(key);
      notifyTerminalComposerDraft(key, text);
    }
  }
  for (const key of drafts.keys()) {
    if (
      !terminalComposerDraftKeyIsActive(key) &&
      !recoveredUploadKeys.has(key)
    ) {
      // Retire the live lease without deleting the recoverable text.
      drafts.delete(key);
      notifyTerminalComposerDraft(key, "");
    }
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

/** Recovery only: keep paths on the original target without sending them.
 * Reconnect callbacks append to saved text; closed/logged-out drafts stay gone.
 */
export function retainTerminalComposerUploadPaths(
  key: string,
  paths: string,
): void {
  const current = readTerminalComposerDraft(key);
  if (retiredDraftKeys.has(key)) return;
  const storageKey = draftStorageKeys.get(key);
  if (storageKey && !terminalComposerDraftKeyIsActive(key)) {
    const saved = restoreDraft(storageKey);
    // An old generation must not replace the new composer's selected text.
    const next = terminalComposerInsertAtCaret(
      saved,
      saved.length,
      saved.length,
      paths,
    );
    saveDraft(storageKey, next.text);
    for (const [target, targetStorageKey] of draftStorageKeys) {
      if (
        targetStorageKey === storageKey &&
        terminalComposerDraftKeyIsActive(target)
      ) {
        drafts.set(target, next.text);
        notifyTerminalComposerDraft(target, next.text);
      }
    }
    return;
  }
  recoveredUploadKeys.add(key);
  const selection = readTerminalComposerSelection(key);
  const next = terminalComposerInsertAtCaret(
    current,
    selection?.start ?? current.length,
    selection?.end ?? current.length,
    paths,
  );
  selections.set(key, { start: next.caret, end: next.caret });
  if (storageKey && terminalComposerDraftKeyIsActive(key)) {
    saveDraft(storageKey, next.text);
  }
  drafts.set(key, next.text);
  notifyTerminalComposerDraft(key, next.text);
}

/** Test hook: number of retained drafts. */
export function terminalComposerDraftCount(): number {
  return drafts.size;
}

function paneDraftKeys(
  connectionId: string,
  generation: number,
  paneId: string,
): string[] {
  const key = terminalComposerDraftKey(connectionId, generation, paneId);
  const prefix = `${key.slice(0, -1)},`;
  return [
    ...new Set([
      key,
      ...draftStorageKeys.keys(),
      ...drafts.keys(),
      ...pendingSubmissions,
      ...pendingUploads.keys(),
    ]),
  ].filter((candidate) => candidate === key || candidate.startsWith(prefix));
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
  return paneIds.filter((paneId) =>
    paneDraftKeys(connectionId, connectionGeneration, paneId).some(
      (key) => readTerminalComposerDraft(key) !== "",
    ),
  );
}

/** Discards drafts and retires async work for panes confirmed closing. */
export function clearTerminalComposerDrafts(
  connectionId: string,
  connectionGeneration: number,
  paneIds: readonly string[],
): void {
  for (const paneId of paneIds) {
    for (const key of paneDraftKeys(
      connectionId,
      connectionGeneration,
      paneId,
    )) {
      const storageKey = draftStorageKeys.get(key);
      if (storageKey) {
        for (const [candidate, candidateStorageKey] of draftStorageKeys) {
          if (candidateStorageKey === storageKey) retireDraft(candidate);
        }
      }
      retireDraft(key);
    }
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

/** Types composer text into a pane, optionally followed by Enter. */
export async function sendTerminalComposerText(
  client: Pick<ConnectionClient, "call">,
  paneId: string,
  text: string,
  submit: boolean,
): Promise<void> {
  const request = terminalComposerRequest(paneId, text, submit);
  await client.call(request.method, request.params);
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

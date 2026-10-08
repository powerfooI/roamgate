import { useEffect, useSyncExternalStore } from "react";
import {
  isAssistantSnapshot,
  isAssistantTaskDetail,
  isAssistantMentionCatalog,
  isAssistantMentions,
  type AssistantMention,
  type AssistantMentionCatalog,
  type AssistantSnapshot,
  type AssistantConfig,
  type AssistantWorkspaceCatalog,
  type AssistantWorkspaceRef,
  type AssistantTaskDetail,
} from "../../shared/assistant";
import { bridge, type ConnectionStatus } from "./api";
import { assistantChatSelection } from "./assistantModels";
import { adjustAssistantMentions } from "./assistantMentions";

type AssistantClientState = {
  snapshot: AssistantSnapshot | null;
  loading: boolean;
  error: string | null;
  connectionStatus: ConnectionStatus;
  supported: boolean;
  draft: string;
  draftMentions: AssistantMention[];
};

let state: AssistantClientState = {
  snapshot: null,
  loading: false,
  error: null,
  connectionStatus: bridge.status,
  supported: false,
  draft: "",
  draftMentions: [],
};
const listeners = new Set<() => void>();
let users = 0;
let disconnect: (() => void) | undefined;
let socketEpoch = 0;
let snapshotVersion = 0;
const retiredInstances = new Set<string>();
let submission: { key: string; requestId: string } | null = null;
let sending = false;
type AssistantDraft = { text: string; mentions: AssistantMention[] };
const drafts = new Map<string, AssistantDraft>();
const draftHistory = new Map<
  string,
  { entries: AssistantDraft[]; index: number }
>();

function publish(patch: Partial<AssistantClientState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function acceptSnapshot(value: unknown, requestVersion?: number) {
  if (!isAssistantSnapshot(value)) {
    throw new Error("Invalid Ranger state received from the bridge.");
  }
  const current = state.snapshot;
  if (retiredInstances.has(value.instance_id)) return;
  if (current?.instance_id === value.instance_id) {
    if (value.revision < current.revision) return;
  } else {
    // A delayed reply cannot replace a newer pushed bridge instance.
    if (requestVersion !== undefined && requestVersion !== snapshotVersion)
      return;
    if (current) retiredInstances.add(current.instance_id);
  }
  snapshotVersion++;
  let draft = state.draft;
  let draftMentions = state.draftMentions;
  if (current?.session_id && current.session_id !== value.session_id) {
    drafts.set(current.session_id, { text: draft, mentions: draftMentions });
    const saved = drafts.get(value.session_id ?? "");
    draft = saved?.text ?? "";
    draftMentions = saved?.mentions ?? [];
  }
  publish({
    snapshot: value,
    loading: false,
    error: null,
    draft,
    draftMentions,
  });
}

export function readAssistantState() {
  return state;
}

export function assistantActionExecuting(
  snapshot: AssistantSnapshot | null | undefined,
) {
  return !!snapshot?.messages.some((message) =>
    message.actions?.some((action) => action.status === "executing"),
  );
}

export function subscribeAssistant(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setAssistantDraft(
  draft: string,
  references?: AssistantMention[],
  inputType?: string,
  edit?: { start: number; end: number; inputType?: string },
) {
  const key = state.snapshot?.session_id ?? "";
  const previous = { text: state.draft, mentions: state.draftMentions };
  const history = draftHistory.get(key) ?? { entries: [previous], index: 0 };
  let mentions = references;
  if (
    !mentions &&
    (inputType === "historyUndo" || inputType === "historyRedo")
  ) {
    const direction = inputType === "historyUndo" ? -1 : 1;
    for (
      let index = history.index + direction;
      index >= 0 && index < history.entries.length;
      index += direction
    ) {
      if (history.entries[index]!.text !== draft) continue;
      mentions = history.entries[index]!.mentions;
      history.index = index;
      break;
    }
    mentions ??= [];
  }
  mentions ??= adjustAssistantMentions(
    state.draft,
    draft,
    state.draftMentions,
    edit,
  );
  if (!isAssistantMentions(mentions, draft))
    throw new Error("Invalid Ranger draft references.");
  const next = { text: draft, mentions };
  if (inputType !== "historyUndo" && inputType !== "historyRedo") {
    history.entries.splice(history.index + 1);
    // Picker insertion binds the text input it just emitted; native edits keep their own undo state.
    if (
      history.entries[history.index]?.text === draft &&
      references &&
      references.length > previous.mentions.length
    )
      history.entries[history.index] = next;
    else history.entries.push(next);
    // ponytail: undo beyond 100 snapshots unlinks refs; use editor transactions if deeper binding undo is needed.
    if (history.entries.length > 100) history.entries.shift();
    history.index = history.entries.length - 1;
  }
  draftHistory.set(key, history);
  drafts.set(key, next);
  publish({ draft, draftMentions: mentions });
}

export async function getAssistantMentions(
  scope: AssistantWorkspaceRef[],
): Promise<AssistantMentionCatalog> {
  if (state.connectionStatus !== "connected" || !state.supported)
    throw new Error(
      "Reconnect to the bridge before mentioning a workspace or agent.",
    );
  const epoch = socketEpoch;
  const value = await bridge.call("bridge.assistant.mentions", { scope });
  if (epoch !== socketEpoch)
    throw new Error("The bridge connection changed. Reopen the mention menu.");
  if (!isAssistantMentionCatalog(value))
    throw new Error(
      "This bridge could not load Ranger references. Update or reconnect and try again.",
    );
  return value;
}

export function parseAssistantContext(
  value: unknown,
): AssistantWorkspaceCatalog {
  const result = value as Partial<AssistantWorkspaceCatalog> | null;
  const connectionIdsValid = (ids: unknown) =>
    ids === undefined ||
    (Array.isArray(ids) &&
      ids.every((id) => typeof id === "string" && !!id) &&
      new Set(ids).size === ids.length);
  if (
    !Array.isArray(result?.workspaces) ||
    !result.workspaces.every(
      (workspace) =>
        workspace &&
        typeof workspace.connection_id === "string" &&
        !!workspace.connection_id &&
        typeof workspace.workspace_id === "string" &&
        !!workspace.workspace_id &&
        typeof workspace.label === "string" &&
        typeof workspace.connection_label === "string" &&
        Number.isSafeInteger(workspace.runtime_generation) &&
        workspace.runtime_generation >= 0,
    ) ||
    !connectionIdsValid(result.connection_ids) ||
    !connectionIdsValid(result.complete_connection_ids) ||
    (result.truncated !== undefined && typeof result.truncated !== "boolean") ||
    (result.connection_ids !== undefined &&
      (result.workspaces.some(
        (workspace) =>
          !result.connection_ids!.includes(workspace.connection_id),
      ) ||
        result.complete_connection_ids?.some(
          (id) => !result.connection_ids!.includes(id),
        ))) ||
    (result.errors !== undefined &&
      (!Array.isArray(result.errors) ||
        !result.errors.every((error) => typeof error === "string")))
  )
    throw new Error("Invalid Ranger workspace list received from the bridge.");
  return {
    workspaces: result.workspaces,
    errors: result.errors ?? [],
    ...(result.connection_ids ? { connection_ids: result.connection_ids } : {}),
    ...(result.complete_connection_ids
      ? { complete_connection_ids: result.complete_connection_ids }
      : {}),
    ...(result.truncated !== undefined ? { truncated: result.truncated } : {}),
  };
}

function sameWorkspace(
  left: AssistantWorkspaceRef,
  right: AssistantWorkspaceRef,
) {
  return (
    left.connection_id === right.connection_id &&
    left.workspace_id === right.workspace_id
  );
}

// An absent workspace is only deleted when its connection was fully listed,
// or when the authoritative connection inventory no longer contains its host.
export function pruneAssistantWorkspaceRefs(
  refs: AssistantWorkspaceRef[],
  context: AssistantWorkspaceCatalog,
) {
  return refs.filter((ref) => {
    if (
      context.connection_ids &&
      !context.connection_ids.includes(ref.connection_id)
    )
      return false;
    return (
      !context.complete_connection_ids?.includes(ref.connection_id) ||
      context.workspaces.some((workspace) => sameWorkspace(ref, workspace))
    );
  });
}

export function permittedAssistantWorkspaces<T extends AssistantWorkspaceRef>(
  config: AssistantConfig | undefined,
  available: T[],
): T[] {
  return available.filter(
    (workspace) =>
      (config?.approval_mode === "auto" && config.workspace_scope === "all") ||
      config?.allowed_workspaces.some((ref) => sameWorkspace(ref, workspace)),
  );
}

// Context refreshes may prune saved permissions while settings have local edits.
// Merge permission-only updates without resetting the model or draft selections.
export function reconcileAssistantConfig(
  draft: AssistantConfig | null,
  previous: AssistantConfig | undefined,
  saved: AssistantConfig,
): AssistantConfig {
  if (
    !draft ||
    !previous ||
    ["provider", "model", "thinking_level", "credential_source"].some(
      (key) =>
        previous[key as keyof AssistantConfig] !==
        saved[key as keyof AssistantConfig],
    )
  )
    return saved;
  return {
    ...draft,
    approval_mode: saved.approval_mode,
    workspace_scope: saved.workspace_scope,
    allowed_workspaces: [
      ...draft.allowed_workspaces.filter(
        (ref) =>
          !previous.allowed_workspaces.some((item) =>
            sameWorkspace(ref, item),
          ) ||
          saved.allowed_workspaces.some((item) => sameWorkspace(ref, item)),
      ),
      ...saved.allowed_workspaces.filter(
        (ref) =>
          !previous.allowed_workspaces.some((item) =>
            sameWorkspace(ref, item),
          ) &&
          !draft.allowed_workspaces.some((item) => sameWorkspace(ref, item)),
      ),
    ],
  };
}

export async function callAssistant(
  action: string,
  params: Record<string, unknown> = {},
) {
  if (state.connectionStatus !== "connected") {
    throw new Error("Reconnect to the bridge before using Ranger.");
  }
  if (!state.supported) {
    throw new Error("This bridge does not support Ranger. Update Roamgate.");
  }
  if (
    assistantActionExecuting(state.snapshot) &&
    action !== "get" &&
    action !== "stop" &&
    action !== "configure_approval" &&
    action !== "configure_chat" &&
    !action.startsWith("task.")
  ) {
    throw new Error("Wait for the current action to finish.");
  }
  if (
    (action === "action.confirm" || action === "action.cancel") &&
    state.snapshot?.running
  ) {
    throw new Error(
      "Wait for Ranger to finish before confirming or cancelling an action.",
    );
  }
  const epoch = socketEpoch;
  const version = snapshotVersion;
  try {
    const value: unknown = await bridge.call(
      `bridge.assistant.${action}`,
      params,
    );
    if (epoch === socketEpoch) acceptSnapshot(value, version);
    return value;
  } catch (error) {
    if (
      epoch === socketEpoch &&
      (action !== "get" || version === snapshotVersion)
    )
      publish({
        error: error instanceof Error ? error.message : String(error),
      });
    throw error;
  }
}

// Run transcripts are fetched separately from the small global snapshot.
export async function getAssistantTask(
  taskId: string,
  runId?: string,
): Promise<AssistantTaskDetail> {
  if (state.connectionStatus !== "connected" || !state.supported)
    throw new Error("Reconnect to the bridge before viewing Ranger tasks.");
  const epoch = socketEpoch;
  const value: unknown = await bridge.call("bridge.assistant.task.get", {
    task_id: taskId,
    ...(runId ? { run_id: runId } : {}),
  });
  if (epoch !== socketEpoch)
    throw new Error("The bridge connection changed. Reload the task.");
  if (
    !isAssistantTaskDetail(value) ||
    value.task.id !== taskId ||
    (runId && value.run?.id !== runId)
  )
    throw new Error("Invalid Ranger task received from the bridge.");
  return value;
}

export async function refreshAssistant() {
  if (state.connectionStatus !== "connected" || !state.supported) return;
  const epoch = socketEpoch;
  publish({ loading: true, error: null });
  try {
    await callAssistant("get");
  } finally {
    if (epoch === socketEpoch) publish({ loading: false });
  }
}

// The root button and panel share one subscription. Hiding the panel leaves
// the root subscribed, and reconnect only fetches state, never replays a send.
export function startAssistantClient() {
  users++;
  if (users === 1) {
    const offAssistant = bridge.onAssistant((snapshot) => {
      acceptSnapshot(snapshot);
    });
    const offStatus = bridge.onStatus((connectionStatus) => {
      socketEpoch++;
      publish({ connectionStatus, loading: false });
      if (connectionStatus === "connected") {
        const supported =
          bridge.hello?.capabilities?.embedded_assistant === true;
        publish({
          supported,
          ...(supported ? {} : { snapshot: null }),
        });
        void refreshAssistant().catch(() => {});
      }
    });
    disconnect = () => {
      offAssistant();
      offStatus();
    };
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (--users === 0) {
      socketEpoch++;
      disconnect?.();
      disconnect = undefined;
    }
  };
}

export function useAssistantState() {
  useEffect(startAssistantClient, []);
  return useSyncExternalStore(subscribeAssistant, readAssistantState);
}

export async function sendAssistant(
  text: string,
  scope: AssistantWorkspaceRef[],
  mentions: AssistantMention[] = [],
) {
  if (
    sending ||
    state.snapshot?.running ||
    assistantActionExecuting(state.snapshot)
  )
    return;
  if (!text.trim()) return;
  if (!scope.length) throw new Error("Choose a workspace to read first.");
  if (!isAssistantMentions(mentions, text))
    throw new Error(
      "A Ranger reference changed. Select it again before sending.",
    );
  const sessionId = state.snapshot?.session_id;
  const expected = state.snapshot?.chat_selection
    ? assistantChatSelection(state.snapshot)
    : undefined;
  const key = JSON.stringify([sessionId, text, scope, expected, mentions]);
  if (submission?.key !== key)
    submission = { key, requestId: crypto.randomUUID() };
  sending = true;
  try {
    await callAssistant("send", {
      text,
      scope,
      ...(mentions.length ? { mentions } : {}),
      request_id: submission.requestId,
      ...(expected ? { expected } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
    });
    submission = null;
    if (
      state.snapshot?.session_id === sessionId &&
      state.draft === text &&
      JSON.stringify(state.draftMentions) === JSON.stringify(mentions)
    ) {
      setAssistantDraft("", []);
      draftHistory.delete(sessionId ?? "");
    } else {
      const saved = drafts.get(sessionId ?? "");
      if (
        saved?.text === text &&
        JSON.stringify(saved.mentions) === JSON.stringify(mentions)
      ) {
        drafts.set(sessionId ?? "", { text: "", mentions: [] });
        draftHistory.delete(sessionId ?? "");
      }
    }
  } finally {
    sending = false;
  }
}

export function __resetAssistantForTests() {
  disconnect?.();
  disconnect = undefined;
  users = 0;
  socketEpoch++;
  snapshotVersion = 0;
  retiredInstances.clear();
  submission = null;
  sending = false;
  drafts.clear();
  draftHistory.clear();
  state = {
    snapshot: null,
    loading: false,
    error: null,
    connectionStatus: bridge.status,
    supported: false,
    draft: "",
    draftMentions: [],
  };
  for (const listener of listeners) listener();
}

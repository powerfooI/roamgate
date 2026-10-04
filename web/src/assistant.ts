import { useEffect, useSyncExternalStore } from "react";
import {
  isAssistantSnapshot,
  isAssistantTaskDetail,
  type AssistantSnapshot,
  type AssistantWorkspace,
  type AssistantWorkspaceRef,
  type AssistantTaskDetail,
} from "../../shared/assistant";
import { bridge, type ConnectionStatus } from "./api";

type AssistantClientState = {
  snapshot: AssistantSnapshot | null;
  loading: boolean;
  error: string | null;
  connectionStatus: ConnectionStatus;
  supported: boolean;
  draft: string;
};

let state: AssistantClientState = {
  snapshot: null,
  loading: false,
  error: null,
  connectionStatus: bridge.status,
  supported: false,
  draft: "",
};
const listeners = new Set<() => void>();
let users = 0;
let disconnect: (() => void) | undefined;
let socketEpoch = 0;
let snapshotVersion = 0;
const retiredInstances = new Set<string>();
let submission: { key: string; requestId: string } | null = null;
let sending = false;
const drafts = new Map<string, string>();

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
  if (current?.session_id && current.session_id !== value.session_id) {
    drafts.set(current.session_id, draft);
    draft = drafts.get(value.session_id ?? "") ?? "";
  }
  publish({ snapshot: value, loading: false, error: null, draft });
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

export function setAssistantDraft(draft: string) {
  drafts.set(state.snapshot?.session_id ?? "", draft);
  publish({ draft });
}

export function parseAssistantContext(value: unknown): {
  workspaces: AssistantWorkspace[];
  errors: string[];
} {
  const result = value as {
    workspaces?: AssistantWorkspace[];
    errors?: string[];
  } | null;
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
    (result.errors !== undefined &&
      (!Array.isArray(result.errors) ||
        !result.errors.every((error) => typeof error === "string")))
  )
    throw new Error("Invalid Ranger workspace list received from the bridge.");
  return { workspaces: result.workspaces, errors: result.errors ?? [] };
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
) {
  if (
    sending ||
    state.snapshot?.running ||
    assistantActionExecuting(state.snapshot)
  )
    return;
  if (!text.trim()) return;
  if (!scope.length) throw new Error("Choose a workspace to read first.");
  const sessionId = state.snapshot?.session_id;
  const key = JSON.stringify([sessionId, text, scope]);
  if (submission?.key !== key)
    submission = { key, requestId: crypto.randomUUID() };
  sending = true;
  try {
    await callAssistant("send", {
      text,
      scope,
      request_id: submission.requestId,
      ...(sessionId ? { session_id: sessionId } : {}),
    });
    submission = null;
    if (state.snapshot?.session_id === sessionId && state.draft === text)
      setAssistantDraft("");
    else if (drafts.get(sessionId ?? "") === text)
      drafts.set(sessionId ?? "", "");
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
  state = {
    snapshot: null,
    loading: false,
    error: null,
    connectionStatus: bridge.status,
    supported: false,
    draft: "",
  };
  for (const listener of listeners) listener();
}

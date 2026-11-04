import { useEffect, useSyncExternalStore } from "react";
import {
  activeAgentTaskCount,
  type AgentTask,
  type AgentTaskSession,
  type AgentTaskSnapshot,
} from "../../shared/agentTasks";
import type {
  JiraConfigUpdate,
  JiraConfigView,
  JiraIssue,
} from "../../shared/jira";
import { bridge, type ConnectionClient, type ConnectionStatus } from "./api";
import { parseAgentIntegrations } from "./agentIntegrations";
import { startAgentTask } from "./agentTaskStart";
import { roamgateLocalStorage } from "./browserStorage";
import {
  readJiraDock,
  withJiraDockSize,
  writeJiraDock,
  type JiraDockPreferences,
} from "./jiraDock";
import { store } from "./store";

// Jira and agent tasks are bridge-global: one subscription shared by the top
// bar, sidebar, panels and dialogs, refetched on reconnect, never replayed.

export type NewTaskRequest = { issue: JiraIssue | null; mode: "jira" | "blank" };

export type IssueTrackerState = {
  connectionStatus: ConnectionStatus;
  supported: boolean;
  jira: JiraConfigView | null;
  jiraError: string | null;
  tasks: AgentTask[];
  tasksRevision: number;
  tasksError: string | null;
  /** UI state shared across the shell. */
  jiraPanelOpen: boolean;
  jiraPanelExpanded: boolean;
  /** Right or bottom dock and its sizes, kept in this browser (AC29). */
  jiraDock: JiraDockPreferences;
  tasksPanelOpen: boolean;
  selectedTaskId: string | null;
  newTask: NewTaskRequest | null;
  jiraSettingsRequested: number;
};

let state: IssueTrackerState = {
  connectionStatus: "connecting",
  supported: false,
  jira: null,
  jiraError: null,
  tasks: [],
  tasksRevision: -1,
  tasksError: null,
  jiraPanelOpen: false,
  jiraPanelExpanded: false,
  jiraDock: readJiraDock(roamgateLocalStorage),
  tasksPanelOpen: true,
  selectedTaskId: null,
  newTask: null,
  jiraSettingsRequested: 0,
};
const listeners = new Set<() => void>();
let users = 0;
let socketEpoch = 0;
let disconnect: (() => void) | undefined;

function publish(patch: Partial<IssueTrackerState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function readIssueTrackerState() {
  return state;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Jira and Tasks UI shows only when Jira is on and panels are wanted (AC63). */
export function issuePanelsVisible(
  jira: Pick<JiraConfigView, "enabled" | "show_issue_panels"> | null,
): boolean {
  return !!jira && jira.enabled && jira.show_issue_panels;
}

/** The Jira panel needs a working sign-in too (AC28). */
export function jiraPanelAvailable(jira: JiraConfigView | null): boolean {
  return issuePanelsVisible(jira) && jira!.auth.state === "authenticated";
}

function acceptTasks(snapshot: AgentTaskSnapshot) {
  if (snapshot.revision < state.tasksRevision) return;
  publish({
    tasks: snapshot.tasks,
    tasksRevision: snapshot.revision,
    tasksError: null,
  });
}

export async function refreshJiraConfig() {
  const epoch = socketEpoch;
  try {
    const jira = (await bridge.call("bridge.jira.config.get")) as JiraConfigView;
    if (epoch === socketEpoch) publish({ jira, jiraError: null });
  } catch (error) {
    if (epoch === socketEpoch)
      publish({ jiraError: (error as Error).message });
  }
}

export async function refreshAgentTasks() {
  const epoch = socketEpoch;
  try {
    const snapshot = (await bridge.call(
      "bridge.tasks.list",
    )) as AgentTaskSnapshot;
    if (epoch === socketEpoch) acceptTasks(snapshot);
  } catch (error) {
    if (epoch === socketEpoch)
      publish({ tasksError: (error as Error).message });
  }
}

export function startIssueTrackerClient() {
  users++;
  if (users === 1) {
    const offTasks = bridge.onAgentTasks(acceptTasks);
    const offStatus = bridge.onStatus((connectionStatus) => {
      socketEpoch++;
      publish({ connectionStatus });
      if (connectionStatus !== "connected") return;
      const capabilities = bridge.hello?.capabilities ?? {};
      const supported = capabilities.jira_integration === true;
      // A new socket may reach a restarted bridge with lower revisions.
      publish({ supported, tasksRevision: -1 });
      if (!supported) return;
      void refreshJiraConfig();
      if (capabilities.agent_tasks === true) void refreshAgentTasks();
    });
    disconnect = () => {
      offTasks();
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

export function useIssueTrackers() {
  useEffect(startIssueTrackerClient, []);
  return useSyncExternalStore(subscribe, readIssueTrackerState);
}

export async function updateJiraConfig(
  update: JiraConfigUpdate,
): Promise<JiraConfigView> {
  const jira = (await bridge.call(
    "bridge.jira.config.update",
    update as Record<string, unknown>,
  )) as JiraConfigView;
  publish({ jira, jiraError: null });
  return jira;
}

export async function callJira<T>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const result = (await bridge.call(`bridge.jira.${method}`, params)) as T;
  if (
    method === "test" ||
    method === "config.remove" ||
    method === "config.get"
  )
    publish({ jira: result as JiraConfigView, jiraError: null });
  return result;
}

export async function callTasks<T = AgentTask>(
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  return (await bridge.call(`bridge.tasks.${method}`, params)) as T;
}

export function activeTaskBadge(tasks: readonly AgentTask[]): number {
  return activeAgentTaskCount(tasks);
}

// UI actions shared across components.
export function setJiraPanelOpen(open: boolean) {
  publish({ jiraPanelOpen: open, ...(open ? {} : { jiraPanelExpanded: false }) });
}
export function toggleJiraPanel() {
  setJiraPanelOpen(!state.jiraPanelOpen);
}
export function setJiraPanelExpanded(expanded: boolean) {
  publish({ jiraPanelExpanded: expanded, jiraPanelOpen: true });
}
export function setJiraDock(dock: JiraDockPreferences["dock"]) {
  const jiraDock = { ...state.jiraDock, dock };
  writeJiraDock(roamgateLocalStorage, jiraDock);
  publish({ jiraDock });
}
/** Live resize; pass `persist` once the drag or key press ends. */
export function setJiraDockSize(size: number, persist = false) {
  const jiraDock = withJiraDockSize(state.jiraDock, size);
  if (persist) writeJiraDock(roamgateLocalStorage, jiraDock);
  publish({ jiraDock });
}
export function toggleTasksPanel() {
  publish({ tasksPanelOpen: !state.tasksPanelOpen });
}
export function openNewTask(request: NewTaskRequest) {
  publish({ newTask: request });
}
export function closeNewTask() {
  publish({ newTask: null });
}
/** Selects a task and shows the Tasks panel (AC41). */
export function revealTask(id: string) {
  publish({ selectedTaskId: id, tasksPanelOpen: true });
}
export function selectTask(id: string | null) {
  publish({ selectedTaskId: id });
}
/** Asks the shell to open Configuration › Integrations › Jira (AC42). */
export function requestJiraSettings() {
  publish({ jiraSettingsRequested: state.jiraSettingsRequested + 1 });
}

const startingTasks = new Set<string>();

/**
 * Starts a draft or queued task in the active connection (AC58). A failure
 * leaves it queued with the error on its row and in a toast (AC59).
 */
export async function runAgentTask(
  task: AgentTask,
  client: ConnectionClient,
): Promise<boolean> {
  if (startingTasks.has(task.id)) return false;
  startingTasks.add(task.id);
  let linked = false;
  const link = async (session: AgentTaskSession) => {
    await callTasks("link_session", {
      id: task.id,
      connection_id: client.connectionId,
      workspace_id: task.workspace_id,
      agent: task.agent,
      session,
    });
    linked = true;
  };
  try {
    if (!task.workspace_id || !task.agent)
      throw new Error("Choose a workspace and an agent before starting.");
    if (task.connection_id && task.connection_id !== client.connectionId)
      throw new Error(
        "This task belongs to another server. Switch to it to start the task.",
      );
    const integrations = parseAgentIntegrations(
      await client.call("integration.list"),
    );
    const integration = integrations.find((item) => item.target === task.agent);
    await startAgentTask(
      { client, createTab: (workspaceId) => store.createTab(workspaceId), link },
      {
        workspaceId: task.workspace_id,
        agent: task.agent,
        agentCommand: integration?.command ?? task.agent,
        prompt: task.prompt,
      },
    );
    return true;
  } catch (error) {
    const message = (error as Error).message || "The agent did not start.";
    // Once linked the task is running with its tab: never re-queue it, so a
    // later Start can't open a second session and send the prompt again.
    if (!linked)
      await callTasks("set_status", {
        id: task.id,
        status: "queued",
        error: message,
      }).catch(() => undefined);
    store.notify({ kind: "error", message: "Task could not start", detail: message });
    return false;
  } finally {
    startingTasks.delete(task.id);
  }
}

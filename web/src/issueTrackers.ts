import { useEffect, useSyncExternalStore } from "react";
import {
  activeAgentTaskCount,
  type AgentTask,
  type AgentTaskSnapshot,
} from "../../shared/agentTasks";
import type {
  JiraConfigUpdate,
  JiraConfigView,
  JiraIssue,
} from "../../shared/jira";
import { bridge, type ConnectionStatus } from "./api";

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

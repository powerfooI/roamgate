import { roamgateLocalStorage, subscribeLocalStorage } from "../browserStorage";
import type { PullRequestSummary } from "../../../shared/pullRequest";
import { useWorkspacePullRequests } from "../useWorktreePullRequests";
import { shallowEqual, store, useStoreSelector } from "../store";
import type { GitStatusSummary, Pane, Tab, Workspace } from "../types";
import type { ConnectionSummary } from "../api";
import { connectionLifecycleLabel } from "../connectionProfiles";
import { shortId } from "../utils";
import {
  terminalComposerCloseWarning,
  terminalComposerDraftPaneIds,
} from "../terminalComposer";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ContextMenuState } from "./ContextMenu";
import { ThemedSelect } from "./ThemedSelect";
import { buildWorkspaceHierarchy, worktreeCreationSource } from "../worktree";
import {
  ArrowDownWideNarrow,
  ChevronDown,
  ChevronRight,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Layers,
  Pin,
  Plus,
} from "lucide-react";
import { WorktreeLifecycleDialog } from "./WorktreeLifecycleDialog";
import {
  WORKSPACE_PINS_STORAGE_KEY,
  isWorkspacePinned,
  parseWorkspacePins,
  serializeWorkspacePins,
  setWorkspacePinned,
} from "../workspacePins";
import {
  COLLAPSED_WORKTREE_GROUPS_STORAGE_KEY,
  isWorktreeGroupCollapsed,
  parseCollapsedWorktreeGroups,
  serializeCollapsedWorktreeGroups,
  setWorktreeGroupCollapsed,
} from "../workspaceTreeCollapse";
import {
  showWorkspaceBranchBadge,
  workspaceDisplayName,
  workspacePullRequest,
} from "../workspaceTreeBadges";
import { pruneClosedWorkspacePreferenceKeys } from "../workspacePreferences";
import { connectionStorageKey } from "../connectionStorage";
import {
  AGENT_ORDER_STORAGE_KEY,
  moveAgentPane,
  sortAgentPanes,
  groupOrderedAgentPanes,
  AGENT_LIST_PREFERENCES_STORAGE_KEY,
  parseAgentListPreferences,
  type AgentSort,
  type AgentGrouping,
  parseAgentOrder,
  serializeAgentOrder,
} from "../agentOrder";
import {
  AGENT_LIST_SCOPE_STORAGE_KEY,
  WORKSPACE_AGENT_LAYOUT_STORAGE_KEY,
  type WorkspaceAgentLayout,
  parseWorkspaceAgentLayout,
} from "../workspaceAgentLayout";
import {
  type ServerAgentPane,
  type ServerSessionSource,
  type ConnectionAgentSessions,
  openServerSession,
  useAllServerAgentSessions,
} from "../useAllServerAgentSessions";
import { useConnectionClient } from "../useConnectionClient";
import { activePaneIdForSnapshot } from "../paneJump";
import { ConfirmDialog } from "./ModalDialogs";
import {
  AgentContextMenu,
  type AgentMenuState,
  AgentRow,
  nestedAgentPaneIds,
} from "./WorkspaceAgentRows";
import {
  exportSessionForConnection,
  groupAgentPanesByWorkspace,
  paneHasAgentHistory,
} from "./agentSession";
import {
  focusTreeItem,
  keyboardContextMenuPoint,
  treeKeyboardAction,
  workspaceTreeItemIsTabStop,
} from "./treeKeyboard";
import { TREE_DEPTH_INDENT } from "./treeIndent";
import "./WorkspaceTree.css";
import "./WorkspaceAutoSyncDialog.css";

const LONG_PRESS_MS = 550;
const LONG_PRESS_MOVE_PX = 10;
const EMPTY_AGENT_PANES_BY_WORKSPACE = new Map<string, Pane[]>();
const ContextMenu = lazy(() =>
  import("./ContextMenu").then((module) => ({ default: module.ContextMenu })),
);

function stringArraysEqual(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function gitChangedCount(status: GitStatusSummary) {
  return status.staged + status.unstaged + status.untracked + status.conflicted;
}

function gitStatusTitle(status?: GitStatusSummary) {
  if (!status) return "";
  if (status.error) return `git status unavailable: ${status.error}`;
  const parts = [
    status.branch ? `branch: ${status.branch}` : null,
    status.upstream ? `upstream: ${status.upstream}` : null,
    status.ahead ? `ahead: ${status.ahead}` : null,
    status.behind ? `behind: ${status.behind}` : null,
    status.staged ? `staged: ${status.staged}` : null,
    status.unstaged ? `unstaged: ${status.unstaged}` : null,
    status.untracked ? `untracked: ${status.untracked}` : null,
    status.conflicted ? `conflicted: ${status.conflicted}` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

function AgentLayoutControl({
  value,
  onChange,
}: {
  value: WorkspaceAgentLayout;
  onChange: (value: WorkspaceAgentLayout) => void;
}) {
  return (
    <div className="workspace-agent-layout-control">
      <span>Agents</span>
      <div role="group" aria-label="Agent list layout">
        <button
          type="button"
          className={value === "compact" ? "is-active" : ""}
          aria-pressed={value === "compact"}
          onClick={() => onChange("compact")}
        >
          Compact
        </button>
        <button
          type="button"
          className={value === "nested" ? "is-active" : ""}
          aria-pressed={value === "nested"}
          onClick={() => onChange("nested")}
        >
          Nested
        </button>
        <button
          type="button"
          className={value === "separate" ? "is-active" : ""}
          aria-pressed={value === "separate"}
          onClick={() => onChange("separate")}
        >
          Separate
        </button>
      </div>
    </div>
  );
}

function GitStatusBadges({
  status,
  showBranch = true,
}: {
  status?: GitStatusSummary;
  showBranch?: boolean;
}) {
  if (!status) return null;
  if (status.error) {
    return (
      <span
        className="git-badge git-badge-error"
        title={gitStatusTitle(status)}
      >
        git?
      </span>
    );
  }

  const changed = gitChangedCount(status);
  const branch = status.branch || "git";
  const hasVisibleBadge =
    showBranch || changed > 0 || status.ahead > 0 || status.behind > 0;
  if (!hasVisibleBadge) return null;
  return (
    <span className="git-status" title={gitStatusTitle(status)}>
      {showBranch ? (
        <span className="git-badge git-branch">{branch}</span>
      ) : null}
      {changed > 0 ? (
        <span className="git-badge git-dirty">Δ{changed}</span>
      ) : null}
      {status.ahead > 0 ? (
        <span className="git-badge git-ahead">↑{status.ahead}</span>
      ) : null}
      {status.behind > 0 ? (
        <span className="git-badge git-behind">↓{status.behind}</span>
      ) : null}
    </span>
  );
}

function PullRequestBadge({
  review,
}: {
  review: NonNullable<ReturnType<typeof workspacePullRequest>>;
}) {
  const Icon = {
    open: GitPullRequest,
    draft: GitPullRequestDraft,
    merged: GitMerge,
    closed: GitPullRequestClosed,
  }[review.state];
  return (
    <span
      className="git-badge workspace-review"
      data-state={review.state}
      data-stale={review.stale || undefined}
      title={review.title}
      aria-label={review.title}
      role="img"
    >
      <Icon size={12} aria-hidden="true" />
      {review.id}
    </span>
  );
}

export function WorkspaceTree({
  agentsFirst = false,
  onCreateWorkspace,
  onSelect,
  onBrowseFiles,
  onReviewChanges,
  onSelectAgent,
  onBrowseFilesForAgent,
  onReviewChangesForAgent,
  onViewAgentHistory,
}: {
  agentsFirst?: boolean;
  onCreateWorkspace: (allServers: boolean) => void;
  onSelect?: (workspace: Workspace) => void;
  onBrowseFiles?: (workspace: Workspace) => void;
  onReviewChanges?: (workspace: Workspace) => void;
  onSelectAgent?: (pane: Pane) => void;
  onBrowseFilesForAgent?: (pane: Pane) => void;
  onReviewChangesForAgent?: (pane: Pane) => void;
  onViewAgentHistory?: (pane: Pane) => void;
}) {
  const s = useStoreSelector(
    (state) => ({
      activeConnectionId: state.activeConnectionId,
      connectionGeneration: state.connectionGeneration,
      serverRuntimeGeneration: state.serverRuntimeGeneration,
      connections: state.connections,
      lastRefresh: state.lastRefresh,
      layout: state.layout,
      panes: state.panes,
      selectedPaneId: state.selectedPaneId,
      status: state.status,
      tabs: state.tabs,
      workspaces: state.workspaces,
    }),
    shallowEqual,
  );
  const connectionClient = useConnectionClient();
  const connectedServerCount = s.connections.filter(
    (connection) => connection.state === "ready",
  ).length;
  const reviews = useWorkspacePullRequests(connectionClient, s.workspaces);
  const agentOrderStorageKey = connectionStorageKey(
    s.activeConnectionId,
    AGENT_ORDER_STORAGE_KEY,
  );
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [menuMounted, setMenuMounted] = useState(false);
  const [agentMenu, setAgentMenu] = useState<AgentMenuState | null>(null);
  const [pendingClosePane, setPendingClosePane] = useState<Pane | null>(null);
  const [draggedWorkspaceId, setDraggedWorkspaceId] = useState<string | null>(
    null,
  );
  const [workspaceDropTarget, setWorkspaceDropTarget] = useState<{
    workspaceId: string;
    position: "before" | "after";
  } | null>(null);
  const [draggedAgentPaneId, setDraggedAgentPaneId] = useState<string | null>(
    null,
  );
  const [agentDropTarget, setAgentDropTarget] = useState<{
    paneId: string;
    position: "before" | "after";
  } | null>(null);
  const [agentListPreferences, setAgentListPreferences] = useState(() =>
    parseAgentListPreferences(
      roamgateLocalStorage.getItem(AGENT_LIST_PREFERENCES_STORAGE_KEY),
    ),
  );
  const [collapsedAgentGroups, setCollapsedAgentGroups] = useState<Set<string>>(
    new Set(),
  );
  const manualAgentOrder =
    agentListPreferences.sort === "manual" &&
    agentListPreferences.grouping === "none";
  const [agentPaneOrder, setAgentPaneOrder] = useState<string[]>(() =>
    parseAgentOrder(roamgateLocalStorage.getItem(agentOrderStorageKey)),
  );
  const [agentLayout, setAgentLayout] = useState<WorkspaceAgentLayout>(() =>
    parseWorkspaceAgentLayout(
      roamgateLocalStorage.getItem(WORKSPACE_AGENT_LAYOUT_STORAGE_KEY),
    ),
  );
  const [allServers, setAllServers] = useState(
    () => roamgateLocalStorage.getItem(AGENT_LIST_SCOPE_STORAGE_KEY) === "all",
  );
  const allServerSessions = useAllServerAgentSessions(allServers);
  const agentSort =
    allServers && agentListPreferences.sort === "manual"
      ? "workspace"
      : agentListPreferences.sort;
  const [lifecycleWorkspaceId, setLifecycleWorkspaceId] = useState<
    string | null
  >(null);
  const lastPrunedWorkspaceRefresh = useRef(0);
  const pinsStorageKey = connectionStorageKey(
    s.activeConnectionId,
    WORKSPACE_PINS_STORAGE_KEY,
  );
  const collapsedGroupsStorageKey = connectionStorageKey(
    s.activeConnectionId,
    COLLAPSED_WORKTREE_GROUPS_STORAGE_KEY,
  );
  const [pinnedWorkspaceKeys, setPinnedWorkspaceKeys] = useState<string[]>(() =>
    parseWorkspacePins(roamgateLocalStorage.getItem(pinsStorageKey)),
  );
  const [collapsedWorktreeGroupKeys, setCollapsedWorktreeGroupKeys] = useState<
    string[]
  >(() =>
    parseCollapsedWorktreeGroups(
      roamgateLocalStorage.getItem(collapsedGroupsStorageKey),
    ),
  );
  const pinnedWorkspaceSet = new Set(pinnedWorkspaceKeys);
  const collapsedWorktreeGroupSet = new Set(collapsedWorktreeGroupKeys);
  const activePaneId = activePaneIdForSnapshot(s) ?? null;
  const agentsByWorkspace = useMemo(
    () => groupAgentPanesByWorkspace(s.panes),
    [s.panes],
  );
  const tabCountsByWorkspace = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tab of s.tabs) {
      counts.set(tab.workspace_id, (counts.get(tab.workspace_id) ?? 0) + 1);
    }
    return counts;
  }, [s.tabs]);
  const defaultAgentPanes = useMemo(() => {
    const workspaceNumbers = new Map(
      s.workspaces.map((workspace) => [
        workspace.workspace_id,
        workspace.number,
      ]),
    );
    return s.panes.filter(paneHasAgentHistory).sort((left, right) => {
      const workspaceOrder =
        (workspaceNumbers.get(left.workspace_id) ?? 0) -
        (workspaceNumbers.get(right.workspace_id) ?? 0);
      return workspaceOrder || left.pane_id.localeCompare(right.pane_id);
    });
  }, [s.panes, s.workspaces]);
  const agentPanes = useMemo(
    () =>
      sortAgentPanes(
        defaultAgentPanes,
        agentPaneOrder,
        agentListPreferences.sort,
      ),
    [agentPaneOrder, defaultAgentPanes, agentListPreferences.sort],
  );

  const listedAgentPanes: (Pane | ServerAgentPane)[] = allServers
    ? sortAgentPanes(allServerSessions.panes, [], agentSort)
    : agentPanes;
  const agentGroups = groupOrderedAgentPanes(
    listedAgentPanes,
    agentListPreferences.grouping,
    new Map(
      allServers
        ? allServerSessions.panes.map((pane) => [
            pane.workspaceKey,
            `${pane.serverLabel} / ${pane.workspaceLabel}`,
          ])
        : s.workspaces.map((workspace) => [
            workspace.workspace_id,
            workspaceDisplayName(workspace),
          ]),
    ),
  );
  useEffect(() => {
    roamgateLocalStorage.setItem(
      AGENT_LIST_PREFERENCES_STORAGE_KEY,
      JSON.stringify(agentListPreferences),
    );
  }, [agentListPreferences]);

  useEffect(() => {
    if (menu) setMenuMounted(true);
  }, [menu]);
  useEffect(() => {
    setMenu(null);
    setAgentMenu(null);
    setPendingClosePane(null);
    setDraggedWorkspaceId(null);
    setWorkspaceDropTarget(null);
    setDraggedAgentPaneId(null);
    setAgentDropTarget(null);
  }, [connectionClient]);
  useEffect(() => {
    roamgateLocalStorage.setItem(
      WORKSPACE_AGENT_LAYOUT_STORAGE_KEY,
      agentLayout,
    );
  }, [agentLayout]);
  useEffect(() => {
    roamgateLocalStorage.setItem(
      AGENT_LIST_SCOPE_STORAGE_KEY,
      allServers ? "all" : "current",
    );
  }, [allServers]);
  useEffect(() => {
    roamgateLocalStorage.setItem(
      agentOrderStorageKey,
      serializeAgentOrder(agentPaneOrder),
    );
  }, [agentOrderStorageKey, agentPaneOrder]);
  useEffect(() => {
    roamgateLocalStorage.setItem(
      pinsStorageKey,
      serializeWorkspacePins(pinnedWorkspaceKeys),
    );
  }, [pinnedWorkspaceKeys, pinsStorageKey]);
  useEffect(() => {
    roamgateLocalStorage.setItem(
      collapsedGroupsStorageKey,
      serializeCollapsedWorktreeGroups(collapsedWorktreeGroupKeys),
    );
  }, [collapsedGroupsStorageKey, collapsedWorktreeGroupKeys]);
  useEffect(() => {
    if (
      s.status !== "connected" ||
      s.lastRefresh === 0 ||
      s.lastRefresh <= lastPrunedWorkspaceRefresh.current
    ) {
      return;
    }
    lastPrunedWorkspaceRefresh.current = s.lastRefresh;
    setPinnedWorkspaceKeys((current) => {
      const next = pruneClosedWorkspacePreferenceKeys(current, s.workspaces);
      return stringArraysEqual(current, next) ? current : next;
    });
    setCollapsedWorktreeGroupKeys((current) => {
      const next = pruneClosedWorkspacePreferenceKeys(current, s.workspaces);
      return stringArraysEqual(current, next) ? current : next;
    });
  }, [s.lastRefresh, s.status, s.workspaces]);
  useEffect(() => {
    return subscribeLocalStorage((key) => {
      if (key === pinsStorageKey || key === null) {
        setPinnedWorkspaceKeys(
          parseWorkspacePins(roamgateLocalStorage.getItem(pinsStorageKey)),
        );
      }
      if (key === collapsedGroupsStorageKey || key === null) {
        setCollapsedWorktreeGroupKeys(
          parseCollapsedWorktreeGroups(
            roamgateLocalStorage.getItem(collapsedGroupsStorageKey),
          ),
        );
      }
      if (key === WORKSPACE_AGENT_LAYOUT_STORAGE_KEY || key === null) {
        setAgentLayout(
          parseWorkspaceAgentLayout(
            roamgateLocalStorage.getItem(WORKSPACE_AGENT_LAYOUT_STORAGE_KEY),
          ),
        );
      }
      if (key === AGENT_LIST_PREFERENCES_STORAGE_KEY || key === null) {
        setAgentListPreferences(
          parseAgentListPreferences(
            roamgateLocalStorage.getItem(AGENT_LIST_PREFERENCES_STORAGE_KEY),
          ),
        );
      }
      if (key === AGENT_LIST_SCOPE_STORAGE_KEY || key === null) {
        setAllServers(
          roamgateLocalStorage.getItem(AGENT_LIST_SCOPE_STORAGE_KEY) === "all",
        );
      }
      if (key === agentOrderStorageKey || key === null) {
        setAgentPaneOrder(
          parseAgentOrder(roamgateLocalStorage.getItem(agentOrderStorageKey)),
        );
      }
    });
  }, [agentOrderStorageKey, collapsedGroupsStorageKey, pinsStorageKey]);

  const updatePinnedWorkspace = (workspace: Workspace, pinned: boolean) => {
    setPinnedWorkspaceKeys((current) =>
      setWorkspacePinned(current, workspace, pinned),
    );
    if (!pinned && workspace.worktree?.is_linked_worktree) {
      const parent = worktreeCreationSource(s.workspaces, workspace);
      if (parent) {
        setCollapsedWorktreeGroupKeys((current) =>
          setWorktreeGroupCollapsed(current, parent, false),
        );
      }
    }
  };
  const updateCollapsedWorktreeGroup = (
    workspace: Workspace,
    collapsed: boolean,
  ) => {
    setCollapsedWorktreeGroupKeys((current) =>
      setWorktreeGroupCollapsed(current, workspace, collapsed),
    );
  };

  const clearWorkspaceDrag = () => {
    setDraggedWorkspaceId(null);
    setWorkspaceDropTarget(null);
  };
  const clearAgentDrag = () => {
    setDraggedAgentPaneId(null);
    setAgentDropTarget(null);
  };
  const workspaceDropPosition = (e: React.DragEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientY < rect.top + rect.height / 2 ? "before" : "after";
  };
  const onWorkspaceDragStart = (
    workspace: Workspace,
    e: React.DragEvent<HTMLDivElement>,
  ) => {
    clearAgentDrag();
    setDraggedWorkspaceId(workspace.workspace_id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", workspace.workspace_id);
  };
  const onWorkspaceDragOver = (
    workspace: Workspace,
    e: React.DragEvent<HTMLDivElement>,
  ) => {
    if (!draggedWorkspaceId || draggedWorkspaceId === workspace.workspace_id) {
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const position = workspaceDropPosition(e);
    setWorkspaceDropTarget((current) =>
      current?.workspaceId === workspace.workspace_id &&
      current.position === position
        ? current
        : { workspaceId: workspace.workspace_id, position },
    );
  };
  const onWorkspaceDrop = (
    workspace: Workspace,
    e: React.DragEvent<HTMLDivElement>,
  ) => {
    e.preventDefault();
    const draggedId = draggedWorkspaceId;
    const position = workspaceDropPosition(e);
    clearWorkspaceDrag();
    if (!draggedId || draggedId === workspace.workspace_id) return;
    const orderedIds = [...s.workspaces]
      .sort((a, b) => a.number - b.number)
      .map((candidate) => candidate.workspace_id);
    const from = orderedIds.indexOf(draggedId);
    const to = orderedIds.indexOf(workspace.workspace_id);
    if (from < 0 || to < 0) return;
    // workspace.move inserts before the entry currently at insert_index, so
    // an insertion point past the dragged row lands one slot earlier.
    const insertIndex = position === "before" ? to : to + 1;
    if (from < insertIndex ? insertIndex - 1 === from : insertIndex === from) {
      return;
    }
    void store.moveWorkspace(draggedId, insertIndex);
  };
  const onAgentDragStart = (pane: Pane, e: React.DragEvent<HTMLDivElement>) => {
    clearWorkspaceDrag();
    setDraggedAgentPaneId(pane.pane_id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", pane.pane_id);
  };
  const onAgentDragOver = (pane: Pane, e: React.DragEvent<HTMLDivElement>) => {
    if (!draggedAgentPaneId || draggedAgentPaneId === pane.pane_id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const position = workspaceDropPosition(e);
    setAgentDropTarget((current) =>
      current?.paneId === pane.pane_id && current.position === position
        ? current
        : { paneId: pane.pane_id, position },
    );
  };
  const onAgentDrop = (pane: Pane, e: React.DragEvent<HTMLDivElement>) => {
    if (!draggedAgentPaneId) return;
    e.preventDefault();
    const draggedPaneId = draggedAgentPaneId;
    const position = workspaceDropPosition(e);
    clearAgentDrag();
    if (draggedPaneId === pane.pane_id) return;
    setAgentPaneOrder(
      moveAgentPane(
        agentPanes.map((candidate) => candidate.pane_id),
        draggedPaneId,
        pane.pane_id,
        position,
      ),
    );
  };

  const { topLevel, childrenByParent } = buildWorkspaceHierarchy(
    s.workspaces,
    pinnedWorkspaceSet,
  );
  const focusedRepoWorkspace = s.workspaces.find(
    (workspace) => workspace.focused && workspace.worktree,
  );

  const workspacePanel = (
    <div
      key="workspaces"
      className="panel tree workspace-tree-panel"
      tabIndex={-1}
    >
      <div className="panel-head">
        <h2>Workspaces</h2>
        <div className="panel-actions">
          {connectedServerCount > 1 ? (
            <ThemedSelect
              className="workspace-scope-control"
              aria-label="Workspace server scope"
              value={allServers ? "all" : "current"}
              options={[
                { value: "current", label: "Current" },
                { value: "all", label: "All servers" },
              ]}
              onChange={(scope) => {
                clearWorkspaceDrag();
                clearAgentDrag();
                setMenu(null);
                setAgentMenu(null);
                setAllServers(scope === "all");
              }}
            />
          ) : null}
          {focusedRepoWorkspace ? (
            <button
              type="button"
              className="panel-add panel-action-icon"
              title="Worktree lifecycle"
              aria-label="Open worktree lifecycle"
              onClick={() =>
                setLifecycleWorkspaceId(focusedRepoWorkspace.workspace_id)
              }
            >
              <GitBranch size={14} />
            </button>
          ) : null}
          <button
            className="panel-add panel-action-icon"
            title="New workspace"
            onClick={() => onCreateWorkspace(allServers)}
          >
            <Plus size={14} />
          </button>
        </div>
      </div>
      <div
        className="workspace-tree-content"
        role="tree"
        aria-label="Workspaces and agents"
      >
        {allServers ? (
          <>
            {allServerSessions.messages.map((message) => (
              <p key={message} className="muted" role="status">
                {message}
              </p>
            ))}
            {s.connections.map((connection) => {
              const current = connection.id === s.activeConnectionId;
              let snapshot =
                connection.state === "ready"
                  ? allServerSessions.snapshots.find(
                      (entry) =>
                        entry.connection_id === connection.id &&
                        entry.connection_generation === connection.generation,
                    )
                  : undefined;
              if (
                snapshot &&
                !snapshot.error &&
                current &&
                s.lastRefresh > 0 &&
                s.serverRuntimeGeneration === connection.generation
              ) {
                snapshot = {
                  ...snapshot,
                  workspaces: s.workspaces,
                  tabs: s.tabs,
                  panes: s.panes,
                };
              }
              return (
                <ServerWorkspaceRows
                  key={JSON.stringify([connection.id, connection.generation])}
                  connection={connection}
                  snapshot={snapshot}
                  layout={agentLayout}
                  activePaneId={activePaneId}
                  reviews={current ? reviews : {}}
                  pinnedKeys={current ? pinnedWorkspaceSet : undefined}
                  collapsedKeys={
                    current ? collapsedWorktreeGroupSet : undefined
                  }
                  onCollapsedChange={
                    current ? updateCollapsedWorktreeGroup : undefined
                  }
                  onSelect={onSelect}
                  onSelectAgent={onSelectAgent}
                  onContextMenu={setMenu}
                  onAgentContextMenu={setAgentMenu}
                />
              );
            })}
          </>
        ) : s.workspaces.length === 0 ? (
          <p className="muted">
            {s.status === "connected"
              ? "No workspaces."
              : "Connect to the bridge to load workspaces."}
          </p>
        ) : null}
        {!allServers &&
          topLevel.map((w) => (
            <WorkspaceRow
              key={w.workspace_id}
              w={w}
              reviews={reviews}
              depth={0}
              childrenByParent={childrenByParent}
              agentsByWorkspace={
                agentLayout === "nested"
                  ? agentsByWorkspace
                  : EMPTY_AGENT_PANES_BY_WORKSPACE
              }
              tabCountsByWorkspace={tabCountsByWorkspace}
              alwaysShowTabCount={agentLayout === "compact"}
              activePaneId={activePaneId}
              pinnedWorkspaceKeys={pinnedWorkspaceSet}
              collapsedWorktreeGroupKeys={collapsedWorktreeGroupSet}
              onCollapsedChange={updateCollapsedWorktreeGroup}
              onSelect={onSelect}
              onSelectAgent={onSelectAgent}
              onAgentContextMenu={(pane, x, y) => setAgentMenu({ pane, x, y })}
              onContextMenu={(w, x, y) => setMenu({ workspace: w, x, y })}
              workspaceDrag={{
                isDragging: draggedWorkspaceId === w.workspace_id,
                dropPosition:
                  workspaceDropTarget?.workspaceId === w.workspace_id
                    ? workspaceDropTarget.position
                    : null,
                onDragStart: (e) => onWorkspaceDragStart(w, e),
                onDragOver: (e) => onWorkspaceDragOver(w, e),
                onDrop: (e) => onWorkspaceDrop(w, e),
                onDragEnd: clearWorkspaceDrag,
              }}
            />
          ))}
      </div>
      <AgentLayoutControl value={agentLayout} onChange={setAgentLayout} />
    </div>
  );
  const agentsPanel =
    agentLayout === "separate" ? (
      <div key="agents" className="panel agents-panel">
        <div className="panel-head">
          <h2>Agents</h2>
          <div className="panel-actions agent-list-controls">
            <ThemedSelect
              className="agent-list-control"
              icon={<ArrowDownWideNarrow size={15} aria-hidden="true" />}
              align="end"
              aria-label="Agent sort order"
              title={`Sort agents: ${{ attention: "Attention first", workspace: "Workspace order", manual: "Manual order" }[agentSort]}`}
              value={agentSort}
              options={[
                { value: "attention", label: "Attention first" },
                { value: "workspace", label: "Workspace order" },
                ...(!allServers
                  ? [{ value: "manual", label: "Manual order" }]
                  : []),
              ]}
              onChange={(sort) => {
                clearAgentDrag();
                setAgentListPreferences((current) => ({
                  ...current,
                  sort: sort as AgentSort,
                }));
              }}
            />
            <ThemedSelect
              className={`agent-list-control ${agentListPreferences.grouping !== "none" ? "is-active" : ""}`}
              icon={<Layers size={15} aria-hidden="true" />}
              align="end"
              aria-label="Agent grouping"
              title={`Group agents: ${{ none: "No grouping", status: "Status", workspace: "Workspace", agent: "Agent type" }[agentListPreferences.grouping]}`}
              value={agentListPreferences.grouping}
              options={[
                { value: "none", label: "No grouping" },
                { value: "status", label: "Status" },
                { value: "workspace", label: "Workspace" },
                { value: "agent", label: "Agent type" },
              ]}
              onChange={(grouping) => {
                clearAgentDrag();
                setAgentListPreferences((current) => ({
                  ...current,
                  grouping: grouping as AgentGrouping,
                }));
              }}
            />
          </div>
        </div>
        <div className="agents-list">
          {listedAgentPanes.length > 0 ? (
            agentGroups.map((group) => {
              const groupKey = `${agentListPreferences.grouping}:${group.key}`;
              const collapsed = collapsedAgentGroups.has(groupKey);
              return (
                <div key={groupKey} className="agent-list-group">
                  {agentListPreferences.grouping !== "none" ? (
                    <button
                      type="button"
                      className="agent-group-toggle"
                      aria-expanded={!collapsed}
                      onClick={() =>
                        setCollapsedAgentGroups((current) => {
                          const next = new Set(current);
                          if (next.has(groupKey)) next.delete(groupKey);
                          else next.add(groupKey);
                          return next;
                        })
                      }
                    >
                      {collapsed ? (
                        <ChevronRight size={13} />
                      ) : (
                        <ChevronDown size={13} />
                      )}
                      <span>{group.label}</span>
                      <span className="muted">{group.panes.length}</span>
                    </button>
                  ) : null}
                  {(!collapsed || agentListPreferences.grouping === "none") &&
                    group.panes.map((pane) => {
                      const source = "connectionId" in pane ? pane : null;
                      const current =
                        !source || source.connectionId === s.activeConnectionId;
                      const workspace = s.workspaces.find(
                        (candidate) =>
                          candidate.workspace_id === pane.workspace_id,
                      );
                      return (
                        <AgentRow
                          key={
                            source
                              ? JSON.stringify([
                                  source.workspaceKey,
                                  pane.pane_id,
                                ])
                              : pane.pane_id
                          }
                          pane={pane}
                          selected={
                            current &&
                            (pane.pane_id === activePaneId ||
                              (!activePaneId && pane.focused))
                          }
                          showPaneId
                          variant="standalone"
                          workspaceLabel={
                            source?.workspaceLabel ??
                            (workspace
                              ? workspaceDisplayName(workspace)
                              : pane.workspace_id)
                          }
                          serverLabel={source?.serverLabel}
                          tabLabel={source?.tabLabel}
                          onActivate={
                            source
                              ? () => {
                                  void openServerSession(
                                    source,
                                    source.workspace_id,
                                    source.pane_id,
                                  ).then((opened) => {
                                    if (opened && current)
                                      onSelectAgent?.(pane);
                                  });
                                }
                              : undefined
                          }
                          onSelect={onSelectAgent}
                          onOpenMenu={(x, y) =>
                            setAgentMenu({
                              pane,
                              x,
                              y,
                              source: source ?? undefined,
                            })
                          }
                          drag={
                            !allServers && manualAgentOrder
                              ? {
                                  isDragging:
                                    draggedAgentPaneId === pane.pane_id,
                                  dropPosition:
                                    agentDropTarget?.paneId === pane.pane_id
                                      ? agentDropTarget.position
                                      : null,
                                  onDragStart: (event) =>
                                    onAgentDragStart(pane, event),
                                  onDragOver: (event) =>
                                    onAgentDragOver(pane, event),
                                  onDrop: (event) => onAgentDrop(pane, event),
                                  onDragEnd: clearAgentDrag,
                                }
                              : undefined
                          }
                        />
                      );
                    })}
                </div>
              );
            })
          ) : (
            <p className="muted">
              {allServers && allServerSessions.loading
                ? "Loading..."
                : "No agent sessions."}
            </p>
          )}
        </div>
      </div>
    ) : null;

  return (
    <>
      {agentsFirst ? agentsPanel : workspacePanel}
      {agentsFirst ? workspacePanel : agentsPanel}
      <Suspense fallback={null}>
        {(menu || menuMounted) && (
          <ContextMenu
            state={menu}
            reviewStatus={
              menu ? reviews[menu.workspace.workspace_id] : undefined
            }
            pinnedWorkspaceKeys={pinnedWorkspaceSet}
            onPinnedChange={updatePinnedWorkspace}
            onBrowseFiles={onBrowseFiles}
            onReviewChanges={onReviewChanges}
            onClose={() => setMenu(null)}
          />
        )}
      </Suspense>
      <AgentContextMenu
        state={agentMenu}
        onClose={() => setAgentMenu(null)}
        onFocus={(pane) => {
          if (agentMenu?.source) {
            const current =
              agentMenu.source.connectionId === s.activeConnectionId;
            void openServerSession(
              agentMenu.source,
              pane.workspace_id,
              pane.pane_id,
            ).then((opened) => {
              if (opened && current) onSelectAgent?.(pane);
            });
          } else {
            void store.focusPane(pane.pane_id);
            onSelectAgent?.(pane);
          }
        }}
        onBrowseFiles={onBrowseFilesForAgent}
        onReviewChanges={onReviewChangesForAgent}
        onViewHistory={onViewAgentHistory}
        onExportSession={(pane) =>
          exportSessionForConnection(pane, connectionClient)
        }
        onClosePane={(pane) => {
          if (store.guardPaneClose(pane.pane_id)) setPendingClosePane(pane);
        }}
      />
      <ConfirmDialog
        open={!!pendingClosePane}
        title="Close Agent Pane"
        message={
          pendingClosePane
            ? `Close pane "${shortId(pendingClosePane.pane_id)}"?${terminalComposerCloseWarning(
                terminalComposerDraftPaneIds(
                  s.activeConnectionId,
                  s.connectionGeneration,
                  [pendingClosePane.pane_id],
                ).length,
              )}`
            : "Close this pane?"
        }
        confirmLabel="Close"
        danger
        onClose={() => setPendingClosePane(null)}
        onConfirm={() => {
          if (pendingClosePane) {
            store.closePane(pendingClosePane.pane_id);
          }
        }}
      />
      <WorktreeLifecycleDialog
        open={!!lifecycleWorkspaceId}
        workspaceId={lifecycleWorkspaceId}
        onClose={() => setLifecycleWorkspaceId(null)}
      />
    </>
  );
}

type WorkspaceDragProps = {
  isDragging: boolean;
  dropPosition: "before" | "after" | null;
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
};

type WorkspaceTreeSource = ServerSessionSource & { tabs: Tab[] };

function ServerWorkspaceRows({
  connection,
  snapshot,
  layout,
  activePaneId,
  reviews,
  pinnedKeys,
  collapsedKeys,
  onCollapsedChange,
  onSelect,
  onSelectAgent,
  onContextMenu,
  onAgentContextMenu,
}: {
  connection: ConnectionSummary;
  snapshot?: ConnectionAgentSessions;
  layout: WorkspaceAgentLayout;
  activePaneId: string | null;
  reviews: Record<string, PullRequestSummary>;
  pinnedKeys?: ReadonlySet<string>;
  collapsedKeys?: ReadonlySet<string>;
  onCollapsedChange?: (workspace: Workspace, collapsed: boolean) => void;
  onSelect?: (workspace: Workspace) => void;
  onSelectAgent?: (pane: Pane) => void;
  onContextMenu: (menu: ContextMenuState) => void;
  onAgentContextMenu: (menu: AgentMenuState) => void;
}) {
  const pinsKey = connectionStorageKey(
    connection.id,
    WORKSPACE_PINS_STORAGE_KEY,
  );
  const groupsKey = connectionStorageKey(
    connection.id,
    COLLAPSED_WORKTREE_GROUPS_STORAGE_KEY,
  );
  const readPreferences = useCallback(
    () => ({
      pins: parseWorkspacePins(roamgateLocalStorage.getItem(pinsKey)),
      groups: parseCollapsedWorktreeGroups(
        roamgateLocalStorage.getItem(groupsKey),
      ),
    }),
    [pinsKey, groupsKey],
  );
  const [preferences, setPreferences] = useState(readPreferences);
  useEffect(
    () =>
      subscribeLocalStorage((key) => {
        if (key === null || key === pinsKey || key === groupsKey)
          setPreferences(readPreferences());
      }),
    [pinsKey, groupsKey, readPreferences],
  );
  const source: WorkspaceTreeSource = {
    connectionId: connection.id,
    runtimeGeneration: connection.generation,
    serverLabel: connection.label,
    tabs: snapshot?.tabs ?? [],
  };
  const workspaces = snapshot?.workspaces ?? [];
  const pins = pinnedKeys ?? new Set(preferences.pins);
  const { topLevel, childrenByParent } = buildWorkspaceHierarchy(
    workspaces,
    pins,
  );
  const agents =
    layout === "nested"
      ? groupAgentPanesByWorkspace(snapshot?.panes ?? [])
      : EMPTY_AGENT_PANES_BY_WORKSPACE;
  const tabCounts = new Map<string, number>();
  for (const tab of source.tabs)
    tabCounts.set(tab.workspace_id, (tabCounts.get(tab.workspace_id) ?? 0) + 1);
  const updateCollapsed = (workspace: Workspace, collapsed: boolean) => {
    if (onCollapsedChange) onCollapsedChange(workspace, collapsed);
    else {
      const groups = setWorktreeGroupCollapsed(
        preferences.groups,
        workspace,
        collapsed,
      );
      setPreferences((previous) => ({ ...previous, groups }));
      roamgateLocalStorage.setItem(
        groupsKey,
        serializeCollapsedWorktreeGroups(groups),
      );
    }
  };
  const message =
    connection.state !== "ready"
      ? connectionLifecycleLabel(connection.state)
      : snapshot?.error
        ? snapshot.error
        : !snapshot
          ? "Loading..."
          : topLevel.length === 0
            ? "No workspaces."
            : null;
  if (message) {
    return (
      <p
        className="muted workspace-server-message"
        data-connection-id={connection.id}
        role="status"
      >
        {connection.label}: {message}
      </p>
    );
  }
  return (
    <>
      {topLevel.map((workspace) => (
        <WorkspaceRow
          key={workspace.workspace_id}
          w={workspace}
          source={source}
          reviews={reviews}
          depth={0}
          childrenByParent={childrenByParent}
          agentsByWorkspace={agents}
          tabCountsByWorkspace={tabCounts}
          alwaysShowTabCount={layout === "compact"}
          activePaneId={activePaneId}
          pinnedWorkspaceKeys={pins}
          collapsedWorktreeGroupKeys={
            collapsedKeys ?? new Set(preferences.groups)
          }
          onCollapsedChange={updateCollapsed}
          onSelect={onSelect}
          onSelectAgent={onSelectAgent}
          onContextMenu={(workspace, x, y) =>
            onContextMenu({ workspace, x, y, source })
          }
          onAgentContextMenu={(pane, x, y) =>
            onAgentContextMenu({ pane, x, y, source })
          }
        />
      ))}
    </>
  );
}

function workspaceSubtreeContainsActiveItem(
  workspace: Workspace,
  childrenByParent: ReadonlyMap<string, Workspace[]>,
  agentsByWorkspace: ReadonlyMap<string, Pane[]>,
  activePaneId: string | null,
): boolean {
  if (workspace.focused) return true;
  const agents = agentsByWorkspace.get(workspace.workspace_id) ?? [];
  if (
    agents.some(
      (pane) =>
        pane.pane_id === activePaneId || (!activePaneId && pane.focused),
    )
  ) {
    return true;
  }
  return (childrenByParent.get(workspace.workspace_id) ?? []).some((child) =>
    workspaceSubtreeContainsActiveItem(
      child,
      childrenByParent,
      agentsByWorkspace,
      activePaneId,
    ),
  );
}

function WorkspaceRow({
  w,
  source,
  reviews,
  depth,
  childrenByParent,
  agentsByWorkspace,
  tabCountsByWorkspace,
  alwaysShowTabCount = false,
  activePaneId,
  pinnedWorkspaceKeys,
  collapsedWorktreeGroupKeys,
  onCollapsedChange,
  onSelect,
  onSelectAgent,
  onAgentContextMenu,
  onContextMenu,
  workspaceDrag,
}: {
  w: Workspace;
  source?: WorkspaceTreeSource;
  reviews: Record<string, PullRequestSummary>;
  depth: number;
  childrenByParent: Map<string, Workspace[]>;
  agentsByWorkspace: ReadonlyMap<string, Pane[]>;
  tabCountsByWorkspace: ReadonlyMap<string, number>;
  alwaysShowTabCount?: boolean;
  activePaneId: string | null;
  pinnedWorkspaceKeys: ReadonlySet<string>;
  collapsedWorktreeGroupKeys: ReadonlySet<string>;
  onCollapsedChange: (workspace: Workspace, collapsed: boolean) => void;
  onSelect?: (workspace: Workspace) => void;
  onSelectAgent?: (pane: Pane) => void;
  onAgentContextMenu: (pane: Pane, x: number, y: number) => void;
  onContextMenu: (w: Workspace, x: number, y: number) => void;
  workspaceDrag?: WorkspaceDragProps;
}) {
  const children = childrenByParent.get(w.workspace_id) ?? [];
  const review = workspacePullRequest(reviews[w.workspace_id]);
  const agents = agentsByWorkspace.get(w.workspace_id) ?? [];
  const tabCount = tabCountsByWorkspace.get(w.workspace_id) ?? 0;
  const tabCountVisible = alwaysShowTabCount || tabCount > 1;
  const s = useStoreSelector(
    (state) => ({
      activeConnectionId: state.activeConnectionId,
      pendingFocusWorkspaceId: state.pendingFocusWorkspaceId,
      tabs: state.tabs,
    }),
    shallowEqual,
  );
  const current = !source || source.connectionId === s.activeConnectionId;
  const workspaceFocused = current && w.focused;
  const tabs = source?.tabs ?? s.tabs;
  const paneIdsToShow = nestedAgentPaneIds(agents, tabs);
  const isChild = depth > 0;
  const hasChildren = children.length > 0;
  const hasNestedItems = hasChildren || agents.length > 0;
  const hasActiveAgent =
    current &&
    agents.some(
      (pane) =>
        pane.pane_id === activePaneId || (!activePaneId && pane.focused),
    );
  const hiddenDescendantActive =
    current &&
    children.some((child) =>
      workspaceSubtreeContainsActiveItem(
        child,
        childrenByParent,
        agentsByWorkspace,
        activePaneId,
      ),
    );
  const collapsed =
    hasNestedItems && isWorktreeGroupCollapsed(collapsedWorktreeGroupKeys, w);
  const pinned = isWorkspacePinned(pinnedWorkspaceKeys, w);
  const isPendingFocus =
    current && s.pendingFocusWorkspaceId === w.workspace_id && !w.focused;
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStart = useRef<{ x: number; y: number } | null>(null);
  const longPressTriggered = useRef(false);

  const clearLongPressTimer = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  useEffect(() => clearLongPressTimer, []);

  const openMenu = (x: number, y: number) => {
    onContextMenu(w, x, y);
  };
  const selectWorkspace = () => {
    if (source) {
      void openServerSession(source, w.workspace_id).then((opened) => {
        if (opened && current) onSelect?.(w);
      });
    } else {
      store.focusWorkspace(w.workspace_id);
      onSelect?.(w);
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse") return;
    longPressTriggered.current = false;
    longPressStart.current = { x: e.clientX, y: e.clientY };
    clearLongPressTimer();
    longPressTimer.current = setTimeout(() => {
      longPressTriggered.current = true;
      openMenu(e.clientX, e.clientY);
    }, LONG_PRESS_MS);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = longPressStart.current;
    if (!start) return;
    const dx = Math.abs(e.clientX - start.x);
    const dy = Math.abs(e.clientY - start.y);
    if (dx > LONG_PRESS_MOVE_PX || dy > LONG_PRESS_MOVE_PX) {
      clearLongPressTimer();
      longPressStart.current = null;
    }
  };

  const onPointerEnd = () => {
    clearLongPressTimer();
    longPressStart.current = null;
  };

  return (
    <>
      <div
        className={`tree-row clickable-row ${workspaceFocused ? "is-focused" : ""} ${
          hasActiveAgent ? "has-active-agent" : ""
        } ${isChild ? "is-child" : ""} ${pinned ? "is-pinned" : ""} ${
          isPendingFocus ? "is-loading" : ""
        } ${tabCountVisible ? "has-tab-count" : ""} ${
          workspaceDrag?.isDragging ? "is-dragging" : ""
        } ${
          workspaceDrag?.dropPosition
            ? `drop-${workspaceDrag.dropPosition}`
            : ""
        }`}
        style={{
          paddingLeft: 6 + depth * TREE_DEPTH_INDENT,
        }}
        role="treeitem"
        data-connection-id={source?.connectionId}
        draggable={!!workspaceDrag}
        onDragStart={workspaceDrag?.onDragStart}
        onDragOver={workspaceDrag?.onDragOver}
        onDrop={workspaceDrag?.onDrop}
        onDragEnd={workspaceDrag?.onDragEnd}
        tabIndex={
          workspaceTreeItemIsTabStop({
            workspaceFocused,
            directAgentActive: hasActiveAgent,
            collapsed,
            hiddenDescendantActive,
          })
            ? 0
            : -1
        }
        aria-level={depth + 1}
        aria-selected={workspaceFocused}
        aria-expanded={hasNestedItems ? !collapsed : undefined}
        onClick={(e) => {
          if (longPressTriggered.current) {
            longPressTriggered.current = false;
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          selectWorkspace();
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          const action = treeKeyboardAction(event.key, event.shiftKey);
          if (!action) return;
          if (
            action === "next" ||
            action === "previous" ||
            action === "first" ||
            action === "last"
          ) {
            event.preventDefault();
            focusTreeItem(event.currentTarget, action);
            return;
          }
          if (action === "expand") {
            event.preventDefault();
            if (hasNestedItems && collapsed) {
              onCollapsedChange(w, false);
            } else {
              focusTreeItem(event.currentTarget, "next");
            }
            return;
          }
          if (action === "collapse") {
            event.preventDefault();
            if (hasNestedItems && !collapsed) {
              onCollapsedChange(w, true);
            } else {
              focusTreeItem(event.currentTarget, "previous");
            }
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          if (action === "activate") {
            selectWorkspace();
          } else {
            const point = keyboardContextMenuPoint(event.currentTarget);
            openMenu(point.x, point.y);
          }
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onPointerLeave={onPointerEnd}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu(e.clientX, e.clientY);
        }}
        title={
          w.worktree
            ? [
                `${w.worktree.repo_name} · ${w.worktree.checkout_path}`,
                gitStatusTitle(w.worktree.git_status),
              ]
                .filter(Boolean)
                .join("\n")
            : w.workspace_id
        }
      >
        {hasNestedItems ? (
          <button
            type="button"
            className="workspace-group-toggle"
            tabIndex={-1}
            title={collapsed ? "Expand workspace" : "Collapse workspace"}
            aria-label={collapsed ? "Expand workspace" : "Collapse workspace"}
            aria-expanded={!collapsed}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerMove={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onPointerCancel={(event) => event.stopPropagation()}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openMenu(event.clientX, event.clientY);
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onCollapsedChange(w, !collapsed);
            }}
          >
            {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </button>
        ) : (
          <span className="twisty" aria-hidden="true" />
        )}
        <strong className="ws-label" title={workspaceDisplayName(w)}>
          {workspaceDisplayName(w)}
        </strong>
        {source ? (
          <span
            className="workspace-server-badge"
            title={source.serverLabel}
            aria-label={`Server: ${source.serverLabel}`}
          >
            {source.serverLabel}
          </span>
        ) : null}
        {tabCountVisible ? (
          <span
            className="workspace-tab-count"
            title={`${tabCount} tabs`}
            aria-label={`${tabCount} tabs`}
          >
            {tabCount}
          </span>
        ) : null}
        {pinned ? (
          <Pin
            className="workspace-pin"
            size={11}
            fill="currentColor"
            aria-label="Pinned"
          />
        ) : null}
        {isPendingFocus ? (
          <span className="row-spinner" aria-label="Loading workspace" />
        ) : null}
        {w.worktree ? (
          <>
            {review ? <PullRequestBadge review={review} /> : null}
            <GitStatusBadges
              status={w.worktree.git_status}
              showBranch={!review && showWorkspaceBranchBadge(w)}
            />
          </>
        ) : null}
      </div>
      {!collapsed ? (
        <>
          {agents.map((pane) => (
            <AgentRow
              key={pane.pane_id}
              pane={pane}
              depth={depth + 1}
              showPaneId={paneIdsToShow.has(pane.pane_id)}
              selected={
                current &&
                (pane.pane_id === activePaneId ||
                  (!activePaneId && pane.focused))
              }
              tabLabel={
                source
                  ? (tabs.find(
                      (tab) =>
                        tab.tab_id === pane.tab_id &&
                        tab.workspace_id === pane.workspace_id,
                    )?.label ?? "")
                  : undefined
              }
              onActivate={
                source
                  ? () => {
                      void openServerSession(
                        source,
                        pane.workspace_id,
                        pane.pane_id,
                      ).then((opened) => {
                        if (opened && current) onSelectAgent?.(pane);
                      });
                    }
                  : undefined
              }
              onSelect={onSelectAgent}
              onOpenMenu={(x, y) => onAgentContextMenu(pane, x, y)}
            />
          ))}
          {children.map((child) => (
            <WorkspaceRow
              key={child.workspace_id}
              w={child}
              source={source}
              reviews={reviews}
              depth={depth + 1}
              childrenByParent={childrenByParent}
              agentsByWorkspace={agentsByWorkspace}
              tabCountsByWorkspace={tabCountsByWorkspace}
              alwaysShowTabCount={alwaysShowTabCount}
              activePaneId={activePaneId}
              pinnedWorkspaceKeys={pinnedWorkspaceKeys}
              collapsedWorktreeGroupKeys={collapsedWorktreeGroupKeys}
              onCollapsedChange={onCollapsedChange}
              onSelect={onSelect}
              onSelectAgent={onSelectAgent}
              onAgentContextMenu={onAgentContextMenu}
              onContextMenu={onContextMenu}
            />
          ))}
        </>
      ) : null}
    </>
  );
}

import {
  shortcutMatches,
  shortcutTitle,
  shortcutLabel,
  useShortcutPreferences,
  getShortcutSnapshot,
} from "../shortcutPreferences";
import { SHORTCUT_NUMBERS, type ShortcutNumber } from "../shortcutBindings";
import { endpointCreationReason } from "../store";
import { normalizeSearchText } from "../searchText";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronsUpDown,
  FileDiff,
  FileText,
  FolderPlus,
  FolderOpen,
  GitCommitHorizontal,
  GitBranch,
  Keyboard,
  Maximize2,
  PanelTop,
  SplitSquareHorizontal,
  SplitSquareVertical,
  X,
} from "lucide-react";
import { shallowEqual, store, useStoreSelector } from "../store";
import {
  clearTerminalComposerDrafts,
  terminalComposerCloseWarning,
  terminalComposerDraftPaneIds,
} from "../terminalComposer";
import type { FileExplorerEntry, Pane, Tab, Workspace } from "../types";
import { basename, shortId } from "../utils";
import { luckyWorktreeBranchName } from "../luckyName";
import { CreateWorkspaceDialog } from "./CreateWorkspaceDialog";
import { ConfirmDialog, TextInputDialog } from "./ModalDialogs";
import { WorktreeHooksDialog } from "./WorktreeHooksDialog";
import { WorktreeOpenDialog } from "./WorktreeOpenDialog";
import { AgentIcon } from "./AgentIcon";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "./ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { canCreateWorktree, worktreeCreationSource } from "../worktree";
import { WorktreeLifecycleDialog } from "./WorktreeLifecycleDialog";

type TextAction =
  | { type: "rename-workspace"; workspace: Workspace }
  | { type: "rename-tab"; tab: Tab }
  | { type: "create-worktree"; workspace: Workspace; branch: string };

type ActionDefinition = {
  key: string;
  icon: React.ReactNode;
  title: string;
  detail?: string;
  shortcut?: string;
  keywords?: string[];
  danger?: boolean;
  disabledReason?: string | null;
  run: () => void;
};

type ActionGroupDefinition = {
  heading: string;
  actions: ActionDefinition[];
};

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function tabName(tab?: Tab) {
  if (!tab) return "";
  return tab.label && tab.label !== String(tab.number)
    ? tab.label
    : `Tab ${tab.number}`;
}

function workspaceName(workspace?: Workspace) {
  return workspace?.label || workspace?.workspace_id || "";
}

function agentName(pane: Pane) {
  return [
    pane.agent || "Agent",
    basename(pane.foreground_cwd || pane.cwd),
    shortId(pane.pane_id),
  ]
    .filter(Boolean)
    .join(" · ");
}

export { normalizeSearchText };

export function commandFilter(
  value: string,
  search: string,
  keywords?: string[],
) {
  const query = normalizeSearchText(search);
  if (!query) return 1;

  const haystack = normalizeSearchText(value);
  const keywordText = normalizeSearchText((keywords ?? []).join(" "));
  const combined = [haystack, keywordText].filter(Boolean).join(" ");

  if (haystack === query) return 1;
  if (haystack.includes(query)) return 0.95;
  if (keywordText.includes(query)) return 0.9;

  const tokens = query.split(" ").filter(Boolean);
  if (tokens.length === 0) return 1;
  if (tokens.every((token) => combined.includes(token))) return 0.75;
  if (tokens.some((token) => combined.includes(token))) return 0.35;

  return 0;
}

function actionSearchValue(action: ActionDefinition) {
  return [action.title, action.detail, action.shortcut]
    .filter(Boolean)
    .join(" ");
}

function actionDisplaySignature(action: ActionDefinition) {
  return normalizeSearchText(
    [
      action.title,
      action.detail,
      action.shortcut,
      action.danger ? "danger" : "",
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function actionCommandValue(action: ActionDefinition) {
  return [action.title, action.detail, action.shortcut, action.key]
    .filter(Boolean)
    .join(" ");
}

function rankAction(action: ActionDefinition, search: string) {
  return commandFilter(actionSearchValue(action), search, action.keywords);
}

function pathLeaf(path: string) {
  return path.split("/").filter(Boolean).pop() ?? path;
}

export function commandPathQuery(value: string) {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return "";
  const normalized = trimmed
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  if (!normalized) return "";
  if (
    normalized.includes("/") ||
    normalized.startsWith(".") ||
    /\.[^/]+$/.test(normalized)
  ) {
    return normalized;
  }
  return "";
}

type CommandNumberShortcutModifiers = Pick<
  KeyboardEvent,
  "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
>;

type CommandNumberShortcutEvent = CommandNumberShortcutModifiers &
  Pick<KeyboardEvent, "preventDefault" | "repeat" | "stopPropagation">;

export function commandNumberShortcutIndex(
  event: CommandNumberShortcutModifiers,
) {
  const number = SHORTCUT_NUMBERS.find((n) =>
    shortcutMatches(event, `command.${n}`),
  );
  return number === undefined ? null : number - 1;
}

export function commandNumberedActions<T>(
  groups: readonly { actions: readonly T[] }[],
) {
  return groups.flatMap((group) => group.actions).slice(0, 9);
}

export function commandNumberShortcutTarget<T>(
  event: CommandNumberShortcutModifiers,
  actions: readonly T[],
) {
  const index = commandNumberShortcutIndex(event);
  return index === null ? null : (actions[index] ?? null);
}

export function runCommandNumberShortcut<T>(
  event: CommandNumberShortcutEvent,
  actions: readonly T[],
  runAction: (action: T) => void,
) {
  if (event.repeat) return false;
  const action = commandNumberShortcutTarget(event, actions);
  if (action === null) return false;
  event.preventDefault();
  event.stopPropagation();
  runAction(action);
  return true;
}

export function CommandCombobox({
  onOpenFileExplorer,
  onOpenFile,
  onOpenDiffViewer,
}: {
  onOpenFileExplorer?: (workspaceId?: string) => void;
  onOpenFile?: (workspaceId: string, entry: FileExplorerEntry) => void;
  onOpenDiffViewer?: (workspaceId?: string) => void;
}) {
  useShortcutPreferences();
  const s = useStoreSelector(
    (state) => ({
      activeConnectionId: state.activeConnectionId,
      connectionGeneration: state.connectionGeneration,
      layout: state.layout,
      panes: state.panes,
      selectedPaneId: state.selectedPaneId,
      tabs: state.tabs,
      workspaces: state.workspaces,
      endpointAvailability: state.endpointAvailability,
    }),
    shallowEqual,
  );
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedActionValue, setSelectedActionValue] = useState("");
  const [selectedActionSearch, setSelectedActionSearch] = useState("");
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [openWorktreeWorkspaceId, setOpenWorktreeWorkspaceId] = useState<
    string | null
  >(null);
  const [worktreeHooksWorkspaceId, setWorktreeHooksWorkspaceId] = useState<
    string | null
  >(null);
  const [lifecycleWorkspaceId, setLifecycleWorkspaceId] = useState<
    string | null
  >(null);
  const [textAction, setTextAction] = useState<TextAction | null>(null);
  const [pendingCloseWorkspace, setPendingCloseWorkspace] =
    useState<Workspace | null>(null);
  const [pendingCloseTab, setPendingCloseTab] = useState<Tab | null>(null);
  const [pendingClosePane, setPendingClosePane] = useState<Pane | null>(null);
  const [pendingRemoveWorktree, setPendingRemoveWorktree] =
    useState<Workspace | null>(null);

  const composerDraftWarningFor = (paneIds: string[]) =>
    terminalComposerCloseWarning(
      terminalComposerDraftPaneIds(
        s.activeConnectionId,
        s.connectionGeneration,
        paneIds,
      ).length,
    );
  const clearComposerDraftsFor = (paneIds: string[]) =>
    clearTerminalComposerDrafts(
      s.activeConnectionId,
      s.connectionGeneration,
      paneIds,
    );

  const focusedWorkspace = s.workspaces.find((w) => w.focused);
  const activeTab =
    s.tabs.find((t) => t.tab_id === focusedWorkspace?.active_tab_id) ??
    s.tabs.find((t) => t.focused);
  const activePane =
    s.panes.find((p) => p.pane_id === s.selectedPaneId) ??
    s.panes.find((p) => p.pane_id === s.layout?.focused_pane_id) ??
    s.panes.find((p) => p.tab_id === activeTab?.tab_id && p.focused) ??
    s.panes.find((p) => p.tab_id === activeTab?.tab_id);
  const agents = useMemo(
    () =>
      s.panes
        .filter((p) => p.agent && p.agent_status !== "unknown")
        .sort((a, b) => agentName(a).localeCompare(agentName(b))),
    [s.panes],
  );
  const focusedWorkspaceTabs = useMemo(
    () =>
      s.tabs
        .filter((tab) => tab.workspace_id === focusedWorkspace?.workspace_id)
        .sort((a, b) => a.number - b.number),
    [focusedWorkspace?.workspace_id, s.tabs],
  );
  const activeAgent =
    activePane && activePane.agent && activePane.agent_status !== "unknown"
      ? activePane
      : null;
  const mainWorktreeWorkspaces = useMemo(
    () =>
      s.workspaces
        .filter(canCreateWorktree)
        .sort((a, b) => a.number - b.number),
    [s.workspaces],
  );
  const focusedWorktreeSource = useMemo(
    () =>
      focusedWorkspace
        ? worktreeCreationSource(s.workspaces, focusedWorkspace)
        : undefined,
    [focusedWorkspace, s.workspaces],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The pane switcher owns K even when its held modifiers match this
      // shortcut. Both handlers run on window, so listener order cannot decide.
      if (
        e.defaultPrevented ||
        document.querySelector(".modal-backdrop, .pane-jump-backdrop")
      )
        return;
      if (!shortcutMatches(e, "command.menu") || e.repeat) return;
      if (
        isTypingTarget(e.target) &&
        !(e.target as HTMLElement).closest(".command-popover, .xterm")
      )
        return;
      e.preventDefault();
      e.stopPropagation();
      setOpen((value) => {
        const next = !value;
        if (!next) setSearch("");
        return next;
      });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const run = (fn: () => void) => {
    setOpen(false);
    setSearch("");
    fn();
  };

  const submitTextAction = (value: string) => {
    const action = textAction;
    const trimmed = value.trim();
    if (!action) return;
    if (!trimmed) {
      setTextAction(null);
      return;
    }
    if (action.type === "rename-workspace") {
      store.renameWorkspace(action.workspace.workspace_id, trimmed);
    } else if (action.type === "rename-tab") {
      store.renameTab(action.tab.tab_id, trimmed);
    } else if (action.type === "create-worktree") {
      store.createWorktree(action.workspace.workspace_id, trimmed);
    }
    setTextAction(null);
  };

  const textDialogProps =
    textAction?.type === "rename-workspace"
      ? {
          title: "Rename Workspace",
          label: "Name",
          initialValue: workspaceName(textAction.workspace),
          submitLabel: "Rename",
        }
      : textAction?.type === "rename-tab"
        ? {
            title: "Rename Tab",
            label: "Name",
            initialValue: tabName(textAction.tab),
            submitLabel: "Rename",
          }
        : textAction?.type === "create-worktree"
          ? {
              title: "New Worktree",
              label: "Branch",
              initialValue: textAction.branch,
              placeholder: "my-branch",
              submitLabel: "Create",
            }
          : null;

  const allWorkspaces = [...s.workspaces].sort((a, b) => a.number - b.number);
  const otherWorkspaces = focusedWorkspace
    ? allWorkspaces.filter(
        (workspace) => workspace.workspace_id !== focusedWorkspace.workspace_id,
      )
    : allWorkspaces;

  const currentActions: ActionDefinition[] = [];
  if (focusedWorkspace && focusedWorktreeSource) {
    currentActions.push({
      key: "current-new-worktree",
      icon: <GitBranch size={15} />,
      title: "New worktree",
      detail:
        focusedWorktreeSource.worktree?.checkout_path ??
        workspaceName(focusedWorktreeSource),
      keywords: [
        "create worktree",
        "add worktree",
        "branch",
        "new branch",
        workspaceName(focusedWorkspace),
        workspaceName(focusedWorktreeSource),
      ],
      run: () =>
        setTextAction({
          type: "create-worktree",
          workspace: focusedWorktreeSource,
          branch: luckyWorktreeBranchName(),
        }),
    });
  }
  if (focusedWorkspace) {
    currentActions.push({
      key: "current-file-explorer",
      icon: <FolderOpen size={15} />,
      title: "Open file explorer",
      detail:
        focusedWorkspace.worktree?.checkout_path ??
        focusedWorkspace.cwd ??
        workspaceName(focusedWorkspace),
      keywords: [
        "files",
        "file browser",
        "file tree",
        "explorer",
        "browse repository",
      ],
      run: () => onOpenFileExplorer?.(focusedWorkspace.workspace_id),
    });
    currentActions.push({
      key: "current-diff-viewer",
      icon: <FileDiff size={15} />,
      title: "Open Diff Viewer",
      detail:
        focusedWorkspace.worktree?.checkout_path ??
        focusedWorkspace.cwd ??
        workspaceName(focusedWorkspace),
      keywords: [
        "diff",
        "diff viewer",
        "changes",
        "git diff",
        "changed files",
        "source control",
      ],
      run: () => onOpenDiffViewer?.(focusedWorkspace.workspace_id),
    });
  }
  if (focusedWorkspace?.worktree) {
    currentActions.push({
      key: "current-worktree-lifecycle",
      icon: <GitCommitHorizontal size={15} />,
      title: "Open worktree lifecycle",
      detail: focusedWorkspace.worktree.repo_name,
      keywords: [
        "worktree center",
        "manage worktrees",
        "repository lifecycle",
        "git worktree status",
        "hooks auto sync",
      ],
      run: () => setLifecycleWorkspaceId(focusedWorkspace.workspace_id),
    });
    currentActions.push({
      key: "current-open-worktree",
      icon: <FolderOpen size={15} />,
      title: "Open worktree",
      detail: workspaceName(focusedWorkspace),
      keywords: ["existing worktree", "open existing", "checkout", "branch"],
      run: () => setOpenWorktreeWorkspaceId(focusedWorkspace.workspace_id),
    });
    currentActions.push({
      key: "current-worktree-hooks",
      icon: <GitBranch size={15} />,
      title: "Worktree hooks",
      detail: focusedWorkspace.worktree.repo_name,
      keywords: ["hook config", "hooks config", "paseo", "setup teardown"],
      run: () => setWorktreeHooksWorkspaceId(focusedWorkspace.workspace_id),
    });
    if (focusedWorkspace.worktree.is_linked_worktree) {
      currentActions.push({
        key: "current-remove-worktree",
        icon: <X size={15} />,
        title: "Remove worktree",
        detail: focusedWorkspace.worktree.checkout_path,
        keywords: [
          "delete worktree",
          "close worktree",
          "teardown worktree",
          "remove branch",
          workspaceName(focusedWorkspace),
          focusedWorkspace.worktree.repo_name,
        ],
        danger: true,
        run: () => setPendingRemoveWorktree(focusedWorkspace),
      });
    }
  }
  if (activeTab && focusedWorkspace) {
    currentActions.push({
      key: "current-create-tab",
      icon: <PanelTop size={15} />,
      title: "Create tab",
      detail: workspaceName(focusedWorkspace),
      keywords: ["new tab", "add tab", "open tab"],
      disabledReason: endpointCreationReason(
        store.get(),
        "tab.create",
        focusedWorkspace.workspace_id,
      ),
      run: () => store.createTab(focusedWorkspace.workspace_id),
    });
  }
  if (activePane) {
    currentActions.push({
      key: "current-toggle-pane-zoom",
      icon: <Maximize2 size={15} />,
      title: "Toggle pane zoom",
      detail: shortId(activePane.pane_id),
      keywords: ["maximize pane", "unmaximize pane", "zoom pane", "full pane"],
      run: () => store.zoomPane(activePane.pane_id),
    });
  }

  const directPathQuery = commandPathQuery(search);
  const fileActions: ActionDefinition[] =
    focusedWorkspace && onOpenFile && directPathQuery
      ? [
          {
            key: `quick-open-path-${focusedWorkspace.workspace_id}-${directPathQuery}`,
            icon: <FileText size={15} />,
            title: `Open path: ${pathLeaf(directPathQuery)}`,
            detail: directPathQuery,
            keywords: [
              "quick open",
              "open file",
              "open path",
              "file explorer",
              "preview file",
              directPathQuery,
              pathLeaf(directPathQuery),
            ],
            run: () =>
              onOpenFile(focusedWorkspace.workspace_id, {
                name: pathLeaf(directPathQuery),
                path: directPathQuery,
                type: "file",
                size: 0,
                mtime_ms: 0,
                hidden: pathLeaf(directPathQuery).startsWith("."),
              }),
          },
        ]
      : [];

  const workspaceActions: ActionDefinition[] = [
    {
      key: "create-workspace",
      icon: <FolderPlus size={15} />,
      title: "Create workspace",
      detail: "Open a new Herdr workspace",
      keywords: ["new workspace", "add workspace", "open workspace"],
      run: () => setCreateWorkspaceOpen(true),
    },
    ...(focusedWorkspace
      ? [
          {
            key: "rename-workspace",
            icon: <PanelTop size={15} />,
            title: "Rename workspace",
            detail: workspaceName(focusedWorkspace),
            keywords: ["edit workspace", "workspace name"],
            run: () =>
              setTextAction({
                type: "rename-workspace",
                workspace: focusedWorkspace,
              }),
          },
          {
            key: "close-workspace",
            icon: <X size={15} />,
            title: "Close workspace",
            detail: workspaceName(focusedWorkspace),
            keywords: [
              "delete workspace",
              "remove workspace",
              "close current workspace",
            ],
            danger: true,
            run: () => setPendingCloseWorkspace(focusedWorkspace),
          },
        ]
      : []),
    ...otherWorkspaces.map((workspace) => ({
      key: `focus-workspace-${workspace.workspace_id}`,
      icon: <PanelTop size={15} />,
      title: `Focus workspace: ${workspaceName(workspace)}`,
      detail: workspace.workspace_id,
      keywords: [
        "switch workspace",
        "open workspace",
        workspaceName(workspace),
      ],
      run: () => store.focusWorkspace(workspace.workspace_id),
    })),
  ];

  const worktreeActions: ActionDefinition[] = [];
  for (const workspace of mainWorktreeWorkspaces.filter(
    (workspace) =>
      workspace.workspace_id !== focusedWorktreeSource?.workspace_id,
  )) {
    worktreeActions.push({
      key: `new-worktree-${workspace.workspace_id}`,
      icon: <GitBranch size={15} />,
      title:
        workspace.workspace_id === focusedWorkspace?.workspace_id
          ? "New worktree"
          : `New worktree: ${workspaceName(workspace)}`,
      detail: workspace.worktree?.checkout_path,
      keywords: [
        "create worktree",
        "add worktree",
        "new branch",
        "branch",
        workspaceName(workspace),
        workspace.worktree?.repo_name ?? "",
      ],
      run: () =>
        setTextAction({
          type: "create-worktree",
          workspace,
          branch: luckyWorktreeBranchName(),
        }),
    });
  }
  for (const workspace of allWorkspaces.filter(
    (workspace) =>
      workspace.worktree &&
      workspace.workspace_id !== focusedWorkspace?.workspace_id,
  )) {
    worktreeActions.push({
      key: `open-worktree-${workspace.workspace_id}`,
      icon: <FolderOpen size={15} />,
      title:
        workspace.workspace_id === focusedWorkspace?.workspace_id
          ? "Open worktree"
          : `Open worktree: ${workspaceName(workspace)}`,
      detail: workspace.worktree?.checkout_path,
      keywords: [
        "existing worktree",
        "open existing",
        "checkout",
        "branch",
        workspaceName(workspace),
        workspace.worktree?.repo_name ?? "",
      ],
      run: () => setOpenWorktreeWorkspaceId(workspace.workspace_id),
    });
    worktreeActions.push({
      key: `worktree-hooks-${workspace.workspace_id}`,
      icon: <GitBranch size={15} />,
      title:
        workspace.workspace_id === focusedWorkspace?.workspace_id
          ? "Worktree hooks"
          : `Worktree hooks: ${workspaceName(workspace)}`,
      detail: workspace.worktree?.repo_name,
      keywords: [
        "hook config",
        "hooks config",
        "paseo",
        "setup teardown",
        workspaceName(workspace),
      ],
      run: () => setWorktreeHooksWorkspaceId(workspace.workspace_id),
    });
  }
  const tabActions: ActionDefinition[] = [];
  if (focusedWorkspace) {
    tabActions.push({
      key: "create-tab",
      icon: <PanelTop size={15} />,
      title: "Create tab",
      detail: workspaceName(focusedWorkspace),
      keywords: ["new tab", "add tab", "open tab"],
      disabledReason: endpointCreationReason(
        store.get(),
        "tab.create",
        focusedWorkspace.workspace_id,
      ),
      run: () => store.createTab(focusedWorkspace.workspace_id),
    });
    for (const workspace of otherWorkspaces) {
      tabActions.push({
        key: `create-tab-${workspace.workspace_id}`,
        icon: <PanelTop size={15} />,
        title: `Create tab: ${workspaceName(workspace)}`,
        detail: workspace.workspace_id,
        keywords: ["new tab", "add tab", "open tab", workspaceName(workspace)],
        disabledReason: endpointCreationReason(
          store.get(),
          "tab.create",
          workspace.workspace_id,
        ),
        run: () => store.createTab(workspace.workspace_id),
      });
    }
  }
  if (activeTab) {
    tabActions.push(
      {
        key: "rename-tab",
        icon: <PanelTop size={15} />,
        title: "Rename tab",
        detail: tabName(activeTab),
        keywords: ["edit tab", "tab name"],
        run: () => setTextAction({ type: "rename-tab", tab: activeTab }),
      },
      {
        key: "close-active-tab",
        icon: <X size={15} />,
        title: "Close active tab",
        detail: tabName(activeTab),
        keywords: ["delete tab", "remove tab"],
        danger: true,
        run: () => setPendingCloseTab(activeTab),
      },
    );
  }
  for (const tab of focusedWorkspaceTabs) {
    tabActions.push({
      key: `focus-tab-${tab.tab_id}`,
      icon: <PanelTop size={15} />,
      title: `Focus tab: ${tabName(tab)}`,
      detail: tab.tab_id,
      keywords: ["switch tab", "open tab", "go tab", tabName(tab)],
      run: () => store.focusTab(tab.tab_id),
    });
  }
  for (const tab of focusedWorkspaceTabs.filter(
    (tab) => tab.tab_id !== activeTab?.tab_id,
  )) {
    tabActions.push({
      key: `close-tab-${tab.tab_id}`,
      icon: <X size={15} />,
      title: `Close tab: ${tabName(tab)}`,
      detail: tab.tab_id,
      keywords: ["delete tab", "remove tab", tabName(tab)],
      danger: true,
      run: () => setPendingCloseTab(tab),
    });
  }

  const paneActions: ActionDefinition[] = activePane
    ? [
        {
          key: "focus-pane-left",
          icon: <ArrowLeft size={15} />,
          title: "Focus pane left",
          detail: shortId(activePane.pane_id),
          keywords: ["switch pane left", "select pane left", "move pane left"],
          run: () => store.focusPaneDirection(activePane.pane_id, "left"),
        },
        {
          key: "focus-pane-right",
          icon: <ArrowRight size={15} />,
          title: "Focus pane right",
          detail: shortId(activePane.pane_id),
          keywords: [
            "switch pane right",
            "select pane right",
            "move pane right",
          ],
          run: () => store.focusPaneDirection(activePane.pane_id, "right"),
        },
        {
          key: "focus-pane-up",
          icon: <ArrowUp size={15} />,
          title: "Focus pane up",
          detail: shortId(activePane.pane_id),
          keywords: ["switch pane up", "select pane up", "move pane up"],
          run: () => store.focusPaneDirection(activePane.pane_id, "up"),
        },
        {
          key: "focus-pane-down",
          icon: <ArrowDown size={15} />,
          title: "Focus pane down",
          detail: shortId(activePane.pane_id),
          keywords: ["switch pane down", "select pane down", "move pane down"],
          run: () => store.focusPaneDirection(activePane.pane_id, "down"),
        },
        {
          key: "split-pane-right",
          icon: <SplitSquareHorizontal size={15} />,
          title: "Split pane right",
          detail: shortId(activePane.pane_id),
          keywords: ["new pane right", "create pane right", "vertical split"],
          run: () => store.splitPane(activePane.pane_id, "right"),
        },
        {
          key: "split-pane-down",
          icon: <SplitSquareVertical size={15} />,
          title: "Split pane down",
          detail: shortId(activePane.pane_id),
          keywords: ["new pane down", "create pane down", "horizontal split"],
          run: () => store.splitPane(activePane.pane_id, "down"),
        },
        {
          key: "toggle-pane-zoom",
          icon: <Maximize2 size={15} />,
          title: "Toggle pane zoom",
          detail: shortId(activePane.pane_id),
          keywords: [
            "maximize pane",
            "unmaximize pane",
            "zoom pane",
            "full pane",
          ],
          run: () => store.zoomPane(activePane.pane_id),
        },
        {
          key: "close-pane",
          icon: <X size={15} />,
          title: "Close pane",
          detail: shortId(activePane.pane_id),
          keywords: ["delete pane", "remove pane"],
          danger: true,
          run: () => setPendingClosePane(activePane),
        },
      ]
    : [];

  const agentActions: ActionDefinition[] = [];
  if (activeAgent) {
    agentActions.push({
      key: "close-active-agent-pane",
      icon: <X size={15} />,
      title: "Close active agent pane",
      detail: agentName(activeAgent),
      keywords: ["close agent", "delete agent", "remove agent", "close pane"],
      danger: true,
      run: () => setPendingClosePane(activeAgent),
    });
  }
  for (const pane of agents) {
    agentActions.push({
      key: `focus-agent-${pane.pane_id}`,
      icon: <AgentIcon agent={pane.agent} compact />,
      title: `Focus agent: ${agentName(pane)}`,
      detail: pane.agent_status,
      keywords: [
        "switch agent",
        "open agent",
        "select agent",
        pane.agent ?? "",
      ],
      run: () => store.focusPane(pane.pane_id),
    });
  }

  const actionGroups: ActionGroupDefinition[] = [
    { heading: "Current", actions: currentActions },
    { heading: "Files", actions: fileActions },
    { heading: "Workspaces", actions: workspaceActions },
    { heading: "Worktrees", actions: worktreeActions },
    { heading: "Tabs", actions: tabActions },
    { heading: "Panes", actions: paneActions },
    { heading: "Agents", actions: agentActions },
  ].filter((group) => group.actions.length > 0);

  const normalizedSearch = normalizeSearchText(search);
  const rankedActions = normalizedSearch
    ? (() => {
        const seen = new Set<string>();
        return actionGroups
          .flatMap((group) =>
            group.actions.map((action) => ({
              action,
              group: group.heading,
              score: rankAction(action, search),
            })),
          )
          .filter((entry) => entry.score > 0)
          .sort(
            (a, b) =>
              b.score - a.score ||
              a.group.localeCompare(b.group) ||
              a.action.title.localeCompare(b.action.title),
          )
          .filter((entry) => {
            const signature = actionDisplaySignature(entry.action);
            if (seen.has(signature)) return false;
            seen.add(signature);
            return true;
          })
          .slice(0, 3);
      })()
    : [];
  const topActionKeys = new Set(rankedActions.map((entry) => entry.action.key));
  const displayedSignatures = new Set(
    rankedActions.map((entry) => actionDisplaySignature(entry.action)),
  );
  const displayedActionGroups: ActionGroupDefinition[] = [
    ...(rankedActions.length > 0
      ? [
          {
            heading: rankedActions.length === 1 ? "Top result" : "Top results",
            actions: rankedActions.map((entry) => entry.action),
          },
        ]
      : []),
    ...actionGroups
      .map((group) => ({
        ...group,
        actions: group.actions.filter((action) => {
          if (topActionKeys.has(action.key)) return false;
          if (!normalizedSearch) return true;
          if (rankAction(action, search) <= 0) return false;
          const signature = actionDisplaySignature(action);
          if (displayedSignatures.has(signature)) return false;
          displayedSignatures.add(signature);
          return true;
        }),
      }))
      .filter((group) => group.actions.length > 0),
  ];
  const numberedActions = commandNumberedActions(displayedActionGroups);
  const numberShortcutIndexByKey = new Map(
    numberedActions.map((action, index) => [action.key, index]),
  );
  const firstDisplayedActionValue = displayedActionGroups[0]?.actions[0]
    ? actionCommandValue(displayedActionGroups[0].actions[0])
    : "";
  const displayedActionValues = new Set(
    displayedActionGroups.flatMap((group) =>
      group.actions.map((action) => actionCommandValue(action)),
    ),
  );
  const commandSelectedValue =
    selectedActionSearch === normalizedSearch &&
    selectedActionValue &&
    displayedActionValues.has(selectedActionValue)
      ? selectedActionValue
      : firstDisplayedActionValue;

  useEffect(() => {
    if (!open) {
      setSelectedActionValue("");
      setSelectedActionSearch("");
      return;
    }
    setSelectedActionValue(firstDisplayedActionValue);
    setSelectedActionSearch(normalizedSearch);
  }, [firstDisplayedActionValue, normalizedSearch, open]);

  const setCommandOpen = (next: boolean) => {
    setOpen(next);
    if (!next) setSearch("");
  };

  return (
    <>
      <Popover open={open} onOpenChange={setCommandOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={`topbar-button command-trigger ${open ? "is-active" : ""}`}
            aria-label="Open command menu"
            title={shortcutTitle("Open command menu", "command.menu")}
          >
            <Keyboard size={15} />
            <span>Actions</span>
            <ChevronsUpDown size={14} />
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="command-popover"
          align="end"
          onKeyDownCapture={(event) => {
            runCommandNumberShortcut(
              event,
              numberedActions,
              (action) => !action.disabledReason && run(action.run),
            );
          }}
        >
          <Command
            loop
            shouldFilter={false}
            value={commandSelectedValue}
            onValueChange={(value) => {
              setSelectedActionValue(value);
              setSelectedActionSearch(normalizedSearch);
            }}
          >
            <CommandInput
              value={search}
              onValueChange={setSearch}
              placeholder="Search actions or enter file path..."
            />
            <CommandList>
              <CommandEmpty>No actions found.</CommandEmpty>
              {displayedActionGroups.map((group) => (
                <CommandGroup key={group.heading} heading={group.heading}>
                  {group.actions.map((action) => (
                    <ActionItem
                      key={action.key}
                      value={actionCommandValue(action)}
                      icon={action.icon}
                      title={action.title}
                      detail={action.detail}
                      shortcut={action.shortcut}
                      numberShortcutIndex={numberShortcutIndexByKey.get(
                        action.key,
                      )}
                      keywords={action.keywords}
                      danger={action.danger}
                      disabledReason={action.disabledReason}
                      onSelect={() => {
                        if (!action.disabledReason) run(action.run);
                      }}
                    />
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <CreateWorkspaceDialog
        open={createWorkspaceOpen}
        onClose={() => setCreateWorkspaceOpen(false)}
      />
      <WorktreeOpenDialog
        open={!!openWorktreeWorkspaceId}
        workspaceId={openWorktreeWorkspaceId}
        onClose={() => setOpenWorktreeWorkspaceId(null)}
      />
      <WorktreeHooksDialog
        open={!!worktreeHooksWorkspaceId}
        workspaceId={worktreeHooksWorkspaceId ?? undefined}
        onClose={() => setWorktreeHooksWorkspaceId(null)}
      />
      <WorktreeLifecycleDialog
        open={!!lifecycleWorkspaceId}
        workspaceId={lifecycleWorkspaceId}
        onClose={() => setLifecycleWorkspaceId(null)}
      />
      <ConfirmDialog
        open={!!pendingCloseWorkspace}
        title="Close Workspace"
        message={
          pendingCloseWorkspace
            ? `Close workspace "${workspaceName(pendingCloseWorkspace)}"?${composerDraftWarningFor(
                s.panes
                  .filter(
                    (pane) =>
                      pane.workspace_id === pendingCloseWorkspace.workspace_id,
                  )
                  .map((pane) => pane.pane_id),
              )}`
            : "Close this workspace?"
        }
        confirmLabel="Close"
        danger
        onClose={() => setPendingCloseWorkspace(null)}
        onConfirm={() => {
          if (pendingCloseWorkspace) {
            clearComposerDraftsFor(
              s.panes
                .filter(
                  (pane) =>
                    pane.workspace_id === pendingCloseWorkspace.workspace_id,
                )
                .map((pane) => pane.pane_id),
            );
            store.closeWorkspace(pendingCloseWorkspace.workspace_id);
          }
        }}
      />
      <ConfirmDialog
        open={!!pendingCloseTab}
        title="Close Tab"
        message={
          pendingCloseTab
            ? `Close "${tabName(pendingCloseTab)}"?${composerDraftWarningFor(
                s.panes
                  .filter((pane) => pane.tab_id === pendingCloseTab.tab_id)
                  .map((pane) => pane.pane_id),
              )}`
            : "Close this tab?"
        }
        confirmLabel="Close"
        danger
        onClose={() => setPendingCloseTab(null)}
        onConfirm={() => {
          if (pendingCloseTab) {
            clearComposerDraftsFor(
              s.panes
                .filter((pane) => pane.tab_id === pendingCloseTab.tab_id)
                .map((pane) => pane.pane_id),
            );
            store.closeTab(pendingCloseTab.tab_id);
          }
        }}
      />
      <ConfirmDialog
        open={!!pendingClosePane}
        title="Close Pane"
        message={
          pendingClosePane
            ? `Close pane "${shortId(pendingClosePane.pane_id)}"?${composerDraftWarningFor(
                [pendingClosePane.pane_id],
              )}`
            : "Close this pane?"
        }
        confirmLabel="Close"
        danger
        onClose={() => setPendingClosePane(null)}
        onConfirm={() => {
          if (pendingClosePane) {
            clearComposerDraftsFor([pendingClosePane.pane_id]);
            store.closePane(pendingClosePane.pane_id);
          }
        }}
      />
      <ConfirmDialog
        open={!!pendingRemoveWorktree}
        title="Remove Worktree"
        message={
          pendingRemoveWorktree
            ? `Remove worktree "${workspaceName(pendingRemoveWorktree)}"?`
            : "Remove this worktree?"
        }
        confirmLabel="Remove"
        danger
        onClose={() => setPendingRemoveWorktree(null)}
        onConfirm={() => {
          if (pendingRemoveWorktree) {
            store.removeWorktree(pendingRemoveWorktree.workspace_id, false);
          }
        }}
      />
      {textDialogProps ? (
        <TextInputDialog
          open={!!textAction}
          {...textDialogProps}
          onClose={() => setTextAction(null)}
          onSubmit={submitTextAction}
        />
      ) : null}
    </>
  );
}

function ActionItem({
  value,
  icon,
  title,
  detail,
  shortcut,
  numberShortcutIndex,
  keywords,
  danger,
  onSelect,
  disabledReason,
}: {
  value: string;
  icon: React.ReactNode;
  title: string;
  detail?: string;
  shortcut?: string;
  numberShortcutIndex?: number;
  keywords?: string[];
  danger?: boolean;
  onSelect: () => void;
  disabledReason?: string | null;
}) {
  useShortcutPreferences();
  const id =
    numberShortcutIndex === undefined
      ? null
      : (`command.${numberShortcutIndex + 1}` as `command.${ShortcutNumber}`);
  const numberShortcut = id ? shortcutLabel(id) : null;
  return (
    <CommandItem
      value={value}
      disabled={!!disabledReason}
      title={disabledReason ?? undefined}
      keywords={keywords}
      onSelect={onSelect}
      className={danger ? "is-danger" : undefined}
      aria-keyshortcuts={
        id
          ? getShortcutSnapshot()
              .preset.bindings[id].map((key) => key.replace("Ctrl", "Control"))
              .join(" ") || undefined
          : undefined
      }
    >
      <span className="command-item-icon">{icon}</span>
      <span className="command-item-text">
        <span className="command-item-title">{title}</span>
        {disabledReason || detail ? (
          <span className="command-item-detail">
            {disabledReason ?? detail}
          </span>
        ) : null}
      </span>
      {numberShortcut || shortcut ? (
        <CommandShortcut>{numberShortcut ?? shortcut}</CommandShortcut>
      ) : null}
    </CommandItem>
  );
}

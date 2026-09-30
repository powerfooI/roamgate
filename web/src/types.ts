// Shapes confirmed against a running Herdr 0.7.0 server (protocol 14).

export interface WorktreeInfo {
  repo_key: string;
  repo_name: string;
  repo_root: string;
  checkout_path: string;
  is_linked_worktree: boolean;
  // Added by Roamgate when a linked worktree was created from a specific
  // workspace. Herdr itself currently exposes repository identity only.
  parent_workspace_id?: string;
  gui_settings_key?: string;
  worktree_hooks_enabled?: boolean;
  git_status?: GitStatusSummary;
}

export interface GitStatusSummary {
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  dirty: boolean;
  error?: string;
}

export interface ExistingWorktree {
  path: string;
  branch?: string;
  is_bare: boolean;
  is_detached: boolean;
  is_prunable: boolean;
  is_linked_worktree: boolean;
  open_workspace_id?: string;
  label: string;
}

export interface WorktreeList {
  type: "worktree_list";
  source: {
    repo_key: string;
    repo_name: string;
    repo_root: string;
    source_checkout_path: string;
    source_workspace_id?: string;
  };
  worktrees: ExistingWorktree[];
}

export interface Workspace {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  tab_count: number;
  cwd?: string;
  active_tab_id?: string;
  agent_status: string;
  worktree?: WorktreeInfo;
}

export interface Tab {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  agent_status: string;
}

export interface Pane {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  cwd?: string;
  foreground_cwd?: string;
  agent?: string;
  agent_status: string;
  /** Herdr agent.list state-change sequence, scoped to this server lifetime. */
  state_change_seq?: number;
  /** Session file modification time in epoch milliseconds, from the bridge. */
  last_activity_at?: number;
  revision: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutPane {
  pane_id: string;
  focused: boolean;
  rect: Rect;
}

export interface LayoutSplit {
  id: string;
  direction: "right" | "down";
  ratio: number;
  rect: Rect;
}

export interface PaneLayout {
  workspace_id: string;
  tab_id: string;
  zoomed: boolean;
  area: Rect;
  focused_pane_id: string;
  panes: LayoutPane[];
  splits: LayoutSplit[];
}

export interface PaneRead {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  source: string;
  format: string;
  text: string;
  revision: number;
  truncated: boolean;
}

export interface FileExplorerEntry {
  name: string;
  path: string;
  type: "directory" | "file" | "symlink";
  size: number;
  mtime_ms: number;
  hidden: boolean;
  ignored?: boolean;
}

export interface FileExplorerList {
  workspace_id: string;
  repo_name?: string;
  checkout_path: string;
  root: string;
  path: string;
  entries: FileExplorerEntry[];
  truncated: boolean;
}

export interface FilePreview {
  workspace_id: string;
  repo_name?: string;
  checkout_path: string;
  root: string;
  path: string;
  // Omitted for regular files; "directory" targets have no previewable
  // content and always report a null text.
  type?: "file" | "directory";
  size: number;
  mtime_ms: number;
  text: string | null;
  binary: boolean;
  mime_type?: string;
  image_data_url?: string;
  truncated: boolean;
  resource_revision?: number;
}

export type GitDiffKind =
  | "staged"
  | "unstaged"
  | "untracked"
  | "conflicted"
  | "branch"
  | "last-step";

export interface GitDiffEntry {
  path: string;
  old_path?: string;
  kind: GitDiffKind;
  status: string;
  additions?: number;
  deletions?: number;
  binary?: boolean;
  generated?: boolean;
  mtime_ms?: number;
  size?: number;
}

export interface GitDiffSummary {
  workspace_id: string;
  repo_name?: string;
  root: string;
  mode?: "working" | "branch-main" | "last-step";
  base?: string;
  baseline_available?: boolean;
  snapshot_id?: string;
  entries: GitDiffEntry[];
  counts: Record<GitDiffKind, number>;
}

export interface GitDiffFile {
  workspace_id: string;
  root: string;
  path: string;
  kind: GitDiffKind;
  diff: string;
  truncated: boolean;
}

// Raw list responses
export interface WorkspaceList {
  type: "workspace_list";
  /** Studio bridge metadata, absent on older bridges (shared navigation). */
  navigation_mode?: "browser-local" | "shared";
  workspaces: Workspace[];
}
export interface TabList {
  type: "tab_list";
  tabs: Tab[];
}
export interface PaneList {
  type: "pane_list";
  panes: Pane[];
}

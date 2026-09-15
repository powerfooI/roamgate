import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Workspace } from "../types";
import { store, useStoreSelector } from "../store";
import {
  clearTerminalComposerDrafts,
  terminalComposerCloseWarning,
  terminalComposerDraftPaneIds,
} from "../terminalComposer";
import { luckyWorktreeBranchName } from "../luckyName";
import { ConfirmDialog, TextInputDialog } from "./ModalDialogs";
import { WorktreeHooksDialog } from "./WorktreeHooksDialog";
import { WorktreeOpenDialog } from "./WorktreeOpenDialog";
import { WorkspaceAutoSyncDialog } from "./WorkspaceAutoSyncDialog";
import { worktreeCreationSource } from "../worktree";
import { WorktreeLifecycleDialog } from "./WorktreeLifecycleDialog";
import { isWorkspacePinned } from "../workspacePins";
import { workspaceDisplayName } from "../workspaceTreeBadges";
import { copyTextFromUserGesture } from "../terminalClipboard";
import { observeClampedContextMenu } from "./contextMenuPosition";
import "./ContextMenu.css";

export interface ContextMenuState {
  x: number;
  y: number;
  workspace: Workspace;
}

interface Item {
  label: string;
  danger?: boolean;
  action: () => void;
}

interface ItemGroup {
  label: string;
  items: Item[];
  danger?: boolean;
}

type DialogState =
  | {
      type: "new-worktree";
      workspaceId: string;
      branch: string;
    }
  | {
      type: "rename-workspace";
      workspaceId: string;
      label: string;
    }
  | {
      type: "remove-worktree";
      workspaceId: string;
      label: string;
    }
  | {
      type: "close-workspace";
      workspaceId: string;
      label: string;
    };

export function ContextMenu({
  state,
  pinnedWorkspaceKeys,
  onPinnedChange,
  onBrowseFiles,
  onReviewChanges,
  onClose,
}: {
  state: ContextMenuState | null;
  pinnedWorkspaceKeys: ReadonlySet<string>;
  onPinnedChange: (workspace: Workspace, pinned: boolean) => void;
  onBrowseFiles?: (workspace: Workspace) => void;
  onReviewChanges?: (workspace: Workspace) => void;
  onClose: () => void;
}) {
  const workspaces = useStoreSelector((state) => state.workspaces);
  const activeConnectionId = useStoreSelector(
    (state) => state.activeConnectionId,
  );
  const connectionGeneration = useStoreSelector(
    (state) => state.connectionGeneration,
  );
  const panes = useStoreSelector((state) => state.panes);
  const ref = useRef<HTMLDivElement>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [openWorktreeWorkspaceId, setOpenWorktreeWorkspaceId] = useState<
    string | null
  >(null);
  const [worktreeHooksWorkspaceId, setWorktreeHooksWorkspaceId] = useState<
    string | null
  >(null);
  const [autoSyncWorkspaceId, setAutoSyncWorkspaceId] = useState<string | null>(
    null,
  );
  const [lifecycleWorkspaceId, setLifecycleWorkspaceId] = useState<
    string | null
  >(null);

  useEffect(() => {
    if (!state) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onScroll = (e: Event) => {
      const target = e.target;
      if (target instanceof Node && ref.current?.contains(target)) return;
      onClose();
    };
    // Defer so the triggering contextmenu event doesn't immediately close it.
    const t = setTimeout(() => {
      window.addEventListener("mousedown", onDown);
      window.addEventListener("keydown", onKey);
      window.addEventListener("scroll", onScroll, true);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [state, onClose]);

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!state || !menu) return;
    return observeClampedContextMenu(menu, {
      left: state.x,
      top: state.y,
    });
  }, [state]);

  const dialogs = (
    <>
      <TextInputDialog
        open={dialog?.type === "new-worktree"}
        title="New Worktree"
        label="Branch"
        initialValue={dialog?.type === "new-worktree" ? dialog.branch : ""}
        placeholder="Branch name"
        submitLabel="Create"
        onClose={() => setDialog(null)}
        onSubmit={(branch) => {
          const value = branch.trim();
          if (dialog?.type === "new-worktree" && value) {
            store.createWorktree(dialog.workspaceId, value);
            setDialog(null);
          }
        }}
      />
      <TextInputDialog
        open={dialog?.type === "rename-workspace"}
        title="Rename Workspace"
        label="Name"
        initialValue={dialog?.type === "rename-workspace" ? dialog.label : ""}
        submitLabel="Rename"
        onClose={() => setDialog(null)}
        onSubmit={(label) => {
          const value = label.trim();
          if (dialog?.type === "rename-workspace" && value) {
            if (value !== dialog.label) {
              store.renameWorkspace(dialog.workspaceId, value);
            }
            setDialog(null);
          }
        }}
      />
      <ConfirmDialog
        open={dialog?.type === "remove-worktree"}
        title="Remove Worktree"
        message={
          dialog?.type === "remove-worktree"
            ? `Remove worktree "${dialog.label}"?`
            : ""
        }
        confirmLabel="Remove"
        danger
        onClose={() => setDialog(null)}
        onConfirm={() => {
          if (dialog?.type === "remove-worktree") {
            store.removeWorktree(dialog.workspaceId, false);
          }
        }}
      />
      <ConfirmDialog
        open={dialog?.type === "close-workspace"}
        title="Close Workspace"
        message={
          dialog?.type === "close-workspace"
            ? `Close workspace "${dialog.label}"?${terminalComposerCloseWarning(
                terminalComposerDraftPaneIds(
                  activeConnectionId,
                  connectionGeneration,
                  panes
                    .filter((pane) => pane.workspace_id === dialog.workspaceId)
                    .map((pane) => pane.pane_id),
                ).length,
              )}`
            : ""
        }
        confirmLabel="Close"
        danger
        onClose={() => setDialog(null)}
        onConfirm={() => {
          if (dialog?.type === "close-workspace") {
            clearTerminalComposerDrafts(
              activeConnectionId,
              connectionGeneration,
              panes
                .filter((pane) => pane.workspace_id === dialog.workspaceId)
                .map((pane) => pane.pane_id),
            );
            store.closeWorkspace(dialog.workspaceId);
          }
        }}
      />
    </>
  );

  const openWorktreeDialog = (
    <WorktreeOpenDialog
      open={!!openWorktreeWorkspaceId}
      workspaceId={openWorktreeWorkspaceId}
      onClose={() => setOpenWorktreeWorkspaceId(null)}
    />
  );
  const worktreeHooksDialog = (
    <WorktreeHooksDialog
      open={!!worktreeHooksWorkspaceId}
      workspaceId={worktreeHooksWorkspaceId ?? undefined}
      onClose={() => setWorktreeHooksWorkspaceId(null)}
    />
  );
  const autoSyncDialog = (
    <WorkspaceAutoSyncDialog
      open={!!autoSyncWorkspaceId}
      workspaceId={autoSyncWorkspaceId ?? undefined}
      onClose={() => setAutoSyncWorkspaceId(null)}
    />
  );
  const lifecycleDialog = (
    <WorktreeLifecycleDialog
      open={!!lifecycleWorkspaceId}
      workspaceId={lifecycleWorkspaceId}
      onClose={() => setLifecycleWorkspaceId(null)}
    />
  );
  if (!state) {
    return (
      <>
        {dialogs}
        {openWorktreeDialog}
        {worktreeHooksDialog}
        {autoSyncDialog}
        {lifecycleDialog}
      </>
    );
  }
  const w =
    workspaces.find(
      (workspace) => workspace.workspace_id === state.workspace.workspace_id,
    ) ?? state.workspace;
  const isLinked = !!w.worktree?.is_linked_worktree;
  const displayName = workspaceDisplayName(w);
  const pinned = isWorkspacePinned(pinnedWorkspaceKeys, w);
  const creationSource = worktreeCreationSource(workspaces, w);

  const inspectItems: Item[] = [
    {
      label: "Browse files",
      action: () => onBrowseFiles?.(w),
    },
    {
      label: "Review changes",
      action: () => onReviewChanges?.(w),
    },
  ];
  const organizeItems: Item[] = [
    {
      label: `${pinned ? "Unpin" : "Pin"} ${isLinked ? "worktree" : "workspace"}`,
      action: () => onPinnedChange(w, !pinned),
    },
    {
      label: "Rename workspace…",
      action: () => {
        setDialog({
          type: "rename-workspace",
          workspaceId: w.workspace_id,
          label: w.label,
        });
      },
    },
  ];
  const worktreeItems: Item[] = [];
  if (w.worktree) {
    organizeItems.push({
      label: "Copy checkout path",
      action: () => {
        const path = w.worktree?.checkout_path;
        if (!path) return;
        void copyTextFromUserGesture(path).then(
          () =>
            store.notify({
              kind: "success",
              message: "Checkout path copied",
              detail: path,
              autoDismissMs: 5000,
            }),
          (error) =>
            store.notify({
              kind: "error",
              message: "Failed to copy checkout path",
              detail: error instanceof Error ? error.message : String(error),
            }),
        );
      },
    });
    worktreeItems.push(
      {
        label: "Open worktree…",
        action: () => setOpenWorktreeWorkspaceId(w.workspace_id),
      },
      {
        label: "Worktree lifecycle…",
        action: () => setLifecycleWorkspaceId(w.workspace_id),
      },
      {
        label: "Configure worktree hooks…",
        action: () => setWorktreeHooksWorkspaceId(w.workspace_id),
      },
    );
  }
  if (creationSource) {
    worktreeItems.unshift({
      label: "New worktree…",
      action: () => {
        setDialog({
          type: "new-worktree",
          workspaceId: creationSource.workspace_id,
          branch: luckyWorktreeBranchName(),
        });
      },
    });
  }
  const sourceControlItems: Item[] = [
    {
      label: "Pull from Git",
      action: () => {
        void store.gitPullWorkspace(w.workspace_id);
      },
    },
    {
      label: "Configure branch auto-update…",
      action: () => setAutoSyncWorkspaceId(w.workspace_id),
    },
  ];
  const closeItems: Item[] = [];
  if (isLinked) {
    closeItems.push({
      label: "Remove worktree",
      danger: true,
      action: () => {
        setDialog({
          type: "remove-worktree",
          workspaceId: w.workspace_id,
          label: w.label,
        });
      },
    });
  }
  closeItems.push({
    label: "Close workspace",
    danger: true,
    action: () => {
      setDialog({
        type: "close-workspace",
        workspaceId: w.workspace_id,
        label: w.label,
      });
    },
  });
  const groups: ItemGroup[] = [
    { label: "Inspect", items: inspectItems },
    { label: "Organize", items: organizeItems },
    { label: "Worktrees", items: worktreeItems },
    { label: "Source control", items: sourceControlItems },
    { label: "Close", items: closeItems, danger: true },
  ].filter((group) => group.items.length > 0);

  const style: React.CSSProperties = {
    position: "fixed",
    left: state.x,
    top: state.y,
    zIndex: 1000,
  };

  return (
    <>
      <div
        ref={ref}
        className="context-menu context-menu--grouped"
        style={style}
      >
        <div className="context-menu-header">
          <span>Workspace</span>
          <strong title={displayName}>{displayName}</strong>
          <small>
            {isLinked
              ? "Linked worktree"
              : w.worktree
                ? "Git workspace"
                : "Workspace"}
          </small>
        </div>
        {groups.map((group) => (
          <div
            key={group.label}
            className={`context-menu-group ${group.danger ? "is-danger" : ""}`}
          >
            <div className="context-menu-group-title">{group.label}</div>
            {group.items.map((item) => (
              <button
                key={item.label}
                className={`context-menu-item ${item.danger ? "is-danger" : ""}`}
                onClick={() => {
                  onClose();
                  item.action();
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        ))}
      </div>
      {dialogs}
      {openWorktreeDialog}
      {worktreeHooksDialog}
      {autoSyncDialog}
      {lifecycleDialog}
    </>
  );
}

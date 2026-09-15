import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FolderOpen, GitBranch, RefreshCw, Settings } from "lucide-react";
import { luckyWorktreeBranchName } from "../luckyName";
import { useConnectionClient } from "../useConnectionClient";
import { store, useStoreSelector } from "../store";
import type { Workspace, WorktreeList } from "../types";
import { resolveWorktreeOpenSource, worktreeCreationSource } from "../worktree";
import {
  type InspectorView,
  WORKSPACE_INSPECTOR_REQUEST_EVENT,
  type WorkspaceInspectorRequest,
} from "../workspaceResource";
import {
  buildWorktreeLifecycleRows,
  lifecycleActionError,
  lifecycleActionWarning,
  lifecycleGitChangeCount,
  lifecycleOpenedWorkspaceId,
  lifecycleWorktreeTitle,
  removeTemporaryWorkspaceSafely,
  type WorkspaceAutoSyncInfo,
  type WorktreeHookInfo,
  type WorktreeLifecycleRow,
} from "../worktreeLifecycle";
import { CloseButton } from "./CloseButton";
import { ConfirmDialog, TextInputDialog } from "./ModalDialogs";
import { WorktreeHooksDialog } from "./WorktreeHooksDialog";
import { WorktreeOpenDialog } from "./WorktreeOpenDialog";
import { WorktreeLifecycleRow as WorktreeLifecycleRowItem } from "./WorktreeLifecycleRow";
import { focusDialogElement } from "./dialogFocus";
import "./WorktreeLifecycleDialog.css";

type LifecycleOperation = {
  key: string;
  label: string;
  status: "running" | "succeeded" | "warning" | "failed";
  detail?: string;
};

function removalWorkspaceHint(
  result: unknown,
  row: WorktreeLifecycleRow,
  list: WorktreeList | null,
  workspaceId: string,
): Workspace {
  const openedValue =
    result && typeof result === "object" && "workspace" in result
      ? (result as { workspace?: unknown }).workspace
      : undefined;
  const opened =
    openedValue && typeof openedValue === "object"
      ? (openedValue as Partial<Workspace>)
      : undefined;
  const source = list?.source;
  const fallbackWorktree = source
    ? {
        repo_key: source.repo_key,
        repo_name: source.repo_name,
        repo_root: source.repo_root,
        checkout_path: row.worktree.path,
        is_linked_worktree: row.worktree.is_linked_worktree,
      }
    : undefined;
  return {
    workspace_id: workspaceId,
    number: typeof opened?.number === "number" ? opened.number : 0,
    label: opened?.label || row.worktree.label || workspaceId,
    focused: opened?.focused === true,
    pane_count: typeof opened?.pane_count === "number" ? opened.pane_count : 0,
    tab_count: typeof opened?.tab_count === "number" ? opened.tab_count : 0,
    agent_status: opened?.agent_status || "unknown",
    ...(opened?.cwd ? { cwd: opened.cwd } : {}),
    ...(opened?.active_tab_id ? { active_tab_id: opened.active_tab_id } : {}),
    ...(fallbackWorktree || opened?.worktree
      ? { worktree: { ...fallbackWorktree!, ...opened?.worktree } }
      : {}),
  };
}

export function WorktreeLifecycleDialog({
  open,
  workspaceId,
  onClose,
}: {
  open: boolean;
  workspaceId?: string | null;
  onClose: () => void;
}) {
  const workspaces = useStoreSelector((state) => state.workspaces);
  const connectionClient = useConnectionClient();
  const selectedWorkspace = workspaces.find(
    (workspace) => workspace.workspace_id === workspaceId,
  );
  const actionSourceWorkspace = selectedWorkspace
    ? worktreeCreationSource(workspaces, selectedWorkspace)
    : undefined;
  // Listing and repository settings accept linked workspaces. Creating or
  // opening a worktree does not, so keep those two contexts independent.
  const repositoryWorkspaceId = selectedWorkspace?.workspace_id ?? workspaceId;
  const actionSourceWorkspaceId = actionSourceWorkspace?.workspace_id;
  const [listResult, setListResult] = useState<{
    workspaceId: string;
    list: WorktreeList;
  } | null>(null);
  const [hooks, setHooks] = useState<WorktreeHookInfo | null>(null);
  const [autoSync, setAutoSync] = useState<
    Record<string, WorkspaceAutoSyncInfo>
  >({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [operation, setOperation] = useState<LifecycleOperation | null>(null);
  const [newWorktreeOpen, setNewWorktreeOpen] = useState(false);
  const [newWorktreeBranch, setNewWorktreeBranch] = useState("");
  const [openWorktreeOpen, setOpenWorktreeOpen] = useState(false);
  const [hooksOpen, setHooksOpen] = useState(false);
  const [removeRow, setRemoveRow] = useState<WorktreeLifecycleRow | null>(null);
  const requestId = useRef(0);
  const inFlightLoad = useRef<{
    workspaceId: string;
    promise: Promise<void>;
  } | null>(null);
  const operationRunningRef = useRef(false);
  const operationIdRef = useRef(0);
  const dialogRef = useRef<HTMLDivElement>(null);

  const load = useCallback(
    async (showLoading: boolean, force = false) => {
      if (!repositoryWorkspaceId) return;
      const existingLoad = inFlightLoad.current;
      if (!force && existingLoad?.workspaceId === repositoryWorkspaceId) {
        if (showLoading) setLoading(true);
        await existingLoad.promise;
        return;
      }
      const currentRequest = ++requestId.current;
      if (showLoading) setLoading(true);
      const promise = (async () => {
        try {
          const worktreeList = (await connectionClient.call("worktree.list", {
            workspace_id: repositoryWorkspaceId,
          })) as WorktreeList;
          if (!connectionClient.isCurrent()) return;
          const repoWorkspaces = store
            .get()
            .workspaces.filter(
              (workspace) =>
                workspace.worktree?.repo_key === worktreeList.source.repo_key,
            );
          const [hookResult, ...syncResults] = await Promise.all([
            connectionClient
              .call("settings.worktree_hooks.get", {
                workspace_id: repositoryWorkspaceId,
              })
              .catch((hookError) => ({
                key: null,
                enabled: true,
                error: (hookError as Error).message,
              })),
            ...repoWorkspaces.map((workspace) =>
              connectionClient
                .call("settings.workspace_auto_sync.get", {
                  workspace_id: workspace.workspace_id,
                })
                .catch(() => null),
            ),
          ]);
          if (
            !connectionClient.isCurrent() ||
            currentRequest !== requestId.current
          ) {
            return;
          }
          const syncByWorkspace: Record<string, WorkspaceAutoSyncInfo> = {};
          for (const result of syncResults) {
            if (!result || typeof result.workspace_id !== "string") continue;
            syncByWorkspace[result.workspace_id] =
              result as WorkspaceAutoSyncInfo;
          }
          setListResult({
            workspaceId: repositoryWorkspaceId,
            list: worktreeList,
          });
          setHooks(hookResult as WorktreeHookInfo);
          setAutoSync(syncByWorkspace);
          setError("");
        } catch (loadError) {
          if (
            connectionClient.isCurrent() &&
            currentRequest === requestId.current
          ) {
            setError((loadError as Error).message);
          }
        } finally {
          if (
            connectionClient.isCurrent() &&
            currentRequest === requestId.current
          ) {
            setLoading(false);
          }
        }
      })();
      inFlightLoad.current = {
        workspaceId: repositoryWorkspaceId,
        promise,
      };
      try {
        await promise;
      } finally {
        if (inFlightLoad.current?.promise === promise) {
          inFlightLoad.current = null;
        }
      }
    },
    [connectionClient, repositoryWorkspaceId],
  );

  useEffect(() => {
    if (!open || !repositoryWorkspaceId) return;
    setListResult(null);
    setHooks(null);
    setAutoSync({});
    setError("");
    setOperation(null);
    operationIdRef.current += 1;
    operationRunningRef.current = false;
    void load(true, true);
    const timer = window.setInterval(() => void load(false), 5_000);
    return () => {
      window.clearInterval(timer);
      requestId.current += 1;
      operationIdRef.current += 1;
      operationRunningRef.current = false;
      inFlightLoad.current = null;
    };
  }, [load, open, repositoryWorkspaceId]);

  const list =
    listResult && listResult.workspaceId === repositoryWorkspaceId
      ? listResult.list
      : null;
  const repositoryLoading =
    loading || (!!open && !!repositoryWorkspaceId && !list);

  useEffect(() => {
    if (!open) return;
    if (newWorktreeOpen || openWorktreeOpen || hooksOpen || removeRow) return;
    const cancelFocus = focusDialogElement(dialogRef.current);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      cancelFocus();
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [hooksOpen, newWorktreeOpen, onClose, open, openWorktreeOpen, removeRow]);

  const rows = useMemo(
    () => (list ? buildWorktreeLifecycleRows(list, workspaces) : []),
    [list, workspaces],
  );
  const configuredHooks = hooks?.hooks
    ? Object.values(hooks.hooks).filter(Boolean).length
    : 0;
  const openCount = rows.filter((row) => row.workspace).length;
  const changedCount = rows.filter(
    (row) => lifecycleGitChangeCount(row.gitStatus) > 0,
  ).length;
  const operationRunning = operation?.status === "running";

  const runOperation = async (
    key: string,
    label: string,
    action: () => Promise<unknown>,
  ) => {
    if (operationRunningRef.current || !connectionClient.isCurrent()) return;
    const operationId = ++operationIdRef.current;
    const operationIsCurrent = () =>
      connectionClient.isCurrent() && operationIdRef.current === operationId;
    operationRunningRef.current = true;
    setOperation({ key, label, status: "running" });
    try {
      const result = await action();
      if (!operationIsCurrent()) return;
      if (result === undefined) {
        await store.refresh();
        if (!operationIsCurrent()) return;
        await load(false, true);
        if (!operationIsCurrent()) return;
        setOperation({
          key,
          label,
          status: "failed",
          detail: store.get().error ?? `${label} failed`,
        });
        return;
      }
      await store.refresh();
      if (!operationIsCurrent()) return;
      await load(false, true);
      if (!operationIsCurrent()) return;
      const actionError = lifecycleActionError(result);
      const actionWarning = lifecycleActionWarning(result);
      setOperation({
        key,
        label,
        status: actionError
          ? "failed"
          : actionWarning
            ? "warning"
            : "succeeded",
        detail: actionError ?? actionWarning,
      });
    } catch (actionError) {
      if (!operationIsCurrent()) return;
      await store.refresh().catch(() => undefined);
      if (!operationIsCurrent()) return;
      await load(false, true).catch(() => undefined);
      if (!operationIsCurrent()) return;
      setOperation({
        key,
        label,
        status: "failed",
        detail: (actionError as Error).message,
      });
    } finally {
      if (operationIdRef.current === operationId) {
        operationRunningRef.current = false;
      }
    }
  };

  if (!open) return null;

  const createWorktree = (branch: string) => {
    const value = branch.trim();
    if (!value || !actionSourceWorkspaceId) return;
    setNewWorktreeOpen(false);
    void runOperation("create", `Creating ${value}`, () =>
      store.createWorktree(actionSourceWorkspaceId, value),
    );
  };

  const setHooksEnabled = (enabled: boolean) => {
    if (!hooks?.key) return;
    void runOperation("hooks", "Updating hook policy", () =>
      store.setRepoWorktreeHooksEnabled(hooks.key!, enabled),
    );
  };

  const openWorktree = (row: WorktreeLifecycleRow, focus = true) => {
    const openSource = resolveWorktreeOpenSource(
      list,
      actionSourceWorkspaceId ?? null,
    );
    if (openSource?.workspaceId) {
      return store.openWorktree(
        openSource.workspaceId,
        row.worktree.path,
        focus,
      );
    }
    if (!openSource?.cwd) {
      throw new Error("The repository root is unavailable.");
    }
    return store.openWorktreeFromCwd(openSource.cwd, row.worktree.path, focus);
  };

  const openWorktreeResource = async (
    row: WorktreeLifecycleRow,
    view: InspectorView,
  ) => {
    const result = await openWorktree(row, true);
    const targetWorkspaceId = lifecycleOpenedWorkspaceId(result);
    if (!targetWorkspaceId) {
      throw new Error(
        "Herdr opened the checkout without returning a workspace ID.",
      );
    }
    window.dispatchEvent(
      new CustomEvent<WorkspaceInspectorRequest>(
        WORKSPACE_INSPECTOR_REQUEST_EVENT,
        {
          detail: {
            connectionId: connectionClient.connectionId,
            generation: connectionClient.generation,
            workspaceId: targetWorkspaceId,
            view,
          },
        },
      ),
    );
    window.setTimeout(onClose, 0);
    return result;
  };

  const removeWorktree = async (row: WorktreeLifecycleRow) => {
    let targetWorkspaceId = row.workspace?.workspace_id;
    let workspaceHint = row.workspace;
    let temporaryWorkspace = false;
    if (!targetWorkspaceId) {
      const opened = await openWorktree(row, false);
      targetWorkspaceId = lifecycleOpenedWorkspaceId(opened);
      if (!targetWorkspaceId) {
        throw new Error(
          "Herdr opened the checkout without returning a workspace ID.",
        );
      }
      workspaceHint = removalWorkspaceHint(
        opened,
        row,
        list,
        targetWorkspaceId,
      );
      temporaryWorkspace = true;
    }

    return removeTemporaryWorkspaceSafely({
      workspaceId: targetWorkspaceId,
      temporary: temporaryWorkspace,
      remove: () =>
        store.removeWorktree(targetWorkspaceId, false, workspaceHint),
      close: async (workspaceId) => {
        if (!connectionClient.isCurrent()) {
          throw new Error(
            "Connection changed before the temporary workspace could be closed.",
          );
        }
        await store.closeWorkspace(workspaceId);
      },
    });
  };

  return createPortal(
    <>
      <div className="modal-backdrop" onMouseDown={onClose}>
        <div
          ref={dialogRef}
          className="modal worktree-lifecycle-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Worktree lifecycle"
          tabIndex={-1}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="modal-head lifecycle-head">
            <div>
              <span className="lifecycle-kicker">Repository operations</span>
              <h2>Worktree Lifecycle</h2>
              <p>
                {list?.source.repo_name ??
                  selectedWorkspace?.worktree?.repo_name ??
                  "Repository"}
                <code title={list?.source.repo_root}>
                  {list?.source.repo_root ??
                    selectedWorkspace?.worktree?.repo_root ??
                    ""}
                </code>
              </p>
            </div>
            <div className="lifecycle-head-actions">
              <button
                type="button"
                className="ghost lifecycle-icon-button"
                aria-label="Refresh lifecycle status"
                title="Refresh"
                disabled={repositoryLoading || operationRunning}
                onClick={() => void load(true, true)}
              >
                <RefreshCw
                  size={16}
                  className={repositoryLoading ? "is-spinning" : ""}
                />
              </button>
              <CloseButton onClick={onClose} />
            </div>
          </div>

          <div className="lifecycle-toolbar">
            <button
              type="button"
              title={
                actionSourceWorkspaceId
                  ? "Create a linked worktree"
                  : "Open this repository's main checkout before creating a worktree"
              }
              disabled={!actionSourceWorkspaceId || operationRunning}
              onClick={() => {
                setNewWorktreeBranch(luckyWorktreeBranchName());
                setNewWorktreeOpen(true);
              }}
            >
              <GitBranch size={15} />
              New worktree
            </button>
            <button
              type="button"
              className="ghost"
              title="Open an existing checkout"
              disabled={!repositoryWorkspaceId || operationRunning}
              onClick={() => setOpenWorktreeOpen(true)}
            >
              <FolderOpen size={15} />
              Open existing
            </button>
            <button
              type="button"
              className="ghost"
              disabled={!repositoryWorkspaceId}
              onClick={() => setHooksOpen(true)}
            >
              <Settings size={15} />
              Hook details
            </button>
          </div>

          {operation ? (
            <div
              className={`lifecycle-operation is-${operation.status}`}
              role={operation.status === "failed" ? "alert" : "status"}
            >
              {operation.status === "running" ? (
                <span className="hook-loading-mark" />
              ) : (
                <span className="lifecycle-operation-mark" />
              )}
              <div>
                <strong>{operation.label}</strong>
                <span>
                  {operation.detail ??
                    (operation.status === "running"
                      ? "Waiting for Herdr and repository hooks."
                      : operation.status === "succeeded"
                        ? "Repository state refreshed."
                        : "Operation failed.")}
                </span>
              </div>
            </div>
          ) : null}

          {repositoryLoading && !list ? (
            <div className="lifecycle-loading" role="status">
              <span className="hook-loading-mark" />
              <span>Loading repository lifecycle...</span>
            </div>
          ) : error && !list ? (
            <div className="lifecycle-empty is-error">
              <strong>Repository lifecycle unavailable</strong>
              <span>{error}</span>
              <button type="button" onClick={() => void load(true, true)}>
                Retry
              </button>
            </div>
          ) : (
            <div className="lifecycle-content">
              <div
                className="lifecycle-overview"
                aria-label="Repository summary"
              >
                <div>
                  <strong>{rows.length}</strong>
                  <span>Checkouts</span>
                </div>
                <div>
                  <strong>{openCount}</strong>
                  <span>Open</span>
                </div>
                <div>
                  <strong>{changedCount}</strong>
                  <span>With changes</span>
                </div>
              </div>

              <section className="lifecycle-policy">
                <div className="lifecycle-policy-main">
                  <span className="lifecycle-policy-icon">
                    <Settings size={16} />
                  </span>
                  <div>
                    <strong>Repository hooks</strong>
                    <span>
                      {hooks?.error
                        ? hooks.error
                        : hooks?.paseo_path
                          ? `${configuredHooks} configured in paseo.json`
                          : "No paseo.json worktree hooks found"}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-label="Enable worktree hooks for this repository"
                  aria-checked={hooks?.enabled ?? true}
                  className={`settings-switch ${hooks?.enabled ? "is-on" : ""}`}
                  disabled={!hooks?.key || operationRunning}
                  onClick={() => setHooksEnabled(!(hooks?.enabled ?? true))}
                >
                  <span />
                </button>
              </section>

              {error ? <p className="modal-error">{error}</p> : null}
              <div className="lifecycle-list" role="list">
                {rows.map((row) => {
                  const workspaceIdForRow = row.workspace?.workspace_id;
                  const syncInfo = workspaceIdForRow
                    ? autoSync[workspaceIdForRow]
                    : undefined;
                  const rowKey = row.worktree.path;
                  return (
                    <WorktreeLifecycleRowItem
                      key={rowKey}
                      row={row}
                      syncInfo={syncInfo}
                      operationRunning={operationRunning}
                      rowBusy={
                        operation?.status === "running" &&
                        operation.key === rowKey
                      }
                      runOperation={(key, label, action) => {
                        void runOperation(key, label, action);
                      }}
                      onFocus={(targetWorkspaceId) => {
                        void store.focusWorkspace(targetWorkspaceId);
                        onClose();
                      }}
                      onOpen={(targetRow) => openWorktree(targetRow)}
                      onOpenResource={openWorktreeResource}
                      onRemove={setRemoveRow}
                    />
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      <TextInputDialog
        open={newWorktreeOpen}
        title="New Worktree"
        label="Branch"
        initialValue={newWorktreeBranch}
        placeholder="Branch name"
        submitLabel="Create"
        onClose={() => setNewWorktreeOpen(false)}
        onSubmit={createWorktree}
      />
      <WorktreeOpenDialog
        open={openWorktreeOpen}
        workspaceId={repositoryWorkspaceId ?? null}
        sourceWorkspaceId={actionSourceWorkspaceId ?? null}
        sourceCwd={list?.source.repo_root ?? null}
        onClose={() => {
          setOpenWorktreeOpen(false);
          void store.refresh().then(() => load(false, true));
        }}
      />
      <WorktreeHooksDialog
        open={hooksOpen}
        workspaceId={repositoryWorkspaceId ?? undefined}
        onClose={() => {
          setHooksOpen(false);
          void load(false, true);
        }}
      />
      <ConfirmDialog
        open={!!removeRow}
        title="Remove Worktree"
        message={
          removeRow
            ? removeRow.workspace
              ? `Remove worktree "${lifecycleWorktreeTitle(removeRow.worktree)}"? The teardown hook will run before removal.`
              : `Remove closed worktree "${lifecycleWorktreeTitle(removeRow.worktree)}"? It will be opened in the background so Herdr can run the teardown and removed hooks.`
            : "Remove this worktree?"
        }
        confirmLabel="Remove"
        danger
        onClose={() => setRemoveRow(null)}
        onConfirm={() => {
          const row = removeRow;
          setRemoveRow(null);
          if (!row) return;
          void runOperation(row.worktree.path, "Removing worktree", () =>
            removeWorktree(row),
          );
        }}
      />
    </>,
    document.body,
  );
}

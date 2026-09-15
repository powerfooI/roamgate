import {
  ChevronLeft,
  FileDiff,
  FolderTree,
  GitFork,
  History,
  Maximize2,
  Minimize2,
  PanelBottom,
  PanelRight,
  X,
} from "lucide-react";
import {
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { ConnectionClient } from "../api";
import { roamgateLocalStorage } from "../browserStorage";
import {
  type NewReviewAnnotation,
  type ReviewAnnotation,
} from "../annotations";
import { lazyWithReload } from "../lazyWithReload";
import type { GitDiffEntry, Pane, Workspace } from "../types";
import {
  DEFAULT_INSPECTOR_NAVIGATION_RATIO,
  inspectorNavigationRatioAtPosition,
  readInspectorPreferences,
  resourceOwnerKey,
  resourceStateKey,
  writeInspectorNavigationRatio,
  type InspectorDock,
  type InspectorSplitView,
  type InspectorView,
  type WorkspaceInspectorState,
} from "../workspaceResource";
import { AgentHistoryDrawer } from "./AgentHistoryDrawer";
import { paneHasAgentHistory } from "./agentSession";
import {
  type ActiveDiffSelection,
  DiffViewerPanel,
  type DiffViewerPanelHandle,
  type DiffViewerPanelProps,
} from "./DiffViewerPanel";
import { FileExplorerPanel } from "./FileExplorerDialog";
import {
  type ActiveFilePreviewSelection,
  FilePreviewContent,
} from "./FilePreviewContent";
import { workspaceInspectorLayout } from "./workspaceInspectorLayout";
import "./WorkspaceInspectorHost.css";

const DiffContentView = lazyWithReload("diff-content-view", () =>
  import("./DiffContentView").then((module) => ({
    default: module.DiffContentView,
  })),
);

function changedCount(workspace?: Workspace) {
  const status = workspace?.worktree?.git_status;
  return status
    ? status.staged + status.unstaged + status.untracked + status.conflicted
    : 0;
}

function checkoutLabel(workspace?: Workspace) {
  if (!workspace) return "Unavailable checkout";
  return (
    workspace.worktree?.git_status?.branch ||
    workspace.worktree?.repo_name ||
    workspace.label ||
    workspace.workspace_id
  );
}

const INSPECTOR_RESOURCE_HORIZONTAL_PADDING = 16;

function navigationRatioForPointer(
  event: Pick<ReactPointerEvent<HTMLDivElement>, "clientX" | "currentTarget">,
) {
  const resource = event.currentTarget.parentElement;
  if (!resource) return DEFAULT_INSPECTOR_NAVIGATION_RATIO;
  const bounds = resource.getBoundingClientRect();
  return inspectorNavigationRatioAtPosition(
    event.clientX - bounds.left - INSPECTOR_RESOURCE_HORIZONTAL_PADDING / 2,
    bounds.width - INSPECTOR_RESOURCE_HORIZONTAL_PADDING,
  );
}

function InspectorSplitResizer({
  ratio,
  resetRatio = DEFAULT_INSPECTOR_NAVIGATION_RATIO,
  navigationId,
  detailId,
  onChange,
  onCommit,
}: {
  ratio: number;
  resetRatio?: number;
  navigationId: string;
  detailId: string;
  onChange: (ratio: number) => void;
  onCommit: (ratio: number) => void;
}) {
  const dragRatioRef = useRef(ratio);
  dragRatioRef.current = ratio;

  const updateFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const next = navigationRatioForPointer(event);
    dragRatioRef.current = next;
    onChange(next);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    event.preventDefault();
    const resource = event.currentTarget.parentElement;
    if (!resource) return;
    const availableWidth =
      resource.getBoundingClientRect().width -
      INSPECTOR_RESOURCE_HORIZONTAL_PADDING;
    const currentOffset = dragRatioRef.current * availableWidth;
    const next = inspectorNavigationRatioAtPosition(
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? availableWidth
          : currentOffset + (event.key === "ArrowLeft" ? -16 : 16),
      availableWidth,
    );
    dragRatioRef.current = next;
    onChange(next);
    onCommit(next);
  };

  return (
    <div
      className="workspace-inspector-split-resizer"
      role="separator"
      tabIndex={0}
      aria-label="Resize file navigation"
      aria-orientation="vertical"
      aria-controls={`${navigationId} ${detailId}`}
      aria-valuemin={15}
      aria-valuemax={75}
      aria-valuenow={Math.round(ratio * 100)}
      title="Drag to resize; double-click to reset"
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        updateFromPointer(event);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        updateFromPointer(event);
      }}
      onPointerUp={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        onCommit(dragRatioRef.current);
      }}
      onPointerCancel={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        onCommit(dragRatioRef.current);
      }}
      onDoubleClick={() => {
        dragRatioRef.current = resetRatio;
        onChange(resetRatio);
        onCommit(resetRatio);
      }}
      onKeyDown={handleKeyDown}
    />
  );
}

export function WorkspaceInspectorHost({
  state,
  onReady,
  visible,
  workspace,
  historyPane,
  fileSelection,
  previewRequestRef,
  diffSelection,
  connectionClient,
  onFileSelectionChange,
  onDiffSelectionChange,
  onOpenDiffFile,
  annotations,
  onCreateAnnotation,
  onReanchorFileAnnotations,
  onReanchorDiffAnnotations,
  onEditAnnotation,
  onOpenDocument,
  onRefreshFile,
  onViewChange,
  onDockChange,
  onExpandedChange,
  onClose,
  onBack,
}: {
  state: WorkspaceInspectorState;
  onReady?: () => void;
  visible: boolean;
  workspace?: Workspace;
  historyPane?: Pane;
  fileSelection: ActiveFilePreviewSelection;
  previewRequestRef: React.MutableRefObject<number>;
  diffSelection: ActiveDiffSelection;
  connectionClient: ConnectionClient;
  onFileSelectionChange: Parameters<
    typeof FileExplorerPanel
  >[0]["onPreviewChange"];
  onDiffSelectionChange: DiffViewerPanelProps["onSelectionChange"];
  onOpenDocument: (path: string, fragment?: string) => void;
  onRefreshFile: () => void;
  onOpenDiffFile: (entry: ActiveDiffSelection["entry"]) => void;
  annotations: readonly ReviewAnnotation[];
  onCreateAnnotation: (input: NewReviewAnnotation) => void;
  onReanchorFileAnnotations: (path: string, text: string) => void;
  onReanchorDiffAnnotations: (
    path: string,
    kind: GitDiffEntry["kind"],
    patch: string,
  ) => void;
  onEditAnnotation: (id: string) => void;
  onViewChange: (view: InspectorView) => void;
  onDockChange: (dock: InspectorDock) => void;
  onExpandedChange: (expanded: boolean) => void;
  onClose: () => void;
  onBack: () => void;
}) {
  const hostRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    onReady?.();
  }, [onReady]);
  const filesTabRef = useRef<HTMLButtonElement | null>(null);
  const changesTabRef = useRef<HTMLButtonElement | null>(null);
  const historyTabRef = useRef<HTMLButtonElement | null>(null);
  const diffViewerRef = useRef<DiffViewerPanelHandle | null>(null);
  const splitId = useId();
  const [hostWidth, setHostWidth] = useState(0);
  const [fileDiffState, setFileDiffState] = useState<{
    resourceKey: string;
    entries: GitDiffEntry[];
  }>(() => ({ resourceKey: "", entries: [] }));
  const [drillInByView, setDrillInByView] = useState<
    Record<InspectorView, boolean>
  >(() => ({
    files: state.view === "files" && !!fileSelection.entry,
    changes: false,
    history: false,
  }));
  const resourceKey = resourceOwnerKey(state.scope);
  const contentResourceKey = resourceStateKey(state.scope);
  const fileDiffEntries =
    fileDiffState.resourceKey === contentResourceKey
      ? fileDiffState.entries
      : [];
  const setFileDiffEntries = useCallback(
    (entries: GitDiffEntry[]) =>
      setFileDiffState({ resourceKey: contentResourceKey, entries }),
    [contentResourceKey],
  );
  const [navigationPreferences, setNavigationPreferences] = useState(() =>
    readInspectorPreferences(roamgateLocalStorage, state.scope),
  );
  const defaultNavigationRatio = state.expanded
    ? inspectorNavigationRatioAtPosition(
        300,
        hostWidth - INSPECTOR_RESOURCE_HORIZONTAL_PADDING,
      )
    : DEFAULT_INSPECTOR_NAVIGATION_RATIO;
  const navigationRatios = {
    files: state.expanded
      ? (navigationPreferences.expandedNavigationRatios.files ??
        defaultNavigationRatio)
      : navigationPreferences.filesNavigationRatio,
    changes: state.expanded
      ? (navigationPreferences.expandedNavigationRatios.changes ??
        defaultNavigationRatio)
      : navigationPreferences.changesNavigationRatio,
  };
  const { compact, splitEnabled } = workspaceInspectorLayout(hostWidth);
  // The navigation/detail split is draggable whenever both panes fit side by
  // side, not only in the expanded layout, so docked inspectors can resize
  // the Files/Changes list too.
  const navigationIds = {
    files: `${splitId}-files-navigation`,
    changes: `${splitId}-changes-navigation`,
  };
  const detailIds = {
    files: `${splitId}-files-detail`,
    changes: `${splitId}-changes-detail`,
  };

  const setNavigationRatio = (view: InspectorSplitView, ratio: number) => {
    setNavigationPreferences((current) =>
      state.expanded
        ? {
            ...current,
            expandedNavigationRatios: {
              ...current.expandedNavigationRatios,
              [view]: ratio,
            },
          }
        : {
            ...current,
            [view === "files"
              ? "filesNavigationRatio"
              : "changesNavigationRatio"]: ratio,
          },
    );
  };
  const commitNavigationRatio = (view: InspectorSplitView, ratio: number) => {
    writeInspectorNavigationRatio(
      roamgateLocalStorage,
      state.scope,
      view,
      ratio,
      state.expanded,
    );
  };
  const splitStyle = (view: InspectorSplitView) =>
    ({
      "--workspace-inspector-navigation-width": `${navigationRatios[view] * 100}%`,
    }) as CSSProperties;
  const changeCount = changedCount(workspace);
  const historyAvailable = paneHasAgentHistory(historyPane);
  const detailAvailable =
    state.view === "files"
      ? !!fileSelection.entry
      : state.view === "changes"
        ? !!diffSelection.entry
        : false;
  const hasDetail = detailAvailable && drillInByView[state.view];
  const fileChangesEntries = fileSelection.entry
    ? fileDiffEntries.filter(
        (entry) => entry.path === fileSelection.entry?.path,
      )
    : [];
  const primaryFileChangesEntry =
    fileChangesEntries[fileChangesEntries.length - 1] ?? null;
  const fileDiffSelectionMatches = fileChangesEntries.some(
    (entry) =>
      diffSelection.entry?.path === entry.path &&
      diffSelection.entry.kind === entry.kind,
  );
  const fileChangesKey = fileChangesEntries
    .map((entry) => `${entry.kind}:${entry.status}:${entry.path}`)
    .join("|");

  useEffect(() => {
    if (state.view !== "files" || !fileSelection.entry) return;
    setDrillInByView((current) => ({ ...current, files: true }));
  }, [fileSelection.entry, state.view]);

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" && state.view === "files") {
      const treeItem = hostRef.current?.querySelector<HTMLElement>(
        ".inspector-files-resource .file-row[role='treeitem'][tabindex='0']",
      );
      if (treeItem) {
        event.preventDefault();
        treeItem.focus({ preventScroll: true });
        treeItem.scrollIntoView({ block: "nearest" });
      }
      return;
    }
    const views: InspectorView[] = historyAvailable
      ? ["files", "changes", "history"]
      : ["files", "changes"];
    const currentIndex = Math.max(0, views.indexOf(state.view));
    const nextView: InspectorView | undefined =
      event.key === "Home"
        ? views[0]
        : event.key === "End"
          ? views[views.length - 1]
          : event.key === "ArrowLeft"
            ? views[(currentIndex - 1 + views.length) % views.length]
            : event.key === "ArrowRight"
              ? views[(currentIndex + 1) % views.length]
              : undefined;
    if (!nextView) return;
    event.preventDefault();
    onViewChange(nextView);
    const refs = {
      files: filesTabRef,
      changes: changesTabRef,
      history: historyTabRef,
    };
    refs[nextView].current?.focus();
  };

  useEffect(() => {
    const preferences = readInspectorPreferences(
      roamgateLocalStorage,
      state.scope,
    );
    setNavigationPreferences(preferences);
  }, [contentResourceKey, state.scope]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => setHostWidth(host.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  return (
    <aside
      ref={hostRef}
      className={`workspace-inspector workspace-inspector-${state.dock} ${
        state.expanded ? "is-expanded" : ""
      } ${compact ? "is-compact" : ""} ${hasDetail ? "has-detail" : ""}`}
      aria-label="Workspace Inspector"
      data-view={state.view}
    >
      <header className="workspace-inspector-head">
        <div className="workspace-inspector-identity">
          <span className="workspace-inspector-repo">
            {workspace?.worktree?.repo_name || workspace?.label || "Workspace"}
          </span>
          <span className="workspace-inspector-checkout">
            {checkoutLabel(workspace)}
            {workspace?.worktree?.is_linked_worktree ? (
              <span className="workspace-inspector-wt" title="Linked worktree">
                <GitFork size={11} aria-hidden="true" /> Worktree
              </span>
            ) : null}
          </span>
          {workspace?.worktree?.checkout_path || workspace?.cwd ? (
            <code
              className="workspace-inspector-path"
              title={workspace.worktree?.checkout_path ?? workspace.cwd}
            >
              {workspace.worktree?.checkout_path ?? workspace.cwd}
            </code>
          ) : null}
        </div>
        <div className="workspace-inspector-tabs" role="tablist">
          <button
            ref={filesTabRef}
            type="button"
            role="tab"
            aria-selected={state.view === "files"}
            tabIndex={state.view === "files" ? 0 : -1}
            className={state.view === "files" ? "is-active" : ""}
            onClick={() => onViewChange("files")}
            onKeyDown={handleTabKeyDown}
          >
            <FolderTree size={14} /> Files
          </button>
          <button
            ref={changesTabRef}
            type="button"
            role="tab"
            aria-selected={state.view === "changes"}
            tabIndex={state.view === "changes" ? 0 : -1}
            className={state.view === "changes" ? "is-active" : ""}
            onClick={() => onViewChange("changes")}
            onKeyDown={handleTabKeyDown}
          >
            <FileDiff size={14} /> Changes
            {changeCount > 0 ? (
              <span className="workspace-inspector-count">{changeCount}</span>
            ) : null}
          </button>
          <button
            ref={historyTabRef}
            type="button"
            role="tab"
            aria-selected={state.view === "history"}
            tabIndex={state.view === "history" ? 0 : -1}
            className={state.view === "history" ? "is-active" : ""}
            title={
              historyAvailable
                ? "Agent history"
                : "Select an active agent pane to view history"
            }
            disabled={!historyAvailable && state.view !== "history"}
            onClick={() => {
              if (historyAvailable) onViewChange("history");
            }}
            onKeyDown={handleTabKeyDown}
          >
            <History size={14} /> History
          </button>
        </div>
        <div className="workspace-inspector-actions">
          <button
            type="button"
            className="workspace-inspector-dock-action"
            title={state.dock === "right" ? "Dock at bottom" : "Dock at right"}
            aria-label={
              state.dock === "right"
                ? "Dock Inspector at bottom"
                : "Dock Inspector at right"
            }
            onClick={() =>
              onDockChange(state.dock === "right" ? "bottom" : "right")
            }
          >
            {state.dock === "right" ? (
              <PanelBottom size={15} />
            ) : (
              <PanelRight size={15} />
            )}
          </button>
          <button
            type="button"
            className="workspace-inspector-expand-action"
            title={
              state.expanded ? "Restore Inspector dock" : "Expand Inspector"
            }
            aria-label={
              state.expanded ? "Restore Inspector dock" : "Expand Inspector"
            }
            aria-pressed={state.expanded}
            onClick={() => onExpandedChange(!state.expanded)}
          >
            {state.expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button
            type="button"
            title="Close Inspector"
            aria-label="Close Workspace Inspector"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
      </header>

      {!workspace ? (
        <div className="workspace-inspector-unavailable">
          <strong>Checkout unavailable</strong>
          <span>
            The workspace used to route this Inspector is no longer open.
          </span>
        </div>
      ) : (
        <div className="workspace-inspector-body">
          {hasDetail && state.view === "changes" ? (
            <button
              type="button"
              className="workspace-inspector-back"
              onClick={() => {
                setDrillInByView((current) => ({
                  ...current,
                  [state.view]: false,
                }));
                onBack();
              }}
            >
              <ChevronLeft size={15} />
              Changed files
            </button>
          ) : null}

          <div
            className={`workspace-inspector-resource inspector-files-resource ${
              state.view === "files" ? "" : "is-hidden"
            } ${splitEnabled ? "has-split-resizer" : ""}`}
            style={splitEnabled ? splitStyle("files") : undefined}
          >
            <div
              id={navigationIds.files}
              className="workspace-inspector-navigation"
            >
              <FileExplorerPanel
                open
                workspaceId={workspace.workspace_id}
                resourceKey={resourceKey}
                initialDirectory={state.initialDirectory}
                activePath={fileSelection.entry?.path}
                previewRequestRef={previewRequestRef}
                keyboardActive={
                  state.view === "files" && (!compact || !hasDetail)
                }
                onClose={onClose}
                onPreviewChange={(selection, meta) => {
                  if (selection.entry && meta?.userInitiated) {
                    setDrillInByView((current) => ({
                      ...current,
                      files: true,
                    }));
                  }
                  onFileSelectionChange?.(selection, meta);
                }}
                onActiveDiffEntriesChange={setFileDiffEntries}
              />
            </div>
            {splitEnabled ? (
              <InspectorSplitResizer
                ratio={navigationRatios.files}
                resetRatio={defaultNavigationRatio}
                navigationId={navigationIds.files}
                detailId={detailIds.files}
                onChange={(ratio) => setNavigationRatio("files", ratio)}
                onCommit={(ratio) => commitNavigationRatio("files", ratio)}
              />
            ) : null}
            <div id={detailIds.files} className="workspace-inspector-detail">
              <FilePreviewContent
                entry={fileSelection.entry}
                preview={fileSelection.preview}
                loading={fileSelection.loading}
                error={fileSelection.error}
                fragment={fileSelection.fragment}
                onOpenFile={onOpenDocument}
                onRefresh={onRefreshFile}
                backAction={
                  compact && drillInByView.files && fileSelection.entry
                    ? {
                        label: "Files",
                        onClick: () => {
                          setDrillInByView((current) => ({
                            ...current,
                            files: false,
                          }));
                          onBack();
                        },
                      }
                    : undefined
                }
                annotations={annotations}
                onCreateAnnotation={onCreateAnnotation}
                onReanchorAnnotations={onReanchorFileAnnotations}
                onOpenChanges={
                  primaryFileChangesEntry
                    ? () =>
                        diffViewerRef.current?.selectWorkingEntries(
                          fileChangesEntries,
                        )
                    : undefined
                }
                changesKey={fileChangesKey || undefined}
                changesContent={
                  primaryFileChangesEntry ? (
                    <Suspense
                      fallback={
                        <div className="diff-content-state">
                          <span className="file-loading-spinner" />
                          Loading diff viewer
                        </div>
                      }
                    >
                      <DiffContentView
                        key={`${contentResourceKey}:file-changes`}
                        entry={
                          fileDiffSelectionMatches
                            ? diffSelection.entry
                            : primaryFileChangesEntry
                        }
                        file={
                          fileDiffSelectionMatches ? diffSelection.file : null
                        }
                        loading={
                          !fileDiffSelectionMatches || diffSelection.loading
                        }
                        error={
                          fileDiffSelectionMatches ? diffSelection.error : null
                        }
                        entries={fileChangesEntries}
                        files={
                          fileDiffSelectionMatches ? diffSelection.files : {}
                        }
                        fileErrors={
                          fileDiffSelectionMatches
                            ? diffSelection.fileErrors
                            : {}
                        }
                        resourceKey={`${contentResourceKey}:file:${fileChangesKey}`}
                        connectionClient={connectionClient}
                        annotations={annotations}
                        onCreateAnnotation={onCreateAnnotation}
                        onReanchorAnnotations={onReanchorDiffAnnotations}
                        onEditAnnotation={onEditAnnotation}
                        onSelectFile={(entry) =>
                          diffViewerRef.current?.selectWorkingEntry(entry)
                        }
                        embedded
                      />
                    </Suspense>
                  ) : undefined
                }
              />
            </div>
          </div>
          <div
            className={`workspace-inspector-resource inspector-changes-resource ${
              state.view === "changes" ? "" : "is-hidden"
            } ${splitEnabled ? "has-split-resizer" : ""}`}
            style={splitEnabled ? splitStyle("changes") : undefined}
          >
            <div
              id={navigationIds.changes}
              className="workspace-inspector-navigation"
            >
              <DiffViewerPanel
                ref={diffViewerRef}
                workspaceId={workspace.workspace_id}
                resourceKey={resourceKey}
                onOpenFile={onOpenDiffFile}
                onSelectionChange={(selection, meta) => {
                  if (selection.entry && meta?.userInitiated) {
                    setDrillInByView((current) => ({
                      ...current,
                      changes: true,
                    }));
                  }
                  onDiffSelectionChange?.(selection, meta);
                }}
              />
            </div>
            {splitEnabled ? (
              <InspectorSplitResizer
                ratio={navigationRatios.changes}
                resetRatio={defaultNavigationRatio}
                navigationId={navigationIds.changes}
                detailId={detailIds.changes}
                onChange={(ratio) => setNavigationRatio("changes", ratio)}
                onCommit={(ratio) => commitNavigationRatio("changes", ratio)}
              />
            ) : null}
            <div id={detailIds.changes} className="workspace-inspector-detail">
              {state.view === "changes" ? (
                <Suspense
                  fallback={
                    <div className="diff-content-view">
                      <div className="diff-content-state">
                        <span className="file-loading-spinner" />
                        Loading Diff Viewer
                      </div>
                    </div>
                  }
                >
                  <DiffContentView
                    key={contentResourceKey}
                    entry={diffSelection.entry}
                    file={diffSelection.file}
                    loading={diffSelection.loading}
                    error={diffSelection.error}
                    entries={diffSelection.entries}
                    files={diffSelection.files}
                    fileErrors={diffSelection.fileErrors}
                    summaryLoading={diffSelection.summaryLoading}
                    mobile={compact}
                    resourceKey={contentResourceKey}
                    connectionClient={connectionClient}
                    annotations={annotations}
                    onCreateAnnotation={onCreateAnnotation}
                    onReanchorAnnotations={onReanchorDiffAnnotations}
                    onEditAnnotation={onEditAnnotation}
                    onSelectFile={(target) =>
                      diffViewerRef.current?.selectEntry(target)
                    }
                    onOpenFile={onOpenDiffFile}
                  />
                </Suspense>
              ) : null}
            </div>
          </div>
          <div
            className={`workspace-inspector-resource inspector-history-resource ${
              state.view === "history" ? "" : "is-hidden"
            }`}
          >
            {historyAvailable && historyPane ? (
              <AgentHistoryDrawer
                pane={historyPane}
                open={visible && state.open && state.view === "history"}
                embedded
                wide={!compact}
                onOpenChange={(open) => {
                  if (!open) onClose();
                }}
              />
            ) : (
              <div className="workspace-inspector-unavailable">
                <strong>No active agent session</strong>
                <span>Select an agent pane to inspect its history.</span>
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}

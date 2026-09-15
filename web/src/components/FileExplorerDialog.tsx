import { roamgateLocalStorage } from "../browserStorage";
import {
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  Ellipsis,
  File,
  Folder,
  FolderOpen,
  RefreshCw,
  Search,
  Upload,
} from "lucide-react";
import { FilesystemBrowser } from "./FilesystemBrowser";
import { createFileSearchMatcher } from "../fileSearch";
import { connectionHttpPath } from "../connectionHttp";
import { connectionStorageKey } from "../connectionStorage";
import { downloadFileFromUrl } from "../downloadFile";
import { lazyWithReload } from "../lazyWithReload";
import {
  refreshGitDiffSummary,
  useGitDiffSummaryState,
} from "../gitDiffSummaryStore";
import {
  fileExplorerRefreshKey,
  readFileExplorerRefresh,
  subscribeFileExplorerRefresh,
} from "../fileExplorerRefresh";
import { store, useStoreSelector } from "../store";
import { copyTextFromUserGesture } from "../terminalClipboard";
import { useConnectionClient } from "../useConnectionClient";
import type {
  FileExplorerEntry,
  FileExplorerList,
  FilePreview,
  GitDiffEntry,
} from "../types";
import { CloseButton } from "./CloseButton";
import { ConfirmDialog } from "./ModalDialogs";
import {
  focusTreeItem,
  keyboardContextMenuPoint,
  treeKeyboardAction,
} from "./treeKeyboard";
import type {
  ActiveFilePreviewSelection,
  FilePreviewSelectionMeta,
} from "./FilePreviewContent";

import {
  workspaceName,
  displaySize,
  absolutePath,
  initialWorkspacePath,
  type FileExplorerCache,
  FILE_SHOW_HIDDEN_PREFIX,
  explorerRuntimeContextKey,
  explorerCacheKey,
  advanceExplorerCacheRevision,
  readExplorerCache,
  writeExplorerCache,
  filePreviewCacheKey,
  readCachedPreview,
  invalidateFilePreviewCache,
  parentDirectoryPaths,
  parentDirectoryPath,
  directoryPaths,
  isWorkspaceRelativePath,
  buildGitStatusMaps,
  requestFilePreview,
  uploadExplorerFile,
  deleteExplorerEntry,
} from "./fileExplorerResources";
import "./FileExplorerDialog.css";

const FilePreviewContent = lazyWithReload("file-preview", () =>
  import("./FilePreviewContent").then((module) => ({
    default: module.FilePreviewContent,
  })),
);

const LONG_PRESS_MS = 550;
const LONG_PRESS_MOVE_PX = 10;

const FILE_TREE_INDENT = 10;
const FILE_TREE_BASE_INDENT = 6;

export function FileExplorerDialog({
  open,
  workspaceId,
  onClose,
}: {
  open: boolean;
  workspaceId?: string;
  onClose: () => void;
}) {
  if (!open) return null;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal file-explorer-modal"
        role="dialog"
        aria-modal="true"
        aria-label="File Explorer"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <FileExplorerContent
          open={open}
          workspaceId={workspaceId}
          onClose={onClose}
          showCloseButton
        />
      </div>
    </div>
  );
}

export function FileExplorerPanel({
  open,
  workspaceId,
  resourceKey,
  initialDirectory,
  activePath,
  previewRequestRef,
  keyboardActive = false,
  onClose,
  onPreviewChange,
  onActiveDiffEntriesChange,
}: {
  open: boolean;
  workspaceId?: string;
  resourceKey?: string;
  initialDirectory?: string;
  activePath?: string;
  previewRequestRef?: React.MutableRefObject<number>;
  keyboardActive?: boolean;
  onClose: () => void;
  onPreviewChange?: (
    selection: ActiveFilePreviewSelection,
    meta?: FilePreviewSelectionMeta,
  ) => void;
  onActiveDiffEntriesChange?: (entries: GitDiffEntry[]) => void;
}) {
  if (!open) return null;

  return (
    <aside className="file-explorer-side" aria-label="File Explorer">
      <FileExplorerContent
        open={open}
        workspaceId={workspaceId}
        resourceKey={resourceKey}
        initialDirectory={initialDirectory}
        onClose={onClose}
        showCloseButton={false}
        previewPlacement="external"
        activePath={activePath}
        previewRequestRef={previewRequestRef}
        keyboardActive={keyboardActive}
        onPreviewChange={onPreviewChange}
        onActiveDiffEntriesChange={onActiveDiffEntriesChange}
      />
    </aside>
  );
}

type FileExplorerEntryMenuState = {
  x: number;
  y: number;
  entry: FileExplorerEntry;
};

// Keep ENTRY_MENU_ITEM_COUNT in sync with the items rendered in
// FileExplorerEntryMenu; the height estimate drives clamping and flip placement.
const ENTRY_MENU_ITEM_COUNT = 3;
const ENTRY_MENU_WIDTH = 220;
const ENTRY_MENU_HEIGHT = ENTRY_MENU_ITEM_COUNT * 34 + 8;

function FileExplorerEntryMenu({
  state,
  onClose,
  onDownload,
  onCopy,
  onDelete,
}: {
  state: FileExplorerEntryMenuState | null;
  onClose: () => void;
  onDownload: (entry: FileExplorerEntry) => void;
  onCopy: (entry: FileExplorerEntry) => void;
  onDelete?: (entry: FileExplorerEntry) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!state) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const close = () => onCloseRef.current();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Tab") {
        e.preventDefault();
        close();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      const buttons = Array.from(
        ref.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ??
          [],
      );
      const currentIndex = buttons.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      if (!buttons.length || currentIndex < 0) return;
      e.preventDefault();
      const nextIndex =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? buttons.length - 1
            : e.key === "ArrowDown"
              ? (currentIndex + 1) % buttons.length
              : (currentIndex - 1 + buttons.length) % buttons.length;
      buttons[nextIndex]?.focus();
    };
    const t = setTimeout(() => {
      window.addEventListener("mousedown", onDown);
      window.addEventListener("keydown", onKey);
      window.addEventListener("scroll", close, true);
      ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      if (previousFocus?.isConnected)
        previousFocus.focus({ preventScroll: true });
    };
  }, [state]);

  if (!state) return null;

  const { entry } = state;
  const isDirectory = entry.type === "directory";
  // Keep ENTRY_MENU_ITEM_COUNT in sync with this array.
  const items = [
    {
      label: isDirectory ? "Download directory" : "Download file",
      action: () => onDownload(entry),
    },
    {
      label: "Copy absolute path",
      action: () => onCopy(entry),
    },
    ...(onDelete
      ? [
          {
            label: isDirectory ? "Delete directory" : "Delete file",
            danger: true,
            action: () => onDelete(entry),
          },
        ]
      : []),
  ];
  const menuMargin = 8;
  const menuWidth = ENTRY_MENU_WIDTH;
  const style: React.CSSProperties = {
    position: "fixed",
    width: `min(${ENTRY_MENU_WIDTH}px, calc(100vw - 2 * ${menuMargin}px))`,
    left: Math.max(
      menuMargin,
      Math.min(state.x, window.innerWidth - menuWidth - menuMargin),
    ),
    top: Math.max(
      menuMargin,
      Math.min(state.y, window.innerHeight - ENTRY_MENU_HEIGHT - menuMargin),
    ),
    zIndex: 1000,
  };

  return (
    <div ref={ref} className="context-menu" style={style} role="menu">
      {items.map((item) => (
        <button
          key={item.label}
          className={`context-menu-item ${item.danger ? "is-danger" : ""}`}
          role="menuitem"
          onClick={() => {
            onClose();
            item.action();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function FileExplorerContent({
  open,
  workspaceId,
  resourceKey,
  initialDirectory,
  onClose,
  showCloseButton,
  previewPlacement = "inline",
  previewRequestRef,
  activePath,
  keyboardActive = false,
  onPreviewChange,
  onActiveDiffEntriesChange,
}: {
  open: boolean;
  workspaceId?: string;
  resourceKey?: string;
  initialDirectory?: string;
  onClose: () => void;
  showCloseButton: boolean;
  previewPlacement?: "inline" | "external";
  previewRequestRef?: React.MutableRefObject<number>;
  activePath?: string;
  keyboardActive?: boolean;
  onPreviewChange?: (
    selection: ActiveFilePreviewSelection,
    meta?: FilePreviewSelectionMeta,
  ) => void;
  onActiveDiffEntriesChange?: (entries: GitDiffEntry[]) => void;
}) {
  const workspaces = useStoreSelector((state) => state.workspaces);
  const connectionClient = useConnectionClient();
  const focusedWorkspace = workspaces.find((w) => w.focused);
  const workspace = workspaceId
    ? workspaces.find((w) => w.workspace_id === workspaceId)
    : focusedWorkspace;
  const cacheWorkspaceId = workspace?.workspace_id;
  const cacheResourceKey = resourceKey ?? cacheWorkspaceId;
  const showHiddenStorageKey = connectionStorageKey(
    connectionClient.connectionId,
    `${FILE_SHOW_HIDDEN_PREFIX}${cacheResourceKey ?? "focused"}`,
  );
  const [showHidden, setShowHidden] = useState(
    () => roamgateLocalStorage.getItem(showHiddenStorageKey) === "true",
  );
  const [cache, setCache] = useState<FileExplorerCache>(() =>
    readExplorerCache(
      connectionClient,
      cacheWorkspaceId,
      showHidden,
      cacheResourceKey,
    ),
  );
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const [uploadingPaths, setUploadingPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const [deletingPaths, setDeletingPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [entryMenu, setEntryMenu] = useState<FileExplorerEntryMenuState | null>(
    null,
  );
  const [pendingDeleteEntry, setPendingDeleteEntry] =
    useState<FileExplorerEntry | null>(null);
  const [previewEntry, setPreviewEntry] = useState<FileExplorerEntry | null>(
    null,
  );
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewFragment, setPreviewFragment] = useState<string>();
  const [focusedTreePath, setFocusedTreePath] = useState<string | null>(
    activePath ?? null,
  );
  const [treeHasFocus, setTreeHasFocus] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStart = useRef<{ x: number; y: number } | null>(null);
  const longPressTriggered = useRef(false);
  const previewRequestKeyRef = useRef<string | null>(null);
  const previewRequestSequenceRef = useRef(0);
  const navigationRequestRef = previewRequestRef ?? previewRequestSequenceRef;
  const previousCacheResourceKeyRef = useRef<string | undefined>(undefined);
  const fileTreeRef = useRef<HTMLDivElement | null>(null);
  const treeAutoFocusAppliedRef = useRef(false);
  const runtimeContext = explorerRuntimeContextKey(
    connectionClient,
    cacheWorkspaceId,
    cacheResourceKey,
  );
  const [filesystemContext, setFilesystemContext] = useState<string | null>(
    null,
  );
  const filesystem = filesystemContext === runtimeContext;
  useEffect(() => {
    setFilesystemContext(null);
  }, [runtimeContext]);
  const runtimeContextRef = useRef(runtimeContext);
  runtimeContextRef.current = runtimeContext;
  const { search, rootInfo, children, expanded, error } = cache;
  const gitSummaryState = useGitDiffSummaryState(
    connectionClient,
    cacheWorkspaceId,
    "working",
    cacheResourceKey,
  );
  const gitStatusMaps = useMemo(
    () => buildGitStatusMaps(gitSummaryState.summary, rootInfo?.root),
    [gitSummaryState.summary, rootInfo?.root],
  );
  const activeDiffEntries = useMemo(
    () =>
      activePath
        ? (gitStatusMaps.fileStatuses.get(activePath)?.entries ?? [])
        : [],
    [activePath, gitStatusMaps],
  );
  const emitPreviewChange = (
    selection: ActiveFilePreviewSelection,
    meta?: FilePreviewSelectionMeta,
  ) => {
    onPreviewChange?.(selection, meta);
  };
  const runtimeContextIsCurrent = (context: string) =>
    connectionClient.isCurrent() && runtimeContextRef.current === context;

  useEffect(() => {
    roamgateLocalStorage.setItem(showHiddenStorageKey, String(showHidden));
  }, [showHidden, showHiddenStorageKey]);

  useEffect(() => {
    onActiveDiffEntriesChange?.(activeDiffEntries);
  }, [activeDiffEntries, onActiveDiffEntriesChange]);

  const updateCache = (patch: Partial<FileExplorerCache>) => {
    setCache((current) => {
      const next = {
        ...current,
        ...patch,
        children: patch.children
          ? { ...patch.children }
          : { ...current.children },
        expanded: patch.expanded
          ? new Set(patch.expanded)
          : new Set(current.expanded),
      };
      writeExplorerCache(
        connectionClient,
        cacheWorkspaceId,
        showHidden,
        next,
        cacheResourceKey,
      );
      return next;
    });
  };

  const clearLongPressTimer = () => {
    if (!longPressTimer.current) return;
    clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };

  const loadDirectory = async (path: string, force = false) => {
    if (!workspace?.workspace_id || !connectionClient.isCurrent()) return;
    const requestContext = runtimeContext;
    if (!force && children[path]) return;
    setLoadingPaths((current) => new Set(current).add(path));
    updateCache({ error: null });
    try {
      const list = (await connectionClient.call("file.list", {
        workspace_id: workspace.workspace_id,
        path,
        show_hidden: showHidden,
      })) as FileExplorerList;
      if (
        !connectionClient.isCurrent() ||
        runtimeContextRef.current !== requestContext
      ) {
        return;
      }
      setCache((current) => {
        const next = {
          ...current,
          rootInfo: list,
          children: { ...current.children, [path]: list.entries },
          expanded: new Set(current.expanded),
          error: null,
        };
        writeExplorerCache(
          connectionClient,
          cacheWorkspaceId,
          showHidden,
          next,
          cacheResourceKey,
        );
        return next;
      });
    } catch (e) {
      if (
        connectionClient.isCurrent() &&
        runtimeContextRef.current === requestContext
      ) {
        updateCache({ error: (e as Error).message });
      }
    } finally {
      if (
        connectionClient.isCurrent() &&
        runtimeContextRef.current === requestContext
      ) {
        setLoadingPaths((current) => {
          const next = new Set(current);
          next.delete(path);
          return next;
        });
      }
    }
  };

  const loadGitStatus = async (afterCurrent = false) => {
    if (!connectionClient.isCurrent() || !workspace?.workspace_id) return;
    try {
      await refreshGitDiffSummary(
        connectionClient,
        workspace.workspace_id,
        "working",
        cacheResourceKey,
        { afterCurrent },
      );
    } catch {
      // Git status is supplementary; keep the file explorer usable on failure.
    }
  };

  const explorerRefreshKey = fileExplorerRefreshKey(
    connectionClient,
    cacheWorkspaceId ?? "",
  );
  const explorerRefreshVersion = useSyncExternalStore(
    (listener) => subscribeFileExplorerRefresh(explorerRefreshKey, listener),
    () => readFileExplorerRefresh(explorerRefreshKey),
    () => readFileExplorerRefresh(explorerRefreshKey),
  );
  const explorerRefreshRef = useRef({
    key: explorerRefreshKey,
    version: explorerRefreshVersion,
  });

  useEffect(() => {
    const previous = explorerRefreshRef.current;
    explorerRefreshRef.current = {
      key: explorerRefreshKey,
      version: explorerRefreshVersion,
    };
    if (
      !open ||
      (previous.key === explorerRefreshKey &&
        previous.version === explorerRefreshVersion)
    ) {
      return;
    }
    // A Git mutation landed elsewhere (e.g. the Changes panel): re-list the
    // visible directories so deleted files and ignored markers stay fresh.
    const pathsToRefresh = Array.from(expanded);
    if (!pathsToRefresh.includes("")) pathsToRefresh.unshift("");
    for (const path of pathsToRefresh) {
      void loadDirectory(path, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [explorerRefreshKey, explorerRefreshVersion]);

  useEffect(() => {
    if (!open) return;
    const resourceChanged =
      previousCacheResourceKeyRef.current !== cacheResourceKey;
    previousCacheResourceKeyRef.current = cacheResourceKey;
    advanceExplorerCacheRevision(
      explorerCacheKey(
        connectionClient,
        cacheWorkspaceId,
        showHidden,
        cacheResourceKey,
      ),
    );
    const cached = readExplorerCache(
      connectionClient,
      cacheWorkspaceId,
      showHidden,
      cacheResourceKey,
    );
    const initialPaths =
      initialDirectory && isWorkspaceRelativePath(initialDirectory)
        ? directoryPaths(initialDirectory)
        : [];
    const initialExpanded = new Set(cached.expanded);
    for (const path of initialPaths) initialExpanded.add(path);
    const initialCache = { ...cached, expanded: initialExpanded };
    writeExplorerCache(
      connectionClient,
      cacheWorkspaceId,
      showHidden,
      initialCache,
      cacheResourceKey,
    );
    setCache(initialCache);
    setLoadingPaths(new Set());
    setUploadingPaths(new Set());
    setDeletingPaths(new Set());
    setDropTargetPath(null);
    setEntryMenu(null);
    setPendingDeleteEntry(null);
    if (resourceChanged && !activePath) {
      setPreviewEntry(null);
      setPreview(null);
      setPreviewLoading(false);
      setPreviewError(null);
      emitPreviewChange({
        entry: null,
        preview: null,
        loading: false,
        error: null,
      });
    }
    previewRequestKeyRef.current = null;
    const pathsToRefresh = Array.from(initialCache.expanded);
    if (!pathsToRefresh.includes("")) pathsToRefresh.unshift("");
    for (const path of pathsToRefresh) {
      void loadDirectory(path, true);
    }
    void loadGitStatus();
    let removeKeyHandler = () => {};
    if (showCloseButton) {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") onClose();
      };
      window.addEventListener("keydown", onKey);
      removeKeyHandler = () => window.removeEventListener("keydown", onKey);
    }
    return () => {
      clearLongPressTimer();
      removeKeyHandler();
    };
    // Reopen against a fresh workspace/show-hidden snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    cacheResourceKey,
    cacheWorkspaceId,
    connectionClient,
    initialDirectory,
    open,
    showHidden,
    showCloseButton,
  ]);

  useEffect(() => {
    if (
      !open ||
      !workspace?.workspace_id ||
      !activePath ||
      !isWorkspaceRelativePath(activePath)
    ) {
      return;
    }
    let cancelled = false;
    const workspaceId = workspace.workspace_id;
    const entryName = activePath.split("/").filter(Boolean).pop() ?? activePath;
    setPreviewEntry((current) =>
      current?.path === activePath
        ? current
        : {
            name: entryName,
            path: activePath,
            type: "file",
            size: 0,
            mtime_ms: 0,
            hidden: entryName.startsWith("."),
          },
    );

    const expandActivePath = async () => {
      const parentPaths = parentDirectoryPaths(activePath);
      let latest = readExplorerCache(
        connectionClient,
        workspaceId,
        showHidden,
        cacheResourceKey,
      );
      const nextExpanded = new Set(latest.expanded);
      for (const path of parentPaths) nextExpanded.add(path);
      writeExplorerCache(
        connectionClient,
        workspaceId,
        showHidden,
        { expanded: nextExpanded },
        cacheResourceKey,
      );
      if (!cancelled) {
        setCache((current) => ({
          ...current,
          expanded: new Set(nextExpanded),
        }));
      }

      for (const path of parentPaths) {
        if (cancelled || !connectionClient.isCurrent()) return;
        latest = readExplorerCache(
          connectionClient,
          workspaceId,
          showHidden,
          cacheResourceKey,
        );
        if (latest.children[path]) continue;
        setLoadingPaths((current) => new Set(current).add(path));
        try {
          const list = (await connectionClient.call("file.list", {
            workspace_id: workspaceId,
            path,
            show_hidden: showHidden,
          })) as FileExplorerList;
          if (!connectionClient.isCurrent() || cancelled) return;
          latest = readExplorerCache(
            connectionClient,
            workspaceId,
            showHidden,
            cacheResourceKey,
          );
          const expandedWithPath = new Set(latest.expanded);
          for (const parentPath of parentPaths)
            expandedWithPath.add(parentPath);
          writeExplorerCache(
            connectionClient,
            workspaceId,
            showHidden,
            {
              rootInfo: list,
              children: { ...latest.children, [path]: list.entries },
              expanded: expandedWithPath,
              error: null,
            },
            cacheResourceKey,
          );
          if (!cancelled) {
            setCache((current) => ({
              ...current,
              rootInfo: list,
              children: { ...current.children, [path]: list.entries },
              expanded: new Set(expandedWithPath),
              error: null,
            }));
          }
        } catch (e) {
          if (!cancelled && connectionClient.isCurrent()) {
            setCache((current) => ({
              ...current,
              error: (e as Error).message,
            }));
          }
        } finally {
          if (!cancelled && connectionClient.isCurrent()) {
            setLoadingPaths((current) => {
              const next = new Set(current);
              next.delete(path);
              return next;
            });
          }
        }
      }
    };

    void expandActivePath();
    return () => {
      cancelled = true;
    };
  }, [
    activePath,
    cacheResourceKey,
    cacheWorkspaceId,
    connectionClient,
    open,
    showHidden,
    workspace?.workspace_id,
  ]);

  const query = search.trim().toLowerCase();
  const loadedEntries = useMemo(
    () =>
      Object.values(children)
        .flat()
        .filter((entry, index, all) => {
          const firstIndex = all.findIndex(
            (candidate) => candidate.path === entry.path,
          );
          return firstIndex === index;
        }),
    [children],
  );
  const searchEntries = useMemo(
    () => (query ? loadedEntries.filter(createFileSearchMatcher(query)) : []),
    [loadedEntries, query],
  );

  useEffect(() => {
    if (!activePath || !isWorkspaceRelativePath(activePath)) return;
    setFocusedTreePath(activePath);
  }, [activePath]);

  useEffect(() => {
    if (!activePath || !isWorkspaceRelativePath(activePath)) return;
    const tree = fileTreeRef.current;
    if (!tree) return;
    const row = Array.from(
      tree.querySelectorAll<HTMLElement>(".file-row[data-file-path]"),
    ).find((candidate) => candidate.dataset.filePath === activePath);
    row?.scrollIntoView({ block: "nearest" });
  }, [activePath, children, expanded, query]);

  useEffect(() => {
    const items = Array.from(
      fileTreeRef.current?.querySelectorAll<HTMLElement>(
        ".file-row[role='treeitem']",
      ) ?? [],
    );
    if (!items.length) {
      if (focusedTreePath !== null) setFocusedTreePath(null);
      return;
    }
    if (
      focusedTreePath &&
      items.some((item) => item.dataset.filePath === focusedTreePath)
    ) {
      return;
    }
    const next =
      items.find((item) => item.dataset.filePath === activePath) ?? items[0];
    setFocusedTreePath(next?.dataset.filePath ?? null);
  }, [activePath, children, expanded, focusedTreePath, query, searchEntries]);

  useEffect(() => {
    if (!keyboardActive) {
      treeAutoFocusAppliedRef.current = false;
      return;
    }
    if (treeAutoFocusAppliedRef.current) return;
    const tree = fileTreeRef.current;
    const items = Array.from(
      tree?.querySelectorAll<HTMLElement>(".file-row[role='treeitem']") ?? [],
    );
    if (!tree || !items.length) return;
    const focusedElement = document.activeElement as HTMLElement | null;
    const content = tree.closest(".file-explorer-content");
    if (
      focusedElement &&
      (content?.contains(focusedElement) ||
        focusedElement.closest("[role='tab']"))
    ) {
      treeAutoFocusAppliedRef.current = true;
      return;
    }
    const target =
      items.find((item) => item.dataset.filePath === focusedTreePath) ??
      items.find((item) => item.dataset.filePath === activePath) ??
      items[0];
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "nearest" });
    treeAutoFocusAppliedRef.current = true;
  }, [activePath, children, focusedTreePath, keyboardActive]);

  const toggleDirectory = (path: string) => {
    const next = new Set(expanded);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
      void loadDirectory(path);
    }
    updateCache({ expanded: next });
  };

  const loadPreview = async (
    entry: FileExplorerEntry,
    fragment?: string,
    refresh = false,
  ) => {
    if (!workspace?.workspace_id || entry.type === "directory") return;
    onActiveDiffEntriesChange?.(
      gitStatusMaps.fileStatuses.get(entry.path)?.entries ?? [],
    );
    const workspaceId = workspace.workspace_id;
    const key = filePreviewCacheKey(connectionClient, workspaceId, entry.path);
    // Links, quick-open and tree selections must retire each other at start,
    // before either the cached preview or a deferred response can be published.
    const requestId = ++navigationRequestRef.current;
    const requestKey = `${key}:${requestId}`;
    previewRequestKeyRef.current = requestKey;
    const requestIsCurrent = () =>
      connectionClient.isCurrent() &&
      navigationRequestRef.current === requestId &&
      previewRequestKeyRef.current === requestKey;
    setPreviewEntry(entry);
    setPreviewFragment(fragment);
    setPreviewError(null);
    const cached = refresh ? null : readCachedPreview(key);
    if (cached) {
      setPreview(cached);
      setPreviewLoading(false);
      emitPreviewChange(
        { entry, fragment, preview: cached, loading: false, error: null },
        { userInitiated: true },
      );
    } else {
      setPreview(null);
      setPreviewLoading(true);
      emitPreviewChange(
        { entry, fragment, preview: null, loading: true, error: null },
        { userInitiated: true },
      );
    }
    try {
      const next = await requestFilePreview(workspaceId, entry.path, {
        refresh: refresh || Boolean(cached),
        client: connectionClient,
      });
      if (requestIsCurrent()) {
        setPreview(next);
        emitPreviewChange(
          { entry, fragment, preview: next, loading: false, error: null },
          { userInitiated: true },
        );
      }
    } catch (e) {
      if (requestIsCurrent() && !cached) {
        const message = (e as Error).message;
        setPreviewError(message);
        emitPreviewChange(
          { entry, fragment, preview: null, loading: false, error: message },
          { userInitiated: true },
        );
      }
    } finally {
      if (requestIsCurrent()) {
        setPreviewLoading(false);
      }
    }
  };

  const copyEntryPath = async (entry: FileExplorerEntry) => {
    const root = rootInfo?.root || initialWorkspacePath(workspace);
    const value = root ? absolutePath(root, entry) : entry.path;
    try {
      await copyTextFromUserGesture(value);
      if (!connectionClient.isCurrent()) return;
      store.notify({
        kind: "success",
        message: "Path copied",
        detail: value,
        autoDismissMs: 5000,
      });
    } catch (e) {
      if (!connectionClient.isCurrent()) return;
      store.notify({
        kind: "error",
        message: "Failed to copy path",
        detail: (e as Error).message,
      });
    }
  };

  const downloadEntry = (entry: FileExplorerEntry) => {
    if (!workspace?.workspace_id) return;
    if (!connectionClient.isCurrent()) return;
    const url = new URL(
      connectionHttpPath(
        connectionClient.connectionId,
        "/file/download",
        connectionClient.serverRuntimeGeneration,
      ),
      window.location.origin,
    );
    url.searchParams.set("workspace_id", workspace.workspace_id);
    url.searchParams.set("path", entry.path);
    if (/^(?:\/|[a-z]:[\\/])/i.test(entry.path))
      url.searchParams.set("scope", "filesystem");
    const filename =
      entry.type === "directory"
        ? `${entry.name || "download"}.tar.gz`
        : entry.name || "download";
    void downloadFileFromUrl({ url: url.toString(), filename }).then(
      (result) => {
        if (result === "shared" || !connectionClient.isCurrent()) return;
        store.notify({
          kind: "info",
          message: "Download started",
          detail: entry.path,
          autoDismissMs: 5000,
        });
      },
    );
  };

  const markDeletePath = (path: string, deleting: boolean) => {
    setDeletingPaths((current) => {
      const next = new Set(current);
      if (deleting) next.add(path);
      else next.delete(path);
      return next;
    });
  };

  const removeEntryFromCache = (entry: FileExplorerEntry) => {
    setCache((current) => {
      const parent = parentDirectoryPath(entry.path);
      const nextChildren = { ...current.children };
      nextChildren[parent] = (nextChildren[parent] ?? []).filter(
        (candidate) => candidate.path !== entry.path,
      );
      if (entry.type === "directory") {
        for (const path of Object.keys(nextChildren)) {
          if (path === entry.path || path.startsWith(`${entry.path}/`)) {
            delete nextChildren[path];
          }
        }
      }
      const nextExpanded = new Set(current.expanded);
      for (const path of nextExpanded) {
        if (path === entry.path || path.startsWith(`${entry.path}/`)) {
          nextExpanded.delete(path);
        }
      }
      const next = {
        ...current,
        children: nextChildren,
        expanded: nextExpanded,
        error: null,
      };
      writeExplorerCache(
        connectionClient,
        cacheWorkspaceId,
        showHidden,
        next,
        cacheResourceKey,
      );
      return next;
    });
  };

  const clearDeletedPreview = (entry: FileExplorerEntry) => {
    if (!workspace?.workspace_id) return;
    const selectedPath = previewEntry?.path;
    const deletedSelection =
      selectedPath === entry.path ||
      (entry.type === "directory" &&
        selectedPath?.startsWith(`${entry.path}/`));
    invalidateFilePreviewCache(
      connectionClient,
      workspace.workspace_id,
      entry.path,
      entry.type === "directory",
    );
    if (!deletedSelection) return;
    navigationRequestRef.current += 1;
    setPreviewEntry(null);
    setPreview(null);
    setPreviewLoading(false);
    setPreviewError(null);
    emitPreviewChange(
      { entry: null, preview: null, loading: false, error: null },
      { userInitiated: true },
    );
  };

  const deleteEntry = async (entry: FileExplorerEntry) => {
    if (!workspace?.workspace_id || !connectionClient.isCurrent()) return;
    const requestContext = runtimeContext;
    markDeletePath(entry.path, true);
    updateCache({ error: null });
    try {
      await deleteExplorerEntry(
        connectionClient,
        workspace.workspace_id,
        entry.path,
      );
      if (!runtimeContextIsCurrent(requestContext)) return;
      removeEntryFromCache(entry);
      clearDeletedPreview(entry);
      await loadDirectory(parentDirectoryPath(entry.path), true);
      if (!runtimeContextIsCurrent(requestContext)) return;
      void loadGitStatus(true);
      store.notify({
        kind: "success",
        message:
          entry.type === "directory" ? "Directory deleted" : "File deleted",
        detail: entry.path,
        autoDismissMs: 5000,
      });
    } catch (e) {
      if (!runtimeContextIsCurrent(requestContext)) return;
      store.notify({
        kind: "error",
        message: "Delete failed",
        detail: (e as Error).message,
      });
    } finally {
      if (runtimeContextIsCurrent(requestContext)) {
        markDeletePath(entry.path, false);
      }
    }
  };

  const invalidateUploadedPreviews = (paths: string[]) => {
    if (!workspace?.workspace_id || !paths.length) return;
    for (const path of paths) {
      invalidateFilePreviewCache(
        connectionClient,
        workspace.workspace_id,
        path,
      );
    }
    if (previewEntry && paths.includes(previewEntry.path)) {
      void loadPreview(previewEntry);
    }
  };

  const isFileDrag = (event: DragEvent<HTMLElement>) =>
    Array.from(event.dataTransfer.types).includes("Files");

  const markUploadPath = (path: string, uploading: boolean) => {
    setUploadingPaths((current) => {
      const next = new Set(current);
      if (uploading) next.add(path);
      else next.delete(path);
      return next;
    });
  };

  const uploadDroppedFiles = async (directory: string, files: FileList) => {
    if (!workspace?.workspace_id || !connectionClient.isCurrent()) return;
    const requestContext = runtimeContext;
    const uploadFiles = Array.from(files).filter((file) => file.name);
    if (!uploadFiles.length) return;
    markUploadPath(directory, true);
    updateCache({ error: null });
    try {
      const results = await Promise.allSettled(
        uploadFiles.map((file) =>
          uploadExplorerFile(
            connectionClient,
            workspace.workspace_id,
            directory,
            file,
          ),
        ),
      );
      if (!runtimeContextIsCurrent(requestContext)) return;
      const failed = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failed) throw failed.reason;
      if (directory) {
        updateCache({ expanded: new Set(expanded).add(directory) });
      }
      await loadDirectory(directory, true);
      if (!runtimeContextIsCurrent(requestContext)) return;
      invalidateUploadedPreviews(
        results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value.path] : [],
        ),
      );
      void loadGitStatus(true);
      const uploaded = results.length;
      store.notify({
        kind: "success",
        message: uploaded === 1 ? "File uploaded" : "Files uploaded",
        detail:
          uploaded === 1
            ? uploadFiles[0]?.name
            : `${uploaded} files uploaded to ${directory || "/"}`,
        autoDismissMs: 5000,
      });
    } catch (e) {
      if (!runtimeContextIsCurrent(requestContext)) return;
      store.notify({
        kind: "error",
        message: "Upload failed",
        detail: (e as Error).message,
      });
    } finally {
      if (runtimeContextIsCurrent(requestContext)) {
        markUploadPath(directory, false);
        setDropTargetPath(null);
      }
    }
  };

  const handleDirectoryDragOver = (
    event: DragEvent<HTMLElement>,
    directory: string,
  ) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setDropTargetPath(directory);
  };

  const handleDirectoryDrop = (
    event: DragEvent<HTMLElement>,
    directory: string,
  ) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    void uploadDroppedFiles(directory, event.dataTransfer.files);
  };

  const handleRootDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return;
    if ((event.target as HTMLElement | null)?.closest(".file-row")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropTargetPath("");
  };

  const handleRootDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return;
    if ((event.target as HTMLElement | null)?.closest(".file-row")) return;
    event.preventDefault();
    void uploadDroppedFiles("", event.dataTransfer.files);
  };

  const openEntryMenu = (entry: FileExplorerEntry, x: number, y: number) => {
    setEntryMenu({ entry, x, y });
  };

  const handleEntryPointerDown = (
    event: ReactPointerEvent<HTMLElement>,
    entry: FileExplorerEntry,
  ) => {
    if (event.pointerType === "mouse") return;
    longPressTriggered.current = false;
    longPressStart.current = { x: event.clientX, y: event.clientY };
    clearLongPressTimer();
    longPressTimer.current = setTimeout(() => {
      longPressTriggered.current = true;
      openEntryMenu(entry, event.clientX, event.clientY);
    }, LONG_PRESS_MS);
  };

  const handleEntryPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const start = longPressStart.current;
    if (!start) return;
    const dx = Math.abs(event.clientX - start.x);
    const dy = Math.abs(event.clientY - start.y);
    if (dx > LONG_PRESS_MOVE_PX || dy > LONG_PRESS_MOVE_PX) {
      clearLongPressTimer();
      longPressStart.current = null;
    }
  };

  const handleEntryPointerEnd = () => {
    clearLongPressTimer();
    longPressStart.current = null;
  };

  const activateEntry = (entry: FileExplorerEntry) => {
    if (entry.type === "directory") toggleDirectory(entry.path);
    else void loadPreview(entry);
  };

  const focusFirstChild = (current: HTMLElement) => {
    const items = Array.from(
      fileTreeRef.current?.querySelectorAll<HTMLElement>(
        ".file-row[role='treeitem']",
      ) ?? [],
    );
    const index = items.indexOf(current);
    const child = items[index + 1];
    if (
      !child ||
      Number(child.getAttribute("aria-level")) !==
        Number(current.getAttribute("aria-level")) + 1
    ) {
      return;
    }
    current.tabIndex = -1;
    child.tabIndex = 0;
    child.focus({ preventScroll: true });
    child.scrollIntoView({ block: "nearest" });
  };

  const handleEntryKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
    entry: FileExplorerEntry,
    isDirectory: boolean,
    isExpanded: boolean,
  ) => {
    if (event.target !== event.currentTarget) return;
    const action = treeKeyboardAction(event.key, event.shiftKey);
    if (!action) return;
    event.preventDefault();

    if (
      action === "next" ||
      action === "previous" ||
      action === "first" ||
      action === "last"
    ) {
      focusTreeItem(event.currentTarget, action);
      return;
    }
    if (action === "expand") {
      if (isDirectory && !isExpanded) toggleDirectory(entry.path);
      else if (isDirectory) focusFirstChild(event.currentTarget);
      return;
    }
    if (action === "collapse") {
      if (isDirectory && isExpanded) {
        toggleDirectory(entry.path);
        return;
      }
      const parentPath = parentDirectoryPath(entry.path);
      const parent = Array.from(
        fileTreeRef.current?.querySelectorAll<HTMLElement>(
          ".file-row[role='treeitem']",
        ) ?? [],
      ).find((candidate) => candidate.dataset.filePath === parentPath);
      parent?.focus({ preventScroll: true });
      parent?.scrollIntoView({ block: "nearest" });
      return;
    }
    event.stopPropagation();
    if (action === "activate") activateEntry(entry);
    else {
      const point = keyboardContextMenuPoint(event.currentTarget);
      openEntryMenu(entry, point.x, point.y);
    }
  };

  const renderEntry = (
    entry: FileExplorerEntry,
    depth: number,
    defaultTabStop = false,
  ) => {
    const isDirectory = entry.type === "directory";
    const uploadDirectory = isDirectory
      ? entry.path
      : parentDirectoryPath(entry.path);
    const isExpanded = expanded.has(entry.path);
    const loading = loadingPaths.has(entry.path);
    const uploading = isDirectory && uploadingPaths.has(entry.path);
    const deleting = deletingPaths.has(entry.path);
    const gitStatus = isDirectory
      ? gitStatusMaps.directoryStatuses.get(entry.path)
      : gitStatusMaps.fileStatuses.get(entry.path);
    const meta = [entry.type === "symlink" ? "symlink" : "", displaySize(entry)]
      .filter(Boolean)
      .join(" · ");

    return (
      <div key={entry.path}>
        <div
          className={`file-row ${
            previewEntry?.path === entry.path ? "is-selected" : ""
          } ${
            treeHasFocus && focusedTreePath === entry.path ? "is-focused" : ""
          } ${
            dropTargetPath === entry.path && isDirectory ? "is-drop-target" : ""
          } ${uploading && isDirectory ? "is-uploading" : ""} ${
            entry.ignored ? "is-ignored" : ""
          }`}
          data-file-path={entry.path}
          data-parent-path={parentDirectoryPath(entry.path)}
          role="treeitem"
          tabIndex={
            focusedTreePath === entry.path ||
            (!focusedTreePath && defaultTabStop)
              ? 0
              : -1
          }
          aria-level={depth + 1}
          aria-selected={previewEntry?.path === entry.path}
          aria-expanded={isDirectory ? isExpanded : undefined}
          style={{
            paddingLeft: FILE_TREE_BASE_INDENT + depth * FILE_TREE_INDENT,
          }}
          onFocus={() => setFocusedTreePath(entry.path)}
          onKeyDown={(event) =>
            handleEntryKeyDown(event, entry, isDirectory, isExpanded)
          }
          onDragOver={(e) => handleDirectoryDragOver(e, uploadDirectory)}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setDropTargetPath(null);
            }
          }}
          onDrop={(e) => handleDirectoryDrop(e, uploadDirectory)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openEntryMenu(entry, e.clientX, e.clientY);
          }}
          onPointerDown={(e) => handleEntryPointerDown(e, entry)}
          onPointerMove={handleEntryPointerMove}
          onPointerUp={handleEntryPointerEnd}
          onPointerCancel={handleEntryPointerEnd}
          onPointerLeave={handleEntryPointerEnd}
          onClick={(event) => {
            event.currentTarget.focus({ preventScroll: true });
            if (longPressTriggered.current) {
              longPressTriggered.current = false;
              return;
            }
            activateEntry(entry);
          }}
        >
          <button
            type="button"
            className="file-twisty"
            tabIndex={-1}
            disabled={!isDirectory}
            onClick={(e) => {
              e.stopPropagation();
              e.currentTarget
                .closest<HTMLElement>(".file-row")
                ?.focus({ preventScroll: true });
              if (isDirectory) toggleDirectory(entry.path);
            }}
            aria-label={isExpanded ? "Collapse folder" : "Expand folder"}
          >
            {isDirectory ? (
              isExpanded ? (
                <ChevronDown size={14} />
              ) : (
                <ChevronRight size={14} />
              )
            ) : null}
          </button>
          <span className="file-icon">
            {isDirectory ? (
              isExpanded ? (
                <FolderOpen size={16} />
              ) : (
                <Folder size={16} />
              )
            ) : (
              <File size={16} />
            )}
          </span>
          <span
            className="file-name"
            title={
              entry.ignored ? `${entry.path} · Ignored by Git` : entry.path
            }
          >
            {entry.name}
          </span>
          {gitStatus ? (
            <span
              className="file-git-status"
              title={gitStatus.title}
              role="img"
              aria-label={gitStatus.title}
            >
              {gitStatus.codes.map((code) => (
                <span
                  className={`git-status-code git-status-${code.toLowerCase()}`}
                  key={code}
                  aria-hidden="true"
                >
                  {code}
                </span>
              ))}
            </span>
          ) : null}
          {meta ? <span className="file-meta">{meta}</span> : null}
          {loading || uploading || deleting ? (
            <span className="row-spinner" />
          ) : null}
          <span className="file-actions">
            <button
              type="button"
              className="ghost file-action"
              tabIndex={-1}
              title="File actions"
              aria-label="File actions"
              aria-haspopup="menu"
              onClick={(e) => {
                e.stopPropagation();
                e.currentTarget
                  .closest<HTMLElement>(".file-row")
                  ?.focus({ preventScroll: true });
                const rect = e.currentTarget.getBoundingClientRect();
                const below = rect.bottom + 4;
                const y =
                  below + ENTRY_MENU_HEIGHT <= window.innerHeight - 8
                    ? below
                    : Math.max(8, rect.top - 4 - ENTRY_MENU_HEIGHT);
                openEntryMenu(entry, rect.right - ENTRY_MENU_WIDTH, y);
              }}
            >
              <Ellipsis size={14} />
            </button>
          </span>
        </div>
        {!query && isDirectory && isExpanded
          ? renderDirectory(entry.path, depth + 1)
          : null}
      </div>
    );
  };

  const renderDirectory = (path: string, depth: number) => {
    const entries = children[path];
    if (!entries && loadingPaths.has(path)) {
      return (
        <div
          className="file-row file-row-loading"
          style={{
            paddingLeft: FILE_TREE_BASE_INDENT + depth * FILE_TREE_INDENT,
          }}
        >
          <span className="file-loading-spinner" />
          <span className="file-loading-text">Loading directory</span>
        </div>
      );
    }
    if (!entries) return null;
    if (entries.length === 0) {
      return (
        <div
          className="file-row file-row-muted"
          style={{
            paddingLeft: FILE_TREE_BASE_INDENT + depth * FILE_TREE_INDENT,
          }}
        >
          Empty
        </div>
      );
    }
    return entries.map((entry, index) =>
      renderEntry(entry, depth, path === "" && index === 0),
    );
  };

  const renderInitialLoading = () => (
    <div className="file-skeleton-list" aria-label="Loading files">
      {Array.from({ length: 5 }, (_, index) => (
        <div className="file-skeleton-row" key={index}>
          <span className="file-skeleton-icon" />
          <span className="file-skeleton-lines">
            <span className="file-skeleton-line file-skeleton-line-name" />
            <span className="file-skeleton-line file-skeleton-line-path" />
          </span>
        </div>
      ))}
    </div>
  );

  return (
    <>
      {showCloseButton ? (
        <>
          <div className="modal-head">
            <h2>File Explorer</h2>
            <CloseButton onClick={onClose} />
          </div>
          {workspace ? (
            <div className="file-explorer-summary">
              <span>{workspaceName(workspace)}</span>
              <code>
                {rootInfo?.root ??
                  (initialWorkspacePath(workspace) || "Loading path...")}
              </code>
            </div>
          ) : null}
        </>
      ) : null}

      {!workspace ? (
        <p className="modal-error">No workspace is focused.</p>
      ) : null}

      <div className="file-explorer-content">
        <div className="file-explorer-browser">
          {filesystem && workspace ? (
            <FilesystemBrowser
              key={runtimeContext}
              client={connectionClient}
              workspaceId={workspace.workspace_id}
              initialPath={rootInfo?.root || initialWorkspacePath(workspace)}
              showHidden={showHidden}
              onShowHiddenChange={setShowHidden}
              activePath={activePath ?? previewEntry?.path}
              onSelect={(entry) => {
                void loadPreview(entry);
              }}
              onMenu={openEntryMenu}
              onExit={() => {
                setEntryMenu(null);
                setFilesystemContext(null);
              }}
            />
          ) : (
            <>
              <div className="file-explorer-toolbar">
                <label className="file-search">
                  <Search size={14} />
                  <input
                    value={search}
                    onChange={(e) =>
                      updateCache({ search: e.currentTarget.value })
                    }
                    placeholder="Search loaded files"
                    aria-label="Search loaded files"
                    title="Search loaded names or paths. Globs: r*md, ?.txt, **/*.md, *.{md,txt}"
                    maxLength={512}
                  />
                </label>
                <label className="file-hidden-toggle">
                  <input
                    type="checkbox"
                    checked={showHidden}
                    onChange={(e) => setShowHidden(e.currentTarget.checked)}
                  />
                  Hidden
                </label>
                <button
                  type="button"
                  className="ghost file-action"
                  aria-label="Browse filesystem"
                  title="Browse filesystem: allow navigation outside this workspace"
                  disabled={!workspace}
                  onClick={() => {
                    setEntryMenu(null);
                    setPendingDeleteEntry(null);
                    setFilesystemContext(runtimeContext);
                  }}
                >
                  <FolderOpen size={15} />
                </button>
                <button
                  type="button"
                  className="ghost file-action"
                  title="Refresh"
                  disabled={!workspace}
                  onClick={() => {
                    const pathsToRefresh = Array.from(expanded);
                    if (!pathsToRefresh.includes(""))
                      pathsToRefresh.unshift("");
                    for (const path of pathsToRefresh) {
                      void loadDirectory(path, true);
                    }
                    void loadGitStatus(true);
                    if (previewEntry) void loadPreview(previewEntry);
                  }}
                >
                  <RefreshCw
                    className={gitSummaryState.loading ? "is-spinning" : ""}
                    size={15}
                  />
                </button>
              </div>

              {error ? <p className="modal-error">{error}</p> : null}
              {rootInfo?.truncated ? (
                <p className="modal-error">
                  This directory is truncated at 1000 entries.
                </p>
              ) : null}

              <div
                ref={fileTreeRef}
                className={`file-tree ${dropTargetPath === "" ? "is-drop-target" : ""}`}
                role="tree"
                onFocusCapture={() => setTreeHasFocus(true)}
                onBlurCapture={(event) => {
                  if (
                    !event.currentTarget.contains(event.relatedTarget as Node)
                  ) {
                    setTreeHasFocus(false);
                  }
                }}
                onDragOver={handleRootDragOver}
                onDragLeave={(e) => {
                  if (
                    !e.currentTarget.contains(e.relatedTarget as Node | null)
                  ) {
                    setDropTargetPath(null);
                  }
                }}
                onDrop={handleRootDrop}
              >
                {uploadingPaths.has("") ? (
                  <div className="file-upload-status">
                    <span className="row-spinner" />
                    Uploading to workspace root
                  </div>
                ) : dropTargetPath === "" ? (
                  <div className="file-upload-status">
                    <Upload size={14} />
                    Drop files to upload to workspace root
                  </div>
                ) : null}
                {query ? (
                  searchEntries.length ? (
                    searchEntries.map((entry, index) =>
                      renderEntry(entry, 0, index === 0),
                    )
                  ) : (
                    <div className="file-row file-row-muted">
                      No loaded files match.
                    </div>
                  )
                ) : !children[""] && loadingPaths.has("") ? (
                  renderInitialLoading()
                ) : (
                  renderDirectory("", 0)
                )}
              </div>
            </>
          )}
        </div>
        {previewPlacement === "inline" ? (
          <Suspense fallback={<div role="status">Loading preview...</div>}>
            <FilePreviewContent
              entry={previewEntry}
              preview={preview}
              loading={previewLoading}
              error={previewError}
              onRefresh={() => {
                if (previewEntry)
                  void loadPreview(previewEntry, previewFragment, true);
              }}
              fragment={previewFragment}
              onOpenFile={(path, fragment) =>
                void loadPreview(
                  {
                    name: path.split("/").pop() ?? path,
                    path,
                    type: "file",
                    size: 0,
                    mtime_ms: 0,
                    hidden: false,
                  },
                  fragment,
                )
              }
            />
          </Suspense>
        ) : null}
      </div>
      <FileExplorerEntryMenu
        state={entryMenu}
        onClose={() => setEntryMenu(null)}
        onDownload={downloadEntry}
        onCopy={(entry) => {
          void copyEntryPath(entry);
        }}
        onDelete={filesystem ? undefined : setPendingDeleteEntry}
      />
      <ConfirmDialog
        open={!!pendingDeleteEntry}
        title={
          pendingDeleteEntry?.type === "directory"
            ? "Delete Directory"
            : "Delete File"
        }
        message={
          pendingDeleteEntry
            ? `Delete ${pendingDeleteEntry.type === "directory" ? "directory" : "file"} "${pendingDeleteEntry.path}"? This cannot be undone.`
            : "Delete this item?"
        }
        confirmLabel="Delete"
        danger
        onClose={() => setPendingDeleteEntry(null)}
        onConfirm={() => {
          if (pendingDeleteEntry) void deleteEntry(pendingDeleteEntry);
        }}
      />
    </>
  );
}

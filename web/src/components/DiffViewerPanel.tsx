import { roamgateLocalStorage } from "../browserStorage";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  File,
  FileDiff,
  Folder,
  RefreshCw,
} from "lucide-react";
import type { ConnectionClient } from "../api";
import type { GitDiffEntry, GitDiffFile, GitDiffSummary } from "../types";
import { useStoreSelector } from "../store";
import {
  connectionClientScopeKey,
  useConnectionClient,
} from "../useConnectionClient";
import { connectionStorageKey } from "../connectionStorage";
import { gitDiffCode, gitDiffCodeLabel } from "../gitDiffStatus";
import {
  lastStepCompletionKey,
  readLastStepCompletion,
  subscribeLastStepCompletion,
} from "../lastStepCompletionStore";
import {
  refreshGitDiffSummary,
  retireGitDiffSummary,
  retireGitDiffSummaryResource,
  useGitDiffSummaryState,
} from "../gitDiffSummaryStore";
import { diffAutoCollapseInfo } from "./diffAutoCollapse";
import { createDiffLoadQueue } from "./diffLoadQueue";
import { store } from "../store";
import { copyTextFromUserGesture } from "../terminalClipboard";
import { bumpFileExplorerRefresh } from "../fileExplorerRefresh";
import {
  revealInFileManager,
  revealMenuLabel,
  useCanRevealInFileManager,
} from "../fileManager";
import {
  buildGitFileMenuItems,
  buildGitRepoMenuItems,
  countWorkingEntries,
  gitFileConfirmCopy,
  gitFolderConfirmCopy,
  gitRepoConfirmCopy,
  type GitFileMenuItem,
  type GitRepoMenuItem,
} from "../gitActions";
import { keyboardContextMenuPoint, treeKeyboardAction } from "./treeKeyboard";
import { ActionsMenu } from "./ActionsMenu";
import { ConfirmDialog } from "./ModalDialogs";
import "./DiffViewerPanel.css";

export type ActiveDiffSelection = {
  selectionRevision?: number;
  entry: GitDiffEntry | null;
  file: GitDiffFile | null;
  loading: boolean;
  error: string | null;
  entries: GitDiffEntry[];
  files: Record<string, GitDiffFile>;
  fileErrors: Record<string, string>;
  summaryLoading: boolean;
  loadingKeys?: string[];
};

export type DiffSelectionMeta = {
  userInitiated?: boolean;
};

export type DiffViewerPanelHandle = {
  highlightEntry: (entry: GitDiffEntry | null) => void;
  loadNearbyEntries: (entries: GitDiffEntry[]) => void;
  selectEntry: (entry: GitDiffEntry) => void;
  selectWorkingEntry: (entry: GitDiffEntry) => void;
  selectWorkingEntries: (entries: GitDiffEntry[]) => void;
};

export type DiffViewerPanelProps = {
  workspaceId?: string;
  resourceKey?: string;
  onSelectionChange?: (
    selection: ActiveDiffSelection,
    meta?: DiffSelectionMeta,
  ) => void;
  onOpenFile?: (entry: GitDiffEntry) => void;
};

type DiffCache = {
  summary: GitDiffSummary | null;
  selected: GitDiffEntry | null;
  files: Record<string, GitDiffFile>;
  fileErrors: Record<string, string>;
  error: string | null;
};

type DiffScope = "working" | "branch-main" | "last-step";

const diffCache = new Map<string, DiffCache>();
const diffCacheRevisions = new Map<string, number>();
const diffPrefetches = new Map<string, Promise<void>>();
const diffFileRequests = new Map<string, Promise<GitDiffFile>>();
const DIFF_TREE_INDENT = 9;
const DIFF_TREE_BASE_INDENT = 6;
const diffLoadQueues = new Map<
  string,
  ReturnType<typeof createDiffLoadQueue>
>();

function diffLoadQueue(client: ConnectionClient) {
  const key = connectionClientScopeKey(client);
  let queue = diffLoadQueues.get(key);
  if (!queue) {
    queue = createDiffLoadQueue();
    diffLoadQueues.set(key, queue);
    if (diffLoadQueues.size > 8) {
      diffLoadQueues.delete(diffLoadQueues.keys().next().value!);
    }
  }
  return queue;
}

export function usesContinuousDiffReview(connectionId: string) {
  return (
    store.get().connections.find((item) => item.id === connectionId)?.type !==
    "ssh"
  );
}
const LONG_PRESS_MS = 550;
const LONG_PRESS_MOVE_PX = 10;
const MAX_CACHED_DIFF_FILES = 24;
const MAX_CACHED_DIFF_BYTES = 8 * 1024 * 1024;
const MAX_DIFF_CACHE_CONTEXTS = 8;
const MAX_TOTAL_CACHED_DIFF_BYTES = 24 * 1024 * 1024;
const DIFF_SCOPE_KEY = "diffViewerScope";

function diffScopeStorageKey(connectionId: string, resourceKey?: string) {
  return connectionStorageKey(
    connectionId,
    resourceKey ? `${DIFF_SCOPE_KEY}:${resourceKey}` : DIFF_SCOPE_KEY,
  );
}

function loadDiffScope(
  connectionId = "legacy-default",
  resourceKey?: string,
): DiffScope {
  const scoped = roamgateLocalStorage.getItem(
    diffScopeStorageKey(connectionId, resourceKey),
  );
  const value =
    scoped ??
    (resourceKey
      ? roamgateLocalStorage.getItem(diffScopeStorageKey(connectionId))
      : null);
  if (value === "branch-main") return "branch-main";
  if (value === "last-step") return "last-step";
  return "working";
}

function diffEntryKey(entry: GitDiffEntry) {
  return `${entry.kind}:${entry.path}`;
}

function estimatedDiffBytes(file: GitDiffFile) {
  return file.diff.length * 2;
}

function diffCacheBytes(cache: DiffCache) {
  return Object.values(cache.files).reduce(
    (total, file) => total + estimatedDiffBytes(file),
    0,
  );
}

function pruneDiffCaches(activeKey: string) {
  const totalBytes = () =>
    Array.from(diffCache.values()).reduce(
      (total, cache) => total + diffCacheBytes(cache),
      0,
    );

  while (
    diffCache.size > MAX_DIFF_CACHE_CONTEXTS ||
    totalBytes() > MAX_TOTAL_CACHED_DIFF_BYTES
  ) {
    const oldestKey = Array.from(diffCache.keys()).find(
      (key) => key !== activeKey,
    );
    if (!oldestKey) return;
    advanceDiffCacheRevision(oldestKey);
    diffCache.delete(oldestKey);
  }
}

function setDiffCache(key: string, cache: DiffCache) {
  diffCache.delete(key);
  diffCache.set(key, cache);
  pruneDiffCaches(key);
}

function boundedDiffFiles(
  files: Record<string, GitDiffFile>,
  selected: GitDiffEntry | null,
) {
  const selectedKey = selected ? diffEntryKey(selected) : null;
  const keptNewestFirst: string[] = [];
  let cachedBytes = 0;

  if (selectedKey && files[selectedKey]) {
    keptNewestFirst.push(selectedKey);
    cachedBytes = estimatedDiffBytes(files[selectedKey]);
  }

  const keys = Object.keys(files);
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    const key = keys[index];
    if (key === selectedKey) continue;
    if (keptNewestFirst.length >= MAX_CACHED_DIFF_FILES) break;
    const fileBytes = estimatedDiffBytes(files[key]);
    if (
      keptNewestFirst.length > 0 &&
      cachedBytes + fileBytes > MAX_CACHED_DIFF_BYTES
    ) {
      continue;
    }
    keptNewestFirst.push(key);
    cachedBytes += fileBytes;
  }

  return Object.fromEntries(
    keptNewestFirst.reverse().map((key) => [key, files[key]]),
  );
}

export function beginDiffFileSelection(
  current: DiffCache,
  entry: GitDiffEntry,
) {
  const key = diffEntryKey(entry);
  const fileErrors = { ...current.fileErrors };
  delete fileErrors[key];
  return {
    ...current,
    selected: entry,
    files: boundedDiffFiles(current.files, entry),
    fileErrors,
    error: null,
  };
}

export function mergeResolvedDiffFile(
  current: DiffCache,
  entry: GitDiffEntry,
  file: GitDiffFile,
) {
  const key = diffEntryKey(entry);
  if (file.deferred && current.files[key] && !current.files[key].deferred)
    return current;
  const requestIsSelected =
    current.selected !== null && diffEntryKey(current.selected) === key;
  const selected = requestIsSelected ? entry : current.selected;
  return {
    ...current,
    selected,
    files: boundedDiffFiles({ ...current.files, [key]: file }, selected),
    fileErrors: Object.fromEntries(
      Object.entries(current.fileErrors).filter(
        ([errorKey]) => errorKey !== key,
      ),
    ),
    error: requestIsSelected ? null : current.error,
  };
}

export function buildActiveDiffSelection(
  source: DiffCache,
  patch: Partial<ActiveDiffSelection>,
  fileLoadingKey: string | null,
  summaryLoading: boolean,
): ActiveDiffSelection {
  const selected = patch.entry === undefined ? source.selected : patch.entry;
  const files = patch.files === undefined ? source.files : patch.files;
  const key = selected ? diffEntryKey(selected) : "";
  return {
    entry: selected,
    file:
      patch.file === undefined
        ? key
          ? (files[key] ?? null)
          : null
        : patch.file,
    loading:
      patch.loading ??
      (summaryLoading || (!!key && fileLoadingKey === key && !files[key])),
    error: patch.error === undefined ? source.error : patch.error,
    entries:
      patch.entries === undefined
        ? treeOrderedDiffEntries(source.summary?.entries ?? [])
        : patch.entries,
    files,
    fileErrors:
      patch.fileErrors === undefined ? source.fileErrors : patch.fileErrors,
    summaryLoading:
      patch.summaryLoading === undefined
        ? summaryLoading
        : patch.summaryLoading,
  };
}

export function diffCacheKey(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  workspaceId: string | undefined,
  scope: DiffScope,
  resourceKey = workspaceId,
) {
  return connectionClientScopeKey(
    client,
    "diff",
    resourceKey ?? "focused",
    scope,
  );
}

export function diffRuntimeContextKey(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  workspaceId: string | undefined,
  scope: DiffScope,
  resourceKey = workspaceId,
) {
  return connectionClientScopeKey(
    client,
    "diff-runtime",
    resourceKey ?? "focused",
    workspaceId ?? "missing",
    scope,
  );
}

function diffCacheRevision(key: string): number {
  return diffCacheRevisions.get(key) ?? 0;
}

function advanceDiffCacheRevision(key: string): number {
  const next = diffCacheRevision(key) + 1;
  diffCacheRevisions.set(key, next);
  return next;
}

function retireDiffCache(key: string) {
  advanceDiffCacheRevision(key);
  diffCache.delete(key);
}

function diffFileRequestKey(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  workspaceId: string,
  scope: DiffScope,
  entry: GitDiffEntry,
  revision: number,
  snapshotId?: string,
  automatic = false,
) {
  return connectionClientScopeKey(
    client,
    "diff-file",
    workspaceId,
    scope,
    diffEntryKey(entry),
    revision,
    snapshotId ?? "live",
    automatic,
  );
}

export function diffSelectionStorageKey(
  connectionId: string,
  workspaceId: string,
  scope: DiffScope,
) {
  return connectionStorageKey(
    connectionId,
    `diffViewerSelected:${workspaceId}:${scope}`,
  );
}

function readStoredSelection(
  connectionId: string,
  workspaceId: string | undefined,
  scope: DiffScope,
): GitDiffEntry | null {
  if (!workspaceId) return null;
  try {
    const raw = roamgateLocalStorage.getItem(
      diffSelectionStorageKey(connectionId, workspaceId, scope),
    );
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<GitDiffEntry>;
    if (
      typeof value.path === "string" &&
      [
        "staged",
        "unstaged",
        "untracked",
        "conflicted",
        "branch",
        "last-step",
      ].includes(value.kind ?? "") &&
      typeof value.status === "string"
    ) {
      return value as GitDiffEntry;
    }
  } catch {
    // Ignore invalid persisted UI state.
  }
  return null;
}

function writeStoredSelection(
  connectionId: string,
  workspaceId: string | undefined,
  scope: DiffScope,
  entry: GitDiffEntry,
) {
  if (!workspaceId) return;
  roamgateLocalStorage.setItem(
    diffSelectionStorageKey(connectionId, workspaceId, scope),
    JSON.stringify(entry),
  );
}

export function clearDiffViewerResourceCache(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  resourceKey: string,
  storage: Pick<Storage, "removeItem"> = roamgateLocalStorage,
) {
  for (const scope of ["working", "branch-main", "last-step"] as const) {
    retireDiffCache(diffCacheKey(client, undefined, scope, resourceKey));
    storage.removeItem(
      diffSelectionStorageKey(client.connectionId, resourceKey, scope),
    );
  }
  retireGitDiffSummaryResource(client, resourceKey);
  storage.removeItem(diffScopeStorageKey(client.connectionId, resourceKey));
  diffPrefetches.delete(
    connectionClientScopeKey(client, "diff-prefetch", resourceKey),
  );
}

function emptyDiffCache(): DiffCache {
  return {
    summary: null,
    selected: null,
    files: {},
    fileErrors: {},
    error: null,
  };
}

function readDiffCache(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  workspaceId: string | undefined,
  scope: DiffScope,
  resourceKey = workspaceId,
) {
  const key = diffCacheKey(client, workspaceId, scope, resourceKey);
  const cached = diffCache.get(key);
  if (cached) {
    diffCache.delete(key);
    diffCache.set(key, cached);
    return {
      ...cached,
      files: { ...cached.files },
      fileErrors: { ...cached.fileErrors },
    };
  }
  const next = emptyDiffCache();
  setDiffCache(key, next);
  return {
    ...next,
    files: { ...next.files },
    fileErrors: { ...next.fileErrors },
  };
}

function writeDiffCache(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  workspaceId: string | undefined,
  scope: DiffScope,
  patch: Partial<DiffCache>,
  resourceKey = workspaceId,
) {
  const key = diffCacheKey(client, workspaceId, scope, resourceKey);
  const current = diffCache.get(key) ?? emptyDiffCache();
  const selected =
    patch.selected === undefined ? current.selected : patch.selected;
  setDiffCache(key, {
    ...current,
    ...patch,
    selected,
    files: boundedDiffFiles(patch.files ?? current.files, selected),
    fileErrors: patch.fileErrors
      ? { ...patch.fileErrors }
      : { ...current.fileErrors },
  });
}

function resolveSelectedEntry(
  client: Pick<ConnectionClient, "connectionId" | "generation">,
  workspaceId: string,
  scope: DiffScope,
  entries: GitDiffEntry[],
  preferred?: GitDiffEntry | null,
  resourceKey = workspaceId,
) {
  const stored = readStoredSelection(client.connectionId, resourceKey, scope);
  const candidates = [preferred, stored].filter(Boolean) as GitDiffEntry[];
  for (const candidate of candidates) {
    const match = entries.find(
      (entry) => diffEntryKey(entry) === diffEntryKey(candidate),
    );
    if (match) return match;
  }
  return (
    entries.find((entry) => diffAutoCollapseInfo(entry) === null) ??
    entries[0] ??
    null
  );
}

function requestDiffFile(
  client: ConnectionClient,
  workspaceId: string,
  scope: DiffScope,
  entry: GitDiffEntry,
  revision: number,
  snapshotId?: string,
  wanted: () => boolean = () => true,
  priority = true,
  automatic = false,
) {
  if (!client.isCurrent()) {
    return Promise.reject(new Error("connection changed during diff request"));
  }
  if (scope === "last-step" && !snapshotId) {
    return Promise.reject(
      new Error("last-step diff requires a fresh summary snapshot"),
    );
  }
  const requestKey = diffFileRequestKey(
    client,
    workspaceId,
    scope,
    entry,
    revision,
    snapshotId,
    automatic,
  );
  const running = diffFileRequests.get(requestKey);
  if (running) {
    if (priority) diffLoadQueue(client).prioritize(requestKey);
    return running;
  }
  const task = diffLoadQueue(client).request(
    () =>
      client.call("git.diff_file", {
        workspace_id: workspaceId,
        mode: scope,
        path: entry.path,
        old_path: entry.old_path,
        kind: entry.kind,
        snapshot_id: snapshotId,
        automatic,
      }) as Promise<GitDiffFile>,
    () => client.isCurrent() && wanted(),
    priority,
    requestKey,
  );
  diffFileRequests.set(
    requestKey,
    task
      .then((file) => {
        if (!client.isCurrent()) {
          throw new Error("connection changed during diff request");
        }
        return file;
      })
      .finally(() => {
        diffFileRequests.delete(requestKey);
      }),
  );
  return diffFileRequests.get(requestKey)!;
}

function cacheDiffFile(
  client: ConnectionClient,
  workspaceId: string,
  scope: DiffScope,
  entry: GitDiffEntry,
  file: GitDiffFile,
  resourceKey: string,
  revision: number,
) {
  const key = diffCacheKey(client, workspaceId, scope, resourceKey);
  if (!client.isCurrent() || diffCacheRevision(key) !== revision) return;
  const cached = readDiffCache(client, workspaceId, scope, resourceKey);
  writeDiffCache(
    client,
    workspaceId,
    scope,
    mergeResolvedDiffFile(cached, entry, file),
    resourceKey,
  );
}

export function prefetchDiffFilesInBatches(
  client: ConnectionClient,
  workspaceId: string,
  scope: DiffScope,
  entries: GitDiffEntry[],
  resourceKey = workspaceId,
  onFile?: (entry: GitDiffEntry, file: GitDiffFile, revision: number) => void,
  onFileError?: (entry: GitDiffEntry, error: string, revision: number) => void,
) {
  const key = diffCacheKey(client, workspaceId, scope, resourceKey);
  const revision = diffCacheRevision(key);
  const cached = readDiffCache(client, workspaceId, scope, resourceKey);
  const snapshotId = cached.summary?.snapshot_id;
  const queue = entries.filter((entry) => !cached.files[diffEntryKey(entry)]);
  if (!queue.length) return Promise.resolve();

  return Promise.all(
    queue.map(async (entry) => {
      try {
        const file = await requestDiffFile(
          client,
          workspaceId,
          scope,
          entry,
          revision,
          snapshotId,
          () => diffCacheRevision(key) === revision,
          false,
          true,
        );
        if (!client.isCurrent() || diffCacheRevision(key) !== revision) return;
        cacheDiffFile(
          client,
          workspaceId,
          scope,
          entry,
          file,
          resourceKey,
          revision,
        );
        onFile?.(entry, file, revision);
      } catch (e) {
        if (!client.isCurrent() || diffCacheRevision(key) !== revision) return;
        onFileError?.(entry, (e as Error).message, revision);
      }
    }),
  ).then(() => undefined);
}

function diffStatsForEntries(entries: GitDiffEntry[]) {
  return entries.reduce(
    (total, entry) => ({
      additions: total.additions + (entry.additions ?? 0),
      deletions: total.deletions + (entry.deletions ?? 0),
      hasStats:
        total.hasStats ||
        typeof entry.additions === "number" ||
        typeof entry.deletions === "number",
    }),
    { additions: 0, deletions: 0, hasStats: false },
  );
}

type DiffTreeNode = {
  name: string;
  path: string;
  children: Map<string, DiffTreeNode>;
  entries: GitDiffEntry[];
};

function makeTreeNode(name: string, path: string): DiffTreeNode {
  return { name, path, children: new Map(), entries: [] };
}

/** Every summary entry under a tree node, so folder menus can act on the
 *  whole directory. */
function collectTreeEntries(node: DiffTreeNode): GitDiffEntry[] {
  const entries = [...node.entries];
  for (const child of node.children.values()) {
    entries.push(...collectTreeEntries(child));
  }
  return entries;
}

function buildDiffTree(entries: GitDiffEntry[]) {
  const root = makeTreeNode("", "");
  for (const entry of entries) {
    const parts = entry.path.split("/").filter(Boolean);
    let node = root;
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join("/");
      let child = node.children.get(part);
      if (!child) {
        child = makeTreeNode(part, path);
        node.children.set(part, child);
      }
      node = child;
    });
    node.entries.push(entry);
  }
  return root;
}

function sortDiffTreeChildren(children: Iterable<DiffTreeNode>) {
  return [...children].sort((a, b) => {
    const aFile = a.entries.length > 0;
    const bFile = b.entries.length > 0;
    if (aFile !== bFile) return aFile ? 1 : -1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

function treeOrderedDiffEntries(entries: GitDiffEntry[]) {
  const ordered: GitDiffEntry[] = [];
  const visit = (node: DiffTreeNode) => {
    for (const child of sortDiffTreeChildren(node.children.values())) {
      if (child.entries.length) {
        ordered.push(...child.entries);
      } else {
        visit(child);
      }
    }
  };
  visit(buildDiffTree(entries));
  return ordered;
}

export function expandedDirsForSelection(entry: GitDiffEntry | null) {
  return expandedDirsForEntries(entry ? [entry] : []);
}

export function expandedDirsForEntries(entries: GitDiffEntry[]) {
  const expanded = new Set<string>([""]);
  for (const entry of entries) {
    const parts = entry.path.split("/").filter(Boolean);
    for (let index = 1; index < parts.length; index += 1) {
      expanded.add(parts.slice(0, index).join("/"));
    }
  }
  return expanded;
}

export function prefetchDiffViewerWorkspace(
  workspaceId: string | undefined,
  client: ConnectionClient,
  resourceKey = workspaceId,
) {
  if (!workspaceId || !client.isCurrent()) return Promise.resolve();
  const prefetchKey = connectionClientScopeKey(
    client,
    "diff-prefetch",
    resourceKey,
  );
  const running = diffPrefetches.get(prefetchKey);
  if (running) return running;

  const task = (async () => {
    const scope: DiffScope = "working";
    const cacheKey = diffCacheKey(client, workspaceId, scope, resourceKey);
    let revision = diffCacheRevision(cacheKey);
    const cached = readDiffCache(client, workspaceId, scope, resourceKey);
    const summary = await refreshGitDiffSummary(
      client,
      workspaceId,
      scope,
      resourceKey,
    );
    if (!client.isCurrent() || diffCacheRevision(cacheKey) !== revision) return;
    const selected = resolveSelectedEntry(
      client,
      workspaceId,
      scope,
      summary.entries,
      cached.selected,
      resourceKey,
    );
    const files: Record<string, GitDiffFile> = {};

    // A warmup publishes a fresh summary. Retire any batch that was still
    // loading files from the previously cached snapshot before replacing it.
    revision = advanceDiffCacheRevision(cacheKey);
    writeDiffCache(
      client,
      workspaceId,
      scope,
      {
        summary,
        selected,
        files,
        error: null,
      },
      resourceKey,
    );

    if (
      !selected ||
      !usesContinuousDiffReview(client.connectionId) ||
      diffAutoCollapseInfo(selected)
    )
      return;
    const key = diffEntryKey(selected);
    if (files[key]) return;
    const file = await requestDiffFile(
      client,
      workspaceId,
      scope,
      selected,
      revision,
      undefined,
      () => diffCacheRevision(cacheKey) === revision,
      true,
      true,
    );
    if (!client.isCurrent() || diffCacheRevision(cacheKey) !== revision) return;
    writeDiffCache(
      client,
      workspaceId,
      scope,
      {
        summary,
        selected,
        files: { ...files, [key]: file },
        error: null,
      },
      resourceKey,
    );
  })()
    .catch(() => {
      // Background warmups should never surface transient bridge errors.
    })
    .finally(() => {
      if (diffPrefetches.get(prefetchKey) === task) {
        diffPrefetches.delete(prefetchKey);
      }
    });

  diffPrefetches.set(prefetchKey, task);
  return task;
}

type DiffContextMenuState = {
  x: number;
  y: number;
  path: string;
  entries: GitDiffEntry[];
  directory?: boolean;
};

type DiffConfirmState = {
  title: string;
  message: string;
  confirmLabel: string;
  run: () => void;
};

export const DiffViewerPanel = forwardRef<
  DiffViewerPanelHandle,
  DiffViewerPanelProps
>(function DiffViewerPanel(
  { workspaceId, resourceKey, onSelectionChange, onOpenFile },
  ref,
) {
  const workspaces = useStoreSelector((state) => state.workspaces);
  const connectionClient = useConnectionClient();
  const canReveal = useCanRevealInFileManager();
  const continuousReview = useStoreSelector(
    (state) =>
      state.connections.find(
        (item) => item.id === connectionClient.connectionId,
      )?.type !== "ssh",
  );
  const focusedWorkspace = workspaces.find((w) => w.focused);
  const workspace = workspaceId
    ? workspaces.find((w) => w.workspace_id === workspaceId)
    : focusedWorkspace;
  const cacheWorkspaceId = workspace?.workspace_id;
  const cacheResourceKey = resourceKey ?? cacheWorkspaceId;
  const completionKey = lastStepCompletionKey(
    connectionClient.connectionId,
    cacheWorkspaceId,
  );
  const subscribeToCompletion = useCallback(
    (listener: () => void) =>
      subscribeLastStepCompletion(completionKey, listener),
    [completionKey],
  );
  const readCompletion = useCallback(
    () => readLastStepCompletion(completionKey),
    [completionKey],
  );
  const completionRevision = useSyncExternalStore(
    subscribeToCompletion,
    readCompletion,
    readCompletion,
  );
  const completionRevisionRef = useRef({
    key: completionKey,
    revision: completionRevision,
  });
  const [diffScope, setDiffScope] = useState<DiffScope>(() =>
    loadDiffScope(connectionClient.connectionId, cacheResourceKey),
  );
  const sharedSummaryState = useGitDiffSummaryState(
    connectionClient,
    cacheWorkspaceId,
    diffScope,
    cacheResourceKey,
  );
  const [cache, setCache] = useState<DiffCache>(() =>
    readDiffCache(
      connectionClient,
      cacheWorkspaceId,
      loadDiffScope(connectionClient.connectionId, cacheResourceKey),
      cacheResourceKey,
    ),
  );
  const summaryLoading = sharedSummaryState.loading;
  const [fileLoadingKey, setFileLoadingKey] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(
    () => new Set([""]),
  );
  const [visibleEntryKey, setVisibleEntryKey] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const runtimeContextKey = diffRuntimeContextKey(
    connectionClient,
    cacheWorkspaceId,
    diffScope,
    cacheResourceKey,
  );
  const activeContextRef = useRef(runtimeContextKey);
  const previousFilesRef = useRef({
    context: runtimeContextKey,
    summary: cache.summary,
    files: {} as Record<string, GitDiffFile>,
  });
  const selectionRevisionRef = useRef(0);
  const nearbyEntryKeysRef = useRef(new Set<string>());
  const explicitEntryKeysRef = useRef(new Set<string>());
  const pendingFileKeysRef = useRef(new Map<string, number>());
  const [loadingKeys, setLoadingKeys] = useState<string[]>([]);
  const selectedEntryKeyRef = useRef(
    cache.selected ? diffEntryKey(cache.selected) : "",
  );
  const selectedBatchEntryKeysRef = useRef(new Set<string>());
  const pendingWorkingEntriesRef = useRef<GitDiffEntry[]>([]);
  const preferredSummarySelectionRef = useRef<GitDiffEntry | null>(null);
  const diffScopeRef = useRef(diffScope);
  diffScopeRef.current = diffScope;
  const onSelectionChangeRef = useRef(onSelectionChange);
  const [contextMenu, setContextMenu] = useState<DiffContextMenuState | null>(
    null,
  );
  const [confirmState, setConfirmState] = useState<DiffConfirmState | null>(
    null,
  );
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null);
  const longPressTriggeredRef = useRef(false);

  useLayoutEffect(() => {
    onSelectionChangeRef.current = onSelectionChange;
  }, [onSelectionChange]);

  useLayoutEffect(() => {
    activeContextRef.current = runtimeContextKey;
    setVisibleEntryKey(null);
    if (previousFilesRef.current.context !== runtimeContextKey)
      previousFilesRef.current.files = {};
  }, [runtimeContextKey]);

  const isCurrentContext = (
    workspaceId: string | undefined,
    scope: DiffScope,
  ) =>
    connectionClient.isCurrent() &&
    activeContextRef.current ===
      diffRuntimeContextKey(
        connectionClient,
        workspaceId,
        scope,
        cacheResourceKey,
      );

  const updateCache = (patch: Partial<DiffCache>) => {
    setCache((current) => {
      const selected =
        patch.selected === undefined ? current.selected : patch.selected;
      const next = {
        ...current,
        ...patch,
        selected,
        files: boundedDiffFiles(patch.files ?? current.files, selected),
        fileErrors: patch.fileErrors
          ? { ...patch.fileErrors }
          : { ...current.fileErrors },
      };
      writeDiffCache(
        connectionClient,
        cacheWorkspaceId,
        diffScope,
        next,
        cacheResourceKey,
      );
      return next;
    });
  };

  useEffect(() => {
    const summary = sharedSummaryState.summary;
    if (
      !workspace?.workspace_id ||
      !summary ||
      cache.summary === summary ||
      !isCurrentContext(workspace.workspace_id, diffScope)
    ) {
      return;
    }
    const selected = resolveSelectedEntry(
      connectionClient,
      workspace.workspace_id,
      diffScope,
      summary.entries,
      preferredSummarySelectionRef.current ?? cache.selected,
      cacheResourceKey,
    );
    preferredSummarySelectionRef.current = null;
    advanceDiffCacheRevision(
      diffCacheKey(
        connectionClient,
        workspace.workspace_id,
        diffScope,
        cacheResourceKey,
      ),
    );
    selectedEntryKeyRef.current = selected ? diffEntryKey(selected) : "";
    setVisibleEntryKey((current) =>
      summary.entries.some((entry) => diffEntryKey(entry) === current)
        ? current
        : null,
    );
    pendingFileKeysRef.current = new Map();
    setLoadingKeys([]);
    if (previousFilesRef.current.context === runtimeContextKey) {
      previousFilesRef.current.summary = summary;
      previousFilesRef.current.files = boundedDiffFiles(
        { ...previousFilesRef.current.files, ...cache.files },
        selected,
      );
    }
    updateCache({
      summary,
      selected,
      files: {},
      fileErrors: {},
      error: null,
    });
    setExpandedDirs(expandedDirsForEntries(summary.entries));
    const pendingEntries = pendingWorkingEntriesRef.current;
    if (diffScope === "working" && pendingEntries.length) {
      pendingWorkingEntriesRef.current = [];
      const currentEntries = pendingEntries.flatMap((target) => {
        const match = summary.entries.find(
          (entry) =>
            entry.path === target.path &&
            entry.kind === target.kind &&
            entry.status === target.status,
        );
        return match ? [match] : [];
      });
      for (const target of currentEntries) {
        void loadFileRef.current(target, { userInitiated: true });
      }
    }
    // The shared snapshot is the synchronization boundary; cache adoption is
    // intentionally driven only when that immutable snapshot changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedSummaryState.summary]);

  const diffSelection = useCallback(
    (
      source: DiffCache = cache,
      patch: Partial<ActiveDiffSelection> = {},
    ): ActiveDiffSelection => {
      if (previousFilesRef.current.context !== runtimeContextKey)
        return {
          ...buildActiveDiffSelection(
            emptyDiffCache(),
            {},
            null,
            summaryLoading,
          ),
          selectionRevision: selectionRevisionRef.current,
          loadingKeys: [],
        };
      const fileErrors = patch.fileErrors ?? source.fileErrors;
      const freshFiles = patch.files ?? source.files;
      const selected =
        patch.entry === undefined ? source.selected : patch.entry;
      const entryKeys = new Set(
        (source.summary?.entries ?? (selected ? [selected] : [])).map(
          diffEntryKey,
        ),
      );
      const files = boundedDiffFiles(
        Object.fromEntries(
          [
            ...Object.entries(previousFilesRef.current.files).filter(
              ([key]) => !freshFiles[key],
            ),
            ...Object.entries(freshFiles),
          ].filter(([key]) => entryKeys.has(key) && !fileErrors[key]),
        ),
        selected,
      );
      if (source.summary === previousFilesRef.current.summary)
        previousFilesRef.current.files = Object.fromEntries(
          Object.entries(files).filter(([key]) => !freshFiles[key]),
        );
      return {
        ...buildActiveDiffSelection(
          { ...source, files },
          { ...patch, files },
          fileLoadingKey,
          summaryLoading,
        ),
        selectionRevision: selectionRevisionRef.current,
        loadingKeys,
      };
    },
    [cache, fileLoadingKey, loadingKeys, runtimeContextKey, summaryLoading],
  );

  useEffect(() => {
    onSelectionChangeRef.current?.(diffSelection(cache));
  }, [cache, diffSelection]);

  const loadSummary = async (
    previousSelected = cache.selected,
    afterCurrent = false,
    clearCurrent = false,
  ) => {
    if (!workspace?.workspace_id || !connectionClient.isCurrent()) return;
    const workspaceId = workspace.workspace_id;
    const scope = diffScope;
    preferredSummarySelectionRef.current = previousSelected;
    advanceDiffCacheRevision(
      diffCacheKey(connectionClient, workspaceId, scope, cacheResourceKey),
    );
    pendingFileKeysRef.current = new Map();
    setLoadingKeys([]);
    setFileLoadingKey(null);
    if (clearCurrent) previousFilesRef.current.files = {};
    updateCache(
      clearCurrent
        ? {
            summary: null,
            selected: null,
            files: {},
            fileErrors: {},
            error: null,
          }
        : { error: null },
    );
    try {
      await refreshGitDiffSummary(
        connectionClient,
        workspaceId,
        scope,
        cacheResourceKey,
        { afterCurrent },
      );
    } catch (e) {
      if (isCurrentContext(workspaceId, scope)) {
        updateCache({ error: (e as Error).message });
      }
    }
  };

  useEffect(() => {
    const previous = completionRevisionRef.current;
    completionRevisionRef.current = {
      key: completionKey,
      revision: completionRevision,
    };
    if (
      !cacheWorkspaceId ||
      previous.key !== completionKey ||
      previous.revision === completionRevision
    ) {
      return;
    }

    if (diffScopeRef.current === "last-step") {
      retireGitDiffSummary(
        connectionClient,
        cacheWorkspaceId,
        "last-step",
        cacheResourceKey,
      );
      void loadSummary(cache.selected, false, true);
      return;
    }
    retireDiffCache(
      diffCacheKey(
        connectionClient,
        cacheWorkspaceId,
        "last-step",
        cacheResourceKey,
      ),
    );
    retireGitDiffSummary(
      connectionClient,
      cacheWorkspaceId,
      "last-step",
      cacheResourceKey,
    );
    // Completion notifications are not debounced with pane-list refreshes, so
    // rapid quiet-to-active edges cannot leave the prior step cached forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheWorkspaceId, completionKey, completionRevision]);

  const loadFile = async (
    entry: GitDiffEntry,
    meta: DiffSelectionMeta = {},
    select = true,
  ) => {
    if (!workspace?.workspace_id || !connectionClient.isCurrent()) return;
    const workspaceId = workspace.workspace_id;
    const scope = diffScope;
    const key = diffEntryKey(entry);
    const cacheKey = diffCacheKey(
      connectionClient,
      workspaceId,
      scope,
      cacheResourceKey,
    );
    const revision = diffCacheRevision(cacheKey);
    if (meta.userInitiated) {
      selectionRevisionRef.current += 1;
      explicitEntryKeysRef.current.add(key);
    }
    const wanted = () =>
      isCurrentContext(workspaceId, scope) &&
      diffCacheRevision(cacheKey) === revision &&
      (selectedEntryKeyRef.current === key ||
        nearbyEntryKeysRef.current.has(key) ||
        selectedBatchEntryKeysRef.current.has(key));
    if (
      !select &&
      (pendingFileKeysRef.current.has(key) ||
        cache.files[key] ||
        cache.fileErrors[key])
    )
      return;
    const automatic =
      !meta.userInitiated && !explicitEntryKeysRef.current.has(key);
    if (select) {
      if (meta.userInitiated) setVisibleEntryKey(null);
      selectedEntryKeyRef.current = key;
      setCache((current) => {
        const next = beginDiffFileSelection(current, entry);
        writeDiffCache(
          connectionClient,
          cacheWorkspaceId,
          scope,
          next,
          cacheResourceKey,
        );
        return next;
      });
      const immediateFileErrors = { ...cache.fileErrors };
      delete immediateFileErrors[key];
      writeStoredSelection(
        connectionClient.connectionId,
        cacheResourceKey,
        scope,
        entry,
      );
      const cachedFile = cache.files[key];
      if (cachedFile && !cachedFile.deferred) {
        setFileLoadingKey(null);
        onSelectionChangeRef.current?.(
          diffSelection(cache, {
            entry,
            file: cachedFile,
            fileErrors: immediateFileErrors,
            error: null,
          }),
          meta,
        );
        return;
      }
      setFileLoadingKey(key);
      onSelectionChangeRef.current?.(
        diffSelection(cache, {
          entry,
          file: null,
          loading: true,
          error: null,
          fileErrors: immediateFileErrors,
        }),
        meta,
      );
    }
    pendingFileKeysRef.current.set(
      key,
      (pendingFileKeysRef.current.get(key) ?? 0) + 1,
    );
    setLoadingKeys(Array.from(pendingFileKeysRef.current.keys()));
    try {
      const file = await requestDiffFile(
        connectionClient,
        workspaceId,
        scope,
        entry,
        revision,
        cache.summary?.snapshot_id,
        wanted,
        select,
        automatic,
      );
      if (
        !isCurrentContext(workspaceId, scope) ||
        diffCacheRevision(cacheKey) !== revision
      ) {
        return;
      }
      setCache((current) => {
        if (diffCacheRevision(cacheKey) !== revision) return current;
        const next = mergeResolvedDiffFile(current, entry, file);
        writeDiffCache(
          connectionClient,
          cacheWorkspaceId,
          scope,
          next,
          cacheResourceKey,
        );
        return next;
      });
      if (
        select &&
        selectedEntryKeyRef.current === key &&
        !(file.deferred && explicitEntryKeysRef.current.has(key))
      ) {
        onSelectionChangeRef.current?.(
          diffSelection(cache, {
            entry,
            file,
            files: boundedDiffFiles({ ...cache.files, [key]: file }, entry),
            fileErrors: Object.fromEntries(
              Object.entries(cache.fileErrors).filter(
                ([errorKey]) => errorKey !== key,
              ),
            ),
            loading: false,
            error: null,
          }),
          meta,
        );
      }
    } catch (e) {
      if (!wanted() || diffCacheRevision(cacheKey) !== revision) {
        return;
      }
      const message = (e as Error).message;
      setCache((current) => {
        if (diffCacheRevision(cacheKey) !== revision) return current;
        const requestIsSelected =
          current.selected !== null && diffEntryKey(current.selected) === key;
        const next = {
          ...current,
          error: requestIsSelected ? message : current.error,
          fileErrors: { ...current.fileErrors, [key]: message },
        };
        writeDiffCache(
          connectionClient,
          cacheWorkspaceId,
          scope,
          next,
          cacheResourceKey,
        );
        return next;
      });
      if (select && selectedEntryKeyRef.current === key) {
        onSelectionChangeRef.current?.(
          diffSelection(cache, {
            entry,
            file: null,
            loading: false,
            error: message,
            fileErrors: { ...cache.fileErrors, [key]: message },
          }),
          meta,
        );
      }
    } finally {
      if (
        isCurrentContext(workspaceId, scope) &&
        diffCacheRevision(cacheKey) === revision
      ) {
        const pending = (pendingFileKeysRef.current.get(key) ?? 1) - 1;
        if (pending > 0) pendingFileKeysRef.current.set(key, pending);
        else pendingFileKeysRef.current.delete(key);
        setLoadingKeys(Array.from(pendingFileKeysRef.current.keys()));
        setFileLoadingKey((current) => (current === key ? null : current));
      }
    }
  };

  const loadFileRef = useRef(loadFile);
  useLayoutEffect(() => {
    loadFileRef.current = loadFile;
  });
  const loadNearbyEntriesRef = useRef<(entries: GitDiffEntry[]) => void>(
    () => {},
  );
  loadNearbyEntriesRef.current = (entries) => {
    nearbyEntryKeysRef.current = new Set(entries.map(diffEntryKey));
    if (!continuousReview || !cache.summary) return;
    for (const entry of entries.slice(0, 12)) {
      const current = cache.summary.entries.find(
        (candidate) => diffEntryKey(candidate) === diffEntryKey(entry),
      );
      if (
        current &&
        !diffAutoCollapseInfo(current, cache.files[diffEntryKey(current)])
      ) {
        void loadFileRef.current(current, {}, false);
      }
    }
  };
  useImperativeHandle(ref, () => {
    const selectWorkingEntries = (targets: GitDiffEntry[]) => {
      if (!targets.length) return;
      selectedBatchEntryKeysRef.current = new Set(targets.map(diffEntryKey));
      if (diffScopeRef.current === "working") {
        for (const target of targets) {
          void loadFileRef.current(target, { userInitiated: true });
        }
        return;
      }
      pendingWorkingEntriesRef.current = targets;
      setDiffScope("working");
    };
    return {
      highlightEntry: (entry) => {
        setVisibleEntryKey(entry ? diffEntryKey(entry) : null);
        if (entry)
          setExpandedDirs((current) => {
            const next = new Set(current);
            for (const path of expandedDirsForSelection(entry)) next.add(path);
            return next.size === current.size ? current : next;
          });
      },
      loadNearbyEntries: (entries) => loadNearbyEntriesRef.current(entries),
      selectEntry: (target) => {
        selectedBatchEntryKeysRef.current.clear();
        void loadFileRef.current(target, { userInitiated: true });
      },
      selectWorkingEntry: (target) => selectWorkingEntries([target]),
      selectWorkingEntries,
    };
  }, []);

  const selectedDiffEntryKey = cache.selected
    ? diffEntryKey(cache.selected)
    : "";
  const selectedDiffFile = selectedDiffEntryKey
    ? cache.files[selectedDiffEntryKey]
    : undefined;

  useEffect(() => {
    roamgateLocalStorage.setItem(
      diffScopeStorageKey(connectionClient.connectionId, cacheResourceKey),
      diffScope,
    );
  }, [cacheResourceKey, connectionClient.connectionId, diffScope]);

  useEffect(() => {
    const cached = readDiffCache(
      connectionClient,
      cacheWorkspaceId,
      diffScope,
      cacheResourceKey,
    );
    previousFilesRef.current = {
      context: runtimeContextKey,
      summary: cached.summary,
      files: {},
    };
    nearbyEntryKeysRef.current.clear();
    explicitEntryKeysRef.current.clear();
    pendingFileKeysRef.current = new Map();
    setLoadingKeys([]);
    setFileLoadingKey(null);
    selectedEntryKeyRef.current = cached.selected
      ? diffEntryKey(cached.selected)
      : "";
    const pendingWorkingEntries =
      diffScope === "working" ? pendingWorkingEntriesRef.current : [];
    const preferredWorkingEntry =
      pendingWorkingEntries[pendingWorkingEntries.length - 1] ?? null;
    setCache(cached);
    setExpandedDirs(
      expandedDirsForEntries(
        cached.summary?.entries ?? (cached.selected ? [cached.selected] : []),
      ),
    );
    onSelectionChangeRef.current?.({
      entry: cached.selected,
      file: cached.selected
        ? (cached.files[diffEntryKey(cached.selected)] ?? null)
        : null,
      loading: false,
      error: cached.error,
      entries: treeOrderedDiffEntries(cached.summary?.entries ?? []),
      files: cached.files,
      fileErrors: cached.fileErrors,
      summaryLoading: false,
    });
    void loadSummary(preferredWorkingEntry ?? cached.selected);
    // Reopen against a fresh workspace snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheResourceKey, cacheWorkspaceId, connectionClient, diffScope]);

  useEffect(() => {
    if (cache.summary !== previousFilesRef.current.summary) return;
    if (cache.selected) {
      const explicit = explicitEntryKeysRef.current.has(selectedDiffEntryKey);
      if (
        explicit ||
        (continuousReview &&
          !diffAutoCollapseInfo(cache.selected, selectedDiffFile))
      ) {
        void loadFile(cache.selected);
      }
    } else {
      onSelectionChangeRef.current?.(
        diffSelection(cache, {
          entry: null,
          file: null,
          loading: false,
          error: null,
        }),
      );
    }
    // Load the selected file whenever summary refresh changes selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    cacheWorkspaceId,
    connectionClient,
    diffScope,
    cache.summary,
    selectedDiffEntryKey,
    selectedDiffFile,
    continuousReview,
  ]);

  const selectedKey = cache.summary?.entries.some(
    (entry) => diffEntryKey(entry) === visibleEntryKey,
  )
    ? visibleEntryKey
    : cache.selected
      ? diffEntryKey(cache.selected)
      : null;
  useEffect(() => {
    if (!visibleEntryKey || selectedKey !== visibleEntryKey) return;
    treeRef.current
      ?.querySelector<HTMLElement>(".diff-tree-file.is-selected")
      ?.scrollIntoView({ block: "nearest" });
  }, [expandedDirs, selectedKey, visibleEntryKey]);
  const tree = useMemo(
    () => buildDiffTree(cache.summary?.entries ?? []),
    [cache.summary?.entries],
  );
  const workingCounts = useMemo(
    () => countWorkingEntries(cache.summary?.entries ?? []),
    [cache.summary?.entries],
  );

  const clearLongPressTimer = () => {
    if (!longPressTimerRef.current) return;
    clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  };

  useEffect(() => {
    return () => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    };
  }, []);

  const openContextMenu = (
    target: {
      path: string;
      entries: GitDiffEntry[];
      directory?: boolean;
    },
    x: number,
    y: number,
  ) => {
    if (diffScopeRef.current !== "working") return;
    clearLongPressTimer();
    setContextMenu({ x, y, ...target });
  };

  const handleEntryPointerDown = (
    event: ReactPointerEvent<HTMLElement>,
    target: {
      path: string;
      entries: GitDiffEntry[];
      directory?: boolean;
    },
  ) => {
    if (event.pointerType === "mouse") return;
    longPressTriggeredRef.current = false;
    longPressStartRef.current = { x: event.clientX, y: event.clientY };
    clearLongPressTimer();
    longPressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      openContextMenu(target, event.clientX, event.clientY);
    }, LONG_PRESS_MS);
  };

  const handleEntryPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const start = longPressStartRef.current;
    if (!start) return;
    const dx = Math.abs(event.clientX - start.x);
    const dy = Math.abs(event.clientY - start.y);
    if (dx > LONG_PRESS_MOVE_PX || dy > LONG_PRESS_MOVE_PX) {
      clearLongPressTimer();
      longPressStartRef.current = null;
    }
  };

  const handleEntryPointerEnd = () => {
    clearLongPressTimer();
    longPressStartRef.current = null;
  };

  const copyPath = (path: string, label: string) => {
    void copyTextFromUserGesture(path).then(
      () =>
        store.notify({
          kind: "success",
          message: `${label} copied`,
          detail: path,
          autoDismissMs: 5000,
        }),
      (error) =>
        store.notify({
          kind: "error",
          message: `Failed to copy ${label.toLowerCase()}`,
          detail: error instanceof Error ? error.message : String(error),
        }),
    );
  };

  const afterGitMutation = async (workspaceId: string) => {
    bumpFileExplorerRefresh(connectionClient, workspaceId);
    await loadSummary(cache.selected, true);
  };

  const runGitFileMenuAction = (
    item: GitFileMenuItem,
    menu: DiffContextMenuState,
  ) => {
    const actionWorkspaceId = workspace?.workspace_id;
    if (!actionWorkspaceId) return;
    const matches = menu.entries.filter((entry) =>
      item.action === "discard_unstaged"
        ? entry.kind === "unstaged"
        : item.action === "delete_untracked"
          ? entry.kind === "untracked"
          : item.action === "unstage"
            ? entry.kind === "staged"
            : entry.kind !== "staged",
    );
    const targets = menu.directory
      ? matches.length
        ? matches
        : menu.entries
      : [matches[0] ?? menu.entries[0]].filter(
          (entry): entry is GitDiffEntry => !!entry,
        );
    if (!targets.length) return;
    const execute = async () => {
      if (menu.directory && targets.length > 1) {
        await store.runGitFileActionBatch(
          actionWorkspaceId,
          item.action,
          targets,
        );
        // A failed batch can still have changed earlier files.
      } else {
        const result = await store.runGitFileAction(
          actionWorkspaceId,
          item.action,
          targets[0],
        );
        if (!result) return;
      }
      await afterGitMutation(actionWorkspaceId);
    };
    if (item.destructive) {
      const copy = menu.directory
        ? gitFolderConfirmCopy(item.action, menu.path, targets.length)
        : gitFileConfirmCopy(item.action, targets[0].path);
      if (copy) {
        setConfirmState({ ...copy, run: () => void execute() });
        return;
      }
    }
    void execute();
  };

  const runGitRepoMenuAction = (item: GitRepoMenuItem) => {
    const actionWorkspaceId = workspace?.workspace_id;
    if (!actionWorkspaceId) return;
    const execute = async () => {
      const result = await store.runGitRepoAction(
        actionWorkspaceId,
        item.action,
        workingCounts,
      );
      if (!result) return;
      await afterGitMutation(actionWorkspaceId);
    };
    if (item.destructive) {
      const copy = gitRepoConfirmCopy(item.action, item.count);
      if (copy) {
        setConfirmState({ ...copy, run: () => void execute() });
        return;
      }
    }
    void execute();
  };

  const toggleDir = (path: string) => {
    setExpandedDirs((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderTreeNode = (node: DiffTreeNode, depth: number): ReactNode[] => {
    const items: ReactNode[] = [];
    const children = sortDiffTreeChildren(node.children.values());

    for (const child of children) {
      const isFile = child.entries.length > 0;
      const open = expandedDirs.has(child.path);
      if (!isFile) {
        items.push(
          <button
            type="button"
            className="diff-tree-row diff-tree-folder"
            style={{
              paddingLeft: DIFF_TREE_BASE_INDENT + depth * DIFF_TREE_INDENT,
            }}
            key={child.path}
            onClick={() => {
              if (longPressTriggeredRef.current) {
                longPressTriggeredRef.current = false;
                return;
              }
              toggleDir(child.path);
            }}
            onContextMenu={(event) => {
              if (diffScope !== "working") return;
              event.preventDefault();
              event.stopPropagation();
              openContextMenu(
                {
                  path: child.path,
                  entries: collectTreeEntries(child),
                  directory: true,
                },
                event.clientX,
                event.clientY,
              );
            }}
            onKeyDown={(event) => {
              if (diffScope !== "working") return;
              if (
                treeKeyboardAction(event.key, event.shiftKey) !== "context-menu"
              ) {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              const point = keyboardContextMenuPoint(event.currentTarget);
              openContextMenu(
                {
                  path: child.path,
                  entries: collectTreeEntries(child),
                  directory: true,
                },
                point.x,
                point.y,
              );
            }}
            onPointerDown={(event) =>
              handleEntryPointerDown(event, {
                path: child.path,
                entries: collectTreeEntries(child),
                directory: true,
              })
            }
            onPointerMove={handleEntryPointerMove}
            onPointerUp={handleEntryPointerEnd}
            onPointerCancel={handleEntryPointerEnd}
            onPointerLeave={handleEntryPointerEnd}
          >
            <span className="diff-tree-twisty">
              {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </span>
            <Folder size={15} />
            <span className="diff-tree-name">{child.name}</span>
          </button>,
        );
        if (open) items.push(...renderTreeNode(child, depth + 1));
        continue;
      }

      const primary = child.entries[0];
      const selected = child.entries.some(
        (entry) => diffEntryKey(entry) === selectedKey,
      );
      const stats = diffStatsForEntries(child.entries);
      const statusCodes = Array.from(
        new Set(child.entries.map((entry) => gitDiffCode(entry))),
      ).sort();
      items.push(
        <button
          type="button"
          key={child.path}
          className={`diff-tree-row diff-tree-file ${selected ? "is-selected" : ""}`}
          aria-current={selected ? "true" : undefined}
          style={{
            paddingLeft: DIFF_TREE_BASE_INDENT + depth * DIFF_TREE_INDENT,
          }}
          onClick={() => {
            if (longPressTriggeredRef.current) {
              longPressTriggeredRef.current = false;
              return;
            }
            void loadFile(primary, { userInitiated: true });
          }}
          onContextMenu={(event) => {
            if (diffScope !== "working") return;
            event.preventDefault();
            event.stopPropagation();
            openContextMenu(child, event.clientX, event.clientY);
          }}
          onKeyDown={(event) => {
            if (diffScope !== "working") return;
            if (
              treeKeyboardAction(event.key, event.shiftKey) !== "context-menu"
            ) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            const point = keyboardContextMenuPoint(event.currentTarget);
            openContextMenu(child, point.x, point.y);
          }}
          onPointerDown={(event) => handleEntryPointerDown(event, child)}
          onPointerMove={handleEntryPointerMove}
          onPointerUp={handleEntryPointerEnd}
          onPointerCancel={handleEntryPointerEnd}
          onPointerLeave={handleEntryPointerEnd}
        >
          <span className="diff-tree-twisty" />
          <File size={15} />
          <span className="diff-tree-name">{child.name}</span>
          <span className="diff-tree-badges">
            {statusCodes.map((code) => (
              <span
                className={`git-status-code git-status-${code.toLowerCase()}`}
                key={code}
                role="img"
                aria-label={gitDiffCodeLabel(code)}
                title={gitDiffCodeLabel(code)}
              >
                {code}
              </span>
            ))}
          </span>
          {stats.hasStats ? (
            <span className="diff-tree-stats" aria-label="Line changes">
              <span className="diff-stat-add">+{stats.additions}</span>
              <span className="diff-stat-del">-{stats.deletions}</span>
            </span>
          ) : null}
        </button>,
      );
    }
    return items;
  };

  return (
    <aside className="diff-viewer-side" aria-label="Diff Viewer">
      <div className="diff-panel-toolbar">
        <div className="diff-scope-toggle" aria-label="Diff scope">
          <button
            type="button"
            className={diffScope === "last-step" ? "is-active" : ""}
            onClick={() => setDiffScope("last-step")}
            aria-pressed={diffScope === "last-step"}
            aria-label="Last step"
            title="Last step"
          >
            <span className="diff-scope-label-full" aria-hidden="true">
              Last step
            </span>
            <span className="diff-scope-label-short" aria-hidden="true">
              Last
            </span>
          </button>
          <button
            type="button"
            className={diffScope === "working" ? "is-active" : ""}
            onClick={() => setDiffScope("working")}
            aria-pressed={diffScope === "working"}
            aria-label="Working tree"
            title="Working tree"
          >
            <span className="diff-scope-label-full" aria-hidden="true">
              Working tree
            </span>
            <span className="diff-scope-label-short" aria-hidden="true">
              Working
            </span>
          </button>
          <button
            type="button"
            className={diffScope === "branch-main" ? "is-active" : ""}
            onClick={() => setDiffScope("branch-main")}
            aria-pressed={diffScope === "branch-main"}
            aria-label="Against main"
            title="Against main"
          >
            <span className="diff-scope-label-full" aria-hidden="true">
              Against main
            </span>
            <span className="diff-scope-label-short" aria-hidden="true">
              Main
            </span>
          </button>
        </div>
        <div
          className="diff-toolbar-actions"
          role="group"
          aria-label="Diff actions"
        >
          <button
            type="button"
            className="diff-refresh"
            title={summaryLoading ? "Refreshing..." : "Refresh"}
            aria-label={
              summaryLoading ? "Refreshing changes" : "Refresh changes"
            }
            aria-busy={summaryLoading}
            disabled={summaryLoading}
            onClick={() => void loadSummary(cache.selected, true)}
          >
            <RefreshCw
              className={summaryLoading ? "is-spinning" : ""}
              size={15}
            />
          </button>
        </div>
      </div>

      {!workspace ? (
        <p className="modal-error">No workspace is focused.</p>
      ) : null}

      {cache.error ? <p className="modal-error">{cache.error}</p> : null}

      <div
        ref={treeRef}
        className="diff-list diff-tree"
        aria-label="Changed files"
      >
        {summaryLoading && !cache.summary ? (
          <DiffSkeleton />
        ) : cache.summary?.entries.length ? (
          renderTreeNode(tree, 0)
        ) : (
          <div className="diff-empty">
            <FileDiff size={18} />
            <span>
              {diffScope === "last-step" &&
              cache.summary?.baseline_available === false
                ? "No completed agent step yet"
                : "No changes"}
            </span>
          </div>
        )}
      </div>
      {fileLoadingKey ? (
        <div className="diff-loading-inline">Loading diff...</div>
      ) : null}
      {contextMenu ? (
        <ActionsMenu
          x={contextMenu.x}
          y={contextMenu.y}
          header={{ title: contextMenu.path, subtitle: "Git" }}
          groups={[
            {
              label: contextMenu.directory ? "Folder" : "File",
              items: [
                ...(!contextMenu.directory &&
                onOpenFile &&
                contextMenu.entries[0]
                  ? [
                      {
                        key: "open",
                        label: "Open file",
                        action: () => onOpenFile(contextMenu.entries[0]!),
                      },
                    ]
                  : []),
                {
                  key: "copy-relative",
                  label: "Copy relative path",
                  action: () => copyPath(contextMenu.path, "Relative path"),
                },
                ...(cache.summary?.root
                  ? [
                      {
                        key: "copy-absolute",
                        label: "Copy absolute path",
                        action: () =>
                          copyPath(
                            `${cache.summary?.root}/${contextMenu.path}`,
                            "Absolute path",
                          ),
                      },
                    ]
                  : []),
                ...(canReveal && cache.summary?.root && workspace?.workspace_id
                  ? [
                      {
                        key: "reveal",
                        label: revealMenuLabel(!!contextMenu.directory),
                        action: () =>
                          void revealInFileManager(
                            connectionClient,
                            workspace.workspace_id,
                            contextMenu.path,
                            "changes",
                          ),
                      },
                    ]
                  : []),
              ],
            },
            {
              label: "Git",
              items: buildGitFileMenuItems(
                contextMenu.entries,
                contextMenu.directory,
              ).map((item) => ({
                key: item.action,
                label: item.label,
                danger: item.danger,
                action: () => runGitFileMenuAction(item, contextMenu),
              })),
            },
            {
              label: "Repository",
              items: buildGitRepoMenuItems(workingCounts).map((item) => ({
                key: item.action,
                label: item.label,
                danger: item.danger,
                disabled: item.count === 0,
                detail: String(item.count),
                action: () => runGitRepoMenuAction(item),
              })),
            },
          ].filter((group) => group.items.length > 0)}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
      <ConfirmDialog
        open={!!confirmState}
        title={confirmState?.title ?? ""}
        message={confirmState?.message ?? ""}
        confirmLabel={confirmState?.confirmLabel ?? "Confirm"}
        danger
        onClose={() => setConfirmState(null)}
        onConfirm={() => confirmState?.run()}
      />
    </aside>
  );
});

function DiffSkeleton() {
  return (
    <div className="diff-skeleton-list">
      {Array.from({ length: 4 }, (_, index) => (
        <div className="diff-skeleton-row" key={index}>
          <span className="diff-skeleton-badge" />
          <span className="diff-skeleton-lines">
            <span className="diff-skeleton-line diff-skeleton-line-name" />
            <span className="diff-skeleton-line diff-skeleton-line-status" />
          </span>
        </div>
      ))}
    </div>
  );
}

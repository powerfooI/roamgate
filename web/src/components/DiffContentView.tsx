import { imageMimeForPath } from "../../../shared/filePreview";
import { roamgateLocalStorage } from "../browserStorage";
import { shortcutMatches } from "../shortcutPreferences";
import {
  DEFAULT_THEMES,
  getSingularPatch,
  type SelectedLineRange,
} from "@pierre/diffs";
import {
  FileDiff,
  Virtualizer,
  WorkerPoolContextProvider,
  type WorkerInitializationRenderOptions,
  type WorkerPoolOptions,
} from "@pierre/diffs/react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FolderOpen,
  MessageSquareText,
  Search,
  X,
} from "lucide-react";
import {
  Component,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import type { ConnectionClient } from "../api";
import {
  diffReviewLineLabel,
  findDiffReviewSelection,
  type DiffReviewAnnotation,
  type NewReviewAnnotation,
  type ReviewAnnotation,
} from "../annotations";
import type {
  FilePreview,
  GitDiffEntry,
  GitDiffFile,
  GitDiffKind,
} from "../types";
import { connectionClientScopeKey } from "../useConnectionClient";
import { gitDiffCode, gitDiffCodeLabel } from "../gitDiffStatus";
import { requestFilePreview } from "./fileExplorerResources";
import {
  AnnotationComposerPopover,
  type AnnotationComposerDraft,
} from "./AnnotationComposerPopover";
import {
  diffAutoCollapseInfo,
  type DiffAutoCollapseInfo,
} from "./diffAutoCollapse";
import {
  readDiffCollapseState,
  writeDiffCollapseState,
  expandDiffEntryOnActivate,
} from "./diffContentState";
import { diffSyntaxLanguageForPath } from "./diffSyntaxHighlighting";
import "./DiffContentView.css";

type DiffViewMode = "split" | "unified";
type AppTheme = "dark" | "light";
type PierreDiffOptions = NonNullable<
  ComponentProps<typeof FileDiff<DiffReviewAnnotation>>["options"]
>;

const DIFF_VIEW_MODE_KEY = "diffViewMode";
const DESKTOP_DIFF_WRAP_KEY = "desktopDiffWrap";
const MOBILE_DIFF_WRAP_KEY = "mobileDiffWrap";
const EMPTY_DIFF_REVIEW_ANNOTATIONS: readonly DiffReviewAnnotation[] = [];
const DIFF_WORKER_POOL_OPTIONS: WorkerPoolOptions = {
  poolSize: Math.min(
    Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1),
    globalThis.matchMedia?.("(pointer: coarse)")?.matches ? 1 : 2,
  ),
  totalASTLRUCacheSize: 8,
  workerFactory: () =>
    new Worker(new URL("@pierre/diffs/worker/worker.js", import.meta.url), {
      type: "module",
    }),
};
const DIFF_HIGHLIGHTER_OPTIONS: WorkerInitializationRenderOptions = {
  theme: DEFAULT_THEMES,
  preferredHighlighter: "shiki-wasm",
};
const DIFF_SELECTION_CSS = `
  [data-line][data-selected-line] {
    background-color: color-mix(
      in srgb,
      var(--diffs-selection-base) 32%,
      var(--diffs-computed-diff-line-bg)
    ) !important;
    box-shadow: inset 3px 0 0 var(--diffs-selection-base);
  }
  [data-column-number][data-selected-line] {
    background-color: color-mix(
      in srgb,
      var(--diffs-selection-base) 46%,
      var(--diffs-bg)
    ) !important;
    color: var(--diffs-fg) !important;
    font-weight: 800;
  }
  [data-line][data-selected-line="first"] {
    border-top: 1px solid var(--diffs-selection-base);
  }
  [data-line][data-selected-line="last"] {
    border-bottom: 1px solid var(--diffs-selection-base);
  }
  [data-line][data-selected-line="single"] {
    border-block: 1px solid var(--diffs-selection-base);
  }
`;

type ImagePreviewState = {
  preview: FilePreview | null;
  loading: boolean;
  error: string | null;
};

type ImagePreviewTarget = {
  key: string;
  file: GitDiffFile;
};

function startImagePreviewRequest(
  target: ImagePreviewTarget,
  client: ConnectionClient,
  isCurrent: () => boolean,
  onComplete: (key: string, state: ImagePreviewState) => void,
) {
  void requestFilePreview(target.file.workspace_id, target.file.path, {
    client,
    refresh: true,
  })
    .then((preview) => {
      if (!isCurrent()) return;
      onComplete(target.key, { preview, loading: false, error: null });
    })
    .catch((error) => {
      if (!isCurrent()) return;
      onComplete(target.key, {
        preview: null,
        loading: false,
        error: (error as Error).message,
      });
    });
}

type DiffSearchGroup = {
  key: string;
};

type DiffAnnotationRequest = {
  x: number;
  y: number;
  path: string;
  kind: GitDiffKind;
  side: "old" | "new";
  line: number;
  endSide?: "old" | "new";
  endLine?: number;
  quote: string;
  hunk: string;
};

type DiffSection = {
  key: string;
  active: boolean;
  entry: GitDiffEntry;
  file: GitDiffFile | null;
  imagePreview: boolean;
  autoCollapse: DiffAutoCollapseInfo | null;
  collapsed: boolean;
  error: string | null;
};

export type DiffHunkTarget = {
  oldLine: number | null;
  newLine: number | null;
};

export function nextDiffHunkIndex(
  current: number,
  delta: -1 | 1,
  count: number,
) {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return delta > 0 ? 0 : count - 1;
  return (current + delta + count) % count;
}

export function diffHunkTargets(patch: string): DiffHunkTarget[] {
  const targets: DiffHunkTarget[] = [];
  const lines = patch.split("\n");
  let oldLine = 0;
  let newLine = 0;
  let target: DiffHunkTarget | null = null;

  for (const line of lines) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      if (target) targets.push(target);
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      target = { oldLine: null, newLine: null };
      continue;
    }
    if (!target) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      target.newLine ??= newLine;
      newLine += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      target.oldLine ??= oldLine;
      oldLine += 1;
    } else if (!line.startsWith("\\")) {
      oldLine += 1;
      newLine += 1;
    }
  }
  if (target) targets.push(target);
  return targets;
}

function deepQuerySelector(
  root: ParentNode,
  selectors: string[],
): HTMLElement | null {
  for (const selector of selectors) {
    const match = root.querySelector<HTMLElement>(selector);
    if (match) return match;
  }
  for (const element of root.querySelectorAll<HTMLElement>("*")) {
    if (!element.shadowRoot) continue;
    const match = deepQuerySelector(element.shadowRoot, selectors);
    if (match) return match;
  }
  return null;
}

function loadDiffViewMode(): DiffViewMode {
  return roamgateLocalStorage.getItem(DIFF_VIEW_MODE_KEY) === "unified"
    ? "unified"
    : "split";
}

function loadMobileDiffWrap() {
  return roamgateLocalStorage.getItem(MOBILE_DIFF_WRAP_KEY) === "true";
}

function loadDesktopDiffWrap() {
  return roamgateLocalStorage.getItem(DESKTOP_DIFF_WRAP_KEY) !== "false";
}

function currentDocumentTheme(): AppTheme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function useDocumentTheme() {
  const [theme, setTheme] = useState<AppTheme>(() => currentDocumentTheme());

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(currentDocumentTheme());
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  return theme;
}

function diffEntryKey(entry: GitDiffEntry) {
  return `${entry.kind}:${entry.path}`;
}

export function diffContentEntries(
  entries: GitDiffEntry[],
  entry: GitDiffEntry | null,
) {
  return entries.length ? entries : entry ? [entry] : [];
}

export function isImageDiff(path: string, diff: string) {
  return imageMimeForPath(path) !== null && (!diff || isBinaryDiffText(diff));
}

function isBinaryDiffText(diff: string) {
  return /^Binary files\b/m.test(diff) || /^GIT binary patch\b/m.test(diff);
}

function imagePreviewKey(client: ConnectionClient, file: GitDiffFile) {
  return connectionClientScopeKey(
    client,
    "diff-image-preview",
    file.workspace_id,
    file.path,
  );
}

function isEditableSearchTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(".diff-search")) return false;
  if (target.closest(".cm-editor")) return true;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function literalSearchPattern(query: string) {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
}

export function diffSearchGroups(
  entries: GitDiffEntry[],
  files: Record<string, GitDiffFile>,
  query: string,
) {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return { groups: [] as DiffSearchGroup[], count: 0 };
  }
  const pattern = literalSearchPattern(normalizedQuery);
  const groups: DiffSearchGroup[] = [];
  for (const entry of entries) {
    const key = diffEntryKey(entry);
    const diff = files[key]?.diff;
    if (!diff || isBinaryDiffText(diff)) continue;
    if (pattern.test(diff)) groups.push({ key });
  }
  return { groups, count: groups.length };
}

function searchEntryKey(groups: DiffSearchGroup[], index: number) {
  return index < 0 ? null : (groups[index]?.key ?? null);
}

function DiffImagePreview({
  state,
  path,
}: {
  state?: ImagePreviewState;
  path: string;
}) {
  if (!state || state.loading) {
    return (
      <div className="diff-image-preview">
        <div className="diff-content-state">
          <span className="file-loading-spinner" />
          Loading image preview
        </div>
      </div>
    );
  }
  if (state.error) {
    return (
      <div className="diff-image-preview">
        <div className="diff-content-state is-error">{state.error}</div>
      </div>
    );
  }
  if (!state.preview?.image_data_url) {
    return (
      <div className="diff-image-preview">
        <div className="diff-content-state">Image preview unavailable.</div>
      </div>
    );
  }
  return (
    <div className="diff-image-preview">
      <img
        className="diff-image-preview-img"
        src={state.preview.image_data_url}
        alt={path}
      />
    </div>
  );
}

class DiffRenderBoundary extends Component<
  { fallback: ReactNode; children: ReactNode; resetKey: string },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(previousProps: Readonly<{ resetKey: string }>) {
    if (this.state.failed && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function HighlightedPatch({
  patch,
  path,
  ...props
}: Omit<ComponentProps<typeof FileDiff<DiffReviewAnnotation>>, "fileDiff"> & {
  patch: string;
  path: string;
}) {
  const fileDiff = useMemo(
    () => ({
      ...getSingularPatch(patch),
      lang: diffSyntaxLanguageForPath(path),
    }),
    [patch, path],
  );
  return <FileDiff<DiffReviewAnnotation> {...props} fileDiff={fileDiff} />;
}

function RawPatch({ patch }: { patch: string }) {
  return <pre className="diff-raw-patch">{patch}</pre>;
}

type DiffFileSectionProps = {
  section: DiffSection;
  loading: boolean;
  imagePreviewState?: ImagePreviewState;
  options: PierreDiffOptions;
  currentSearchMatch: boolean;
  embedded: boolean;
  mobile: boolean;
  annotations: readonly DiffReviewAnnotation[];
  annotationSelectionActive: boolean;
  onToggle: (key: string, collapsed: boolean) => void;
  onSelectFile?: (entry: GitDiffEntry) => void;
  onOpenFile?: (entry: GitDiffEntry) => void;
  onRequestAnnotation?: (request: DiffAnnotationRequest) => void;
  onEditAnnotation?: (id: string) => void;
};

const DiffFileSection = memo(function DiffFileSection({
  section,
  loading,
  imagePreviewState,
  options,
  currentSearchMatch,
  embedded,
  mobile,
  annotations,
  annotationSelectionActive,
  onToggle,
  onSelectFile,
  onOpenFile,
  onRequestAnnotation,
  onEditAnnotation,
}: DiffFileSectionProps) {
  const pointerPositionRef = useRef({ x: 0, y: 0 });
  const [selectedLines, setSelectedLines] = useState<SelectedLineRange | null>(
    null,
  );
  const sectionOptions = useMemo<PierreDiffOptions>(
    () => ({
      ...options,
      lineHoverHighlight: onRequestAnnotation ? "number" : "disabled",
      enableLineSelection: Boolean(onRequestAnnotation),
      controlledSelection: Boolean(onRequestAnnotation),
      onLineSelectionStart: onRequestAnnotation ? setSelectedLines : undefined,
      onLineSelectionChange: onRequestAnnotation ? setSelectedLines : undefined,
      onLineSelectionEnd: onRequestAnnotation
        ? (range) => {
            if (!section.file || !range) {
              setSelectedLines(null);
              return;
            }
            const target = findDiffReviewSelection(
              section.file.diff,
              range,
              options.diffStyle === "unified" ? "unified" : "split",
            );
            if (!target) {
              setSelectedLines(null);
              return;
            }
            onRequestAnnotation({
              x: pointerPositionRef.current.x + 6,
              y: pointerPositionRef.current.y + 8,
              path: section.entry.path,
              kind: section.entry.kind,
              ...target,
            });
          }
        : undefined,
    }),
    [
      onRequestAnnotation,
      options,
      section.entry.kind,
      section.entry.path,
      section.file,
    ],
  );
  useEffect(() => {
    if (!annotationSelectionActive) setSelectedLines(null);
  }, [annotationSelectionActive]);

  const pierreAnnotations = useMemo(
    () =>
      annotations.map((annotation) => ({
        side:
          annotation.side === "old"
            ? ("deletions" as const)
            : ("additions" as const),
        lineNumber: annotation.line,
        metadata: annotation,
      })),
    [annotations],
  );
  const toggle = () => {
    if (section.active) {
      onToggle(section.key, section.collapsed);
      return;
    }
    onToggle(section.key, true);
    onSelectFile?.(section.entry);
  };

  const statusCode = gitDiffCode(section.entry);
  const metaNote = [
    section.autoCollapse?.label ?? null,
    section.file?.truncated ? "truncated" : null,
    section.collapsed && section.autoCollapse ? "auto-collapsed" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <article
      className={`diff-file-section ${embedded ? "is-embedded" : ""} ${currentSearchMatch ? "is-search-current" : ""}`}
      data-diff-entry-key={section.key}
      aria-current={currentSearchMatch ? "true" : undefined}
      onPointerDownCapture={(event) => {
        pointerPositionRef.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerMoveCapture={(event) => {
        pointerPositionRef.current = { x: event.clientX, y: event.clientY };
      }}
    >
      {embedded ? null : (
        <header className="diff-file-section-head">
          {mobile ? null : (
            <button
              type="button"
              className="diff-file-collapse"
              onClick={toggle}
              disabled={!section.active && !onSelectFile}
              aria-expanded={!section.collapsed}
              aria-label={`${section.collapsed ? "Expand" : "Collapse"} ${section.entry.path}`}
              title={section.collapsed ? "Expand" : "Collapse"}
            >
              {section.collapsed ? (
                <ChevronRight size={14} />
              ) : (
                <ChevronDown size={14} />
              )}
            </button>
          )}
          <div
            className={`diff-file-section-title ${
              mobile && (section.active || onSelectFile) ? "is-toggle" : ""
            }`}
            onClick={
              mobile && (section.active || onSelectFile) ? toggle : undefined
            }
            role={
              mobile && (section.active || onSelectFile) ? "button" : undefined
            }
            tabIndex={
              mobile && (section.active || onSelectFile) ? 0 : undefined
            }
            aria-expanded={
              mobile && (section.active || onSelectFile)
                ? !section.collapsed
                : undefined
            }
            onKeyDown={
              mobile && (section.active || onSelectFile)
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggle();
                    }
                  }
                : undefined
            }
          >
            <strong>{section.entry.path}</strong>
            <span
              className={`git-status-code git-status-${statusCode.toLowerCase()}`}
              role="img"
              aria-label={gitDiffCodeLabel(statusCode)}
              title={gitDiffCodeLabel(statusCode)}
            >
              {statusCode}
            </span>
            {metaNote ? (
              <span className="diff-file-section-meta">{metaNote}</span>
            ) : null}
          </div>
          <button
            type="button"
            className="diff-file-open"
            onClick={() => onOpenFile?.(section.entry)}
            disabled={!onOpenFile}
          >
            <FolderOpen size={14} />
            <span>Open in Files</span>
          </button>
        </header>
      )}
      {section.collapsed ? null : (
        <>
          {mobile ? (
            <div className="diff-file-path-banner" title={section.entry.path}>
              {section.entry.path}
            </div>
          ) : null}
          {section.error ? (
            <div className="diff-content-state is-error">
              <span>{section.error}</span>
              {onSelectFile ? (
                <button
                  type="button"
                  onClick={() => onSelectFile(section.entry)}
                >
                  Retry
                </button>
              ) : null}
            </div>
          ) : null}
          {!section.file && !section.error ? (
            <div className="diff-content-state">
              {loading ? <span className="file-loading-spinner" /> : null}
              {loading ? (
                "Loading diff"
              ) : onSelectFile ? (
                <button
                  type="button"
                  onClick={() => onSelectFile(section.entry)}
                >
                  Load diff
                </button>
              ) : (
                "Select this file to load its diff."
              )}
            </div>
          ) : null}
          {section.file && !section.file.diff && !section.imagePreview ? (
            <div className="diff-content-state">No textual diff available.</div>
          ) : null}
          {section.imagePreview && section.file ? (
            <DiffImagePreview
              state={imagePreviewState}
              path={section.entry.path}
            />
          ) : null}
          {section.file?.truncated ? (
            <div className="diff-truncated">Diff truncated at 512 KB.</div>
          ) : null}
          {section.file?.diff && !section.imagePreview ? (
            <div className="pierre-diff-surface">
              <DiffRenderBoundary
                fallback={<RawPatch patch={section.file.diff} />}
                resetKey={section.file.diff}
              >
                <HighlightedPatch
                  // Remount on patch change: the renderer's line cache
                  // realigns against edited documents and can index out of
                  // range when a reloaded diff replaces the whole patch.
                  key={section.file.diff}
                  patch={section.file.diff}
                  path={section.entry.path}
                  options={sectionOptions}
                  lineAnnotations={pierreAnnotations}
                  selectedLines={
                    onRequestAnnotation ? selectedLines : undefined
                  }
                  renderAnnotation={({ metadata }) => (
                    <button
                      type="button"
                      className={`diff-review-annotation ${metadata.stale ? "is-stale" : ""}`}
                      title="Open review comment"
                      onClick={(event) => {
                        event.stopPropagation();
                        onEditAnnotation?.(metadata.id);
                      }}
                    >
                      <MessageSquareText size={13} />
                      <span>{metadata.comment || "Review comment"}</span>
                    </button>
                  )}
                />
              </DiffRenderBoundary>
            </div>
          ) : null}
        </>
      )}
    </article>
  );
}, areDiffFileSectionPropsEqual);

function areDiffFileSectionPropsEqual(
  previous: Readonly<DiffFileSectionProps>,
  next: Readonly<DiffFileSectionProps>,
) {
  return (
    previous.section.key === next.section.key &&
    previous.section.active === next.section.active &&
    previous.section.entry === next.section.entry &&
    previous.section.file === next.section.file &&
    previous.section.imagePreview === next.section.imagePreview &&
    previous.section.collapsed === next.section.collapsed &&
    previous.section.error === next.section.error &&
    previous.section.autoCollapse?.reason ===
      next.section.autoCollapse?.reason &&
    previous.section.autoCollapse?.label === next.section.autoCollapse?.label &&
    previous.loading === next.loading &&
    previous.imagePreviewState === next.imagePreviewState &&
    previous.options === next.options &&
    previous.currentSearchMatch === next.currentSearchMatch &&
    previous.embedded === next.embedded &&
    previous.mobile === next.mobile &&
    previous.annotations === next.annotations &&
    previous.annotationSelectionActive === next.annotationSelectionActive &&
    previous.onToggle === next.onToggle &&
    previous.onSelectFile === next.onSelectFile &&
    previous.onOpenFile === next.onOpenFile &&
    previous.onRequestAnnotation === next.onRequestAnnotation &&
    previous.onEditAnnotation === next.onEditAnnotation
  );
}

export function DiffContentView({
  selectionRevision = 0,
  entry,
  file,
  loading,
  error,
  entries = [],
  files = {},
  fileErrors = {},
  summaryLoading = false,
  mobile = false,
  resourceKey = "default",
  connectionClient,
  annotations = [],
  onSelectFile,
  onOpenFile,
  onCreateAnnotation,
  onReanchorAnnotations,
  onEditAnnotation,
  embedded = false,
  backAction,
}: {
  selectionRevision?: number;
  entry: GitDiffEntry | null;
  file: GitDiffFile | null;
  loading: boolean;
  error: string | null;
  entries?: GitDiffEntry[];
  files?: Record<string, GitDiffFile>;
  fileErrors?: Record<string, string>;
  summaryLoading?: boolean;
  mobile?: boolean;
  resourceKey?: string;
  connectionClient: ConnectionClient;
  annotations?: readonly ReviewAnnotation[];
  onSelectFile?: (entry: GitDiffEntry) => void;
  onOpenFile?: (entry: GitDiffEntry) => void;
  onCreateAnnotation?: (annotation: NewReviewAnnotation) => void;
  onReanchorAnnotations?: (
    path: string,
    kind: GitDiffKind,
    patch: string,
  ) => void;
  onEditAnnotation?: (id: string) => void;
  embedded?: boolean;
  backAction?: { label: string; onClick: () => void };
}) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const selectFileRef = useRef(onSelectFile);
  const openFileRef = useRef(onOpenFile);
  const [viewMode, setViewMode] = useState<DiffViewMode>(() =>
    loadDiffViewMode(),
  );
  const [desktopWrap, setDesktopWrap] = useState(() => loadDesktopDiffWrap());
  const [mobileWrap, setMobileWrap] = useState(() => loadMobileDiffWrap());
  const [searchQuery, setSearchQuery] = useState("");
  const [pendingAnnotation, setPendingAnnotation] =
    useState<DiffAnnotationRequest | null>(null);
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [searchIndex, setSearchIndex] = useState(-1);
  const [hunkIndex, setHunkIndex] = useState(-1);
  const hunkIndexRef = useRef(-1);
  const hunkNavigationRevisionRef = useRef(0);
  const [imagePreviews, setImagePreviews] = useState<
    Record<string, ImagePreviewState>
  >({});
  const requestedImagePreviewsRef = useRef(new Map<string, GitDiffFile>());
  const imagePreviewRequestSeqRef = useRef(0);
  const imagePreviewRequestByKeyRef = useRef(new Map<string, number>());
  const [manualCollapseStates, setManualCollapseStates] = useState<
    ReadonlyMap<string, boolean>
  >(() => new Map(readDiffCollapseState(resourceKey)));
  const theme = useDocumentTheme();
  const effectiveViewMode: DiffViewMode = mobile ? "unified" : viewMode;
  const wrapEnabled = mobile ? mobileWrap : desktopWrap;
  const activeEntryKey = entry ? diffEntryKey(entry) : "";
  useEffect(() => {
    if (!activeEntryKey) return;
    setManualCollapseStates((current) => {
      const next = expandDiffEntryOnActivate(current, activeEntryKey);
      if (next !== current) writeDiffCollapseState(resourceKey, next);
      return next;
    });
  }, [activeEntryKey, resourceKey, selectionRevision]);
  const filesByKey = useMemo(() => {
    const merged = { ...files };
    if (entry && file) merged[diffEntryKey(entry)] = file;
    return merged;
  }, [entry, file, files]);
  const visibleEntries = useMemo(
    () => diffContentEntries(entries, entry),
    [entries, entry],
  );
  const annotationsByPath = useMemo(() => {
    const grouped = new Map<string, DiffReviewAnnotation[]>();
    for (const annotation of annotations) {
      if (annotation.source !== "diff") continue;
      const key = `${annotation.kind}:${annotation.path}`;
      const pathAnnotations = grouped.get(key);
      if (pathAnnotations) pathAnnotations.push(annotation);
      else grouped.set(key, [annotation]);
    }
    return grouped;
  }, [annotations]);
  const changedFileCount = entries.length || visibleEntries.length;
  const renderedSections = useMemo<DiffSection[]>(
    () =>
      visibleEntries.map((visibleEntry) => {
        const key = diffEntryKey(visibleEntry);
        const diffFile = filesByKey[key] ?? null;
        const imagePreview =
          !!diffFile && isImageDiff(visibleEntry.path, diffFile.diff);
        const autoCollapse = diffAutoCollapseInfo(visibleEntry, diffFile);
        const defaultCollapsed = autoCollapse !== null;
        const active = key === activeEntryKey;
        return {
          key,
          active,
          entry: visibleEntry,
          file: diffFile,
          imagePreview,
          autoCollapse,
          collapsed:
            !embedded &&
            (!active || (manualCollapseStates.get(key) ?? defaultCollapsed)),
          error: fileErrors[key] ?? null,
        };
      }),
    [
      activeEntryKey,
      embedded,
      fileErrors,
      filesByKey,
      manualCollapseStates,
      visibleEntries,
    ],
  );
  const activeSection = renderedSections.find((section) => section.active);
  const renderedKey = `${activeEntryKey}:${activeSection?.file?.diff.length ?? 0}:${renderedSections.length}`;
  const hasExpandedTextDiff = renderedSections.some(
    (section) =>
      !section.collapsed && !!section.file?.diff && !section.imagePreview,
  );
  const imagePreviewTargets = useMemo(
    () =>
      renderedSections.flatMap((section) =>
        !section.collapsed && section.imagePreview && section.file
          ? [
              {
                key: imagePreviewKey(connectionClient, section.file),
                file: section.file,
              },
            ]
          : [],
      ),
    [connectionClient, renderedSections],
  );
  const searchResult = useMemo(
    () => diffSearchGroups(visibleEntries, filesByKey, deferredSearchQuery),
    [deferredSearchQuery, filesByKey, visibleEntries],
  );
  const searchMatchCount = searchResult.count;
  const currentSearchEntryKey = searchEntryKey(
    searchResult.groups,
    searchIndex,
  );
  const hasSearchableDiff = useMemo(
    () => Object.values(filesByKey).some((candidate) => !!candidate.diff),
    [filesByKey],
  );
  const hunkTargets = useMemo(
    () => diffHunkTargets(file?.diff ?? ""),
    [file?.diff],
  );
  const handleSelectFile = useCallback((target: GitDiffEntry) => {
    selectFileRef.current?.(target);
  }, []);
  const handleOpenFile = useCallback((target: GitDiffEntry) => {
    openFileRef.current?.(target);
  }, []);
  const handleRequestAnnotation = useCallback(
    (target: DiffAnnotationRequest) => setPendingAnnotation(target),
    [],
  );
  const closeAnnotationComposer = useCallback(
    () => setPendingAnnotation(null),
    [],
  );
  const saveAnnotation = useCallback(
    (comment: string) => {
      if (!pendingAnnotation || !onCreateAnnotation) return;
      onCreateAnnotation({
        source: "diff",
        path: pendingAnnotation.path,
        kind: pendingAnnotation.kind,
        side: pendingAnnotation.side,
        line: pendingAnnotation.line,
        ...(pendingAnnotation.endSide === undefined
          ? {}
          : { endSide: pendingAnnotation.endSide }),
        ...(pendingAnnotation.endLine === undefined
          ? {}
          : { endLine: pendingAnnotation.endLine }),
        quote: pendingAnnotation.quote,
        hunk: pendingAnnotation.hunk,
        comment,
      });
      setPendingAnnotation(null);
    },
    [onCreateAnnotation, pendingAnnotation],
  );
  const annotationComposerDraft: AnnotationComposerDraft | null =
    pendingAnnotation
      ? {
          x: pendingAnnotation.x,
          y: pendingAnnotation.y,
          title: `${pendingAnnotation.path} · ${diffReviewLineLabel(pendingAnnotation)}`,
          quote: pendingAnnotation.quote,
        }
      : null;
  const goToHunk = useCallback(
    (delta: -1 | 1) => {
      if (!hunkTargets.length) return;
      const nextIndex = nextDiffHunkIndex(
        hunkIndexRef.current,
        delta,
        hunkTargets.length,
      );
      const target = hunkTargets[nextIndex];
      hunkIndexRef.current = nextIndex;
      setHunkIndex(nextIndex);
      const navigationRevision = ++hunkNavigationRevisionRef.current;

      let attempts = 0;
      const reveal = () => {
        if (hunkNavigationRevisionRef.current !== navigationRevision) return;
        const section = sectionRef.current;
        if (!section) return;
        const activeArticle = Array.from(
          section.querySelectorAll<HTMLElement>(".diff-file-section"),
        ).find(
          (candidate) => candidate.dataset.diffEntryKey === activeEntryKey,
        );
        const selectors = [
          target.newLine === null
            ? ""
            : `[data-line='${target.newLine}'][data-line-type='change-addition']`,
          target.oldLine === null
            ? ""
            : `[data-line='${target.oldLine}'][data-line-type='change-deletion']`,
          target.newLine === null
            ? ""
            : `[data-line='${target.newLine}'][data-line-type^='change-']`,
          target.oldLine === null
            ? ""
            : `[data-line='${target.oldLine}'][data-line-type^='change-']`,
        ].filter(Boolean);
        const line = activeArticle
          ? deepQuerySelector(activeArticle, selectors)
          : null;
        if (line) {
          line.scrollIntoView({ behavior: "smooth", block: "center" });
          return;
        }
        attempts += 1;
        if (attempts === 8) {
          const scroller = section.querySelector<HTMLElement>(
            ".pierre-diff-scroll",
          );
          if (scroller) {
            const targetLine = target.newLine ?? target.oldLine ?? 1;
            const maxTargetLine = Math.max(
              1,
              ...hunkTargets.map(
                (candidate) => candidate.newLine ?? candidate.oldLine ?? 1,
              ),
            );
            const ratio = (targetLine - 1) / Math.max(1, maxTargetLine - 1);
            const availableHeight = activeArticle
              ? Math.max(0, activeArticle.scrollHeight - scroller.clientHeight)
              : Math.max(0, scroller.scrollHeight - scroller.clientHeight);
            scroller.scrollTo({
              top: (activeArticle?.offsetTop ?? 0) + ratio * availableHeight,
              behavior: "auto",
            });
          }
        }
        if (attempts < 24) requestAnimationFrame(reveal);
      };
      requestAnimationFrame(reveal);
    },
    [activeEntryKey, hunkTargets],
  );
  const completeImagePreview = useCallback(
    (key: string, state: ImagePreviewState) => {
      setImagePreviews((current) => ({ ...current, [key]: state }));
    },
    [],
  );
  const pierreOptions = useMemo<PierreDiffOptions>(
    () => ({
      theme: DEFAULT_THEMES,
      themeType: theme,
      diffStyle: effectiveViewMode === "split" ? "split" : "unified",
      overflow: wrapEnabled ? "wrap" : "scroll",
      disableFileHeader: true,
      stickyHeader: false,
      diffIndicators: "bars",
      hunkSeparators: "line-info-basic",
      lineDiffType: "word-alt",
      maxLineDiffLength: 2_000,
      tokenizeMaxLineLength: 4_000,
      tokenizeMaxLength: 250_000,
      preferredHighlighter: "shiki-wasm",
      unsafeCSS: DIFF_SELECTION_CSS,
    }),
    [effectiveViewMode, theme, wrapEnabled],
  );

  useEffect(() => {
    hunkIndexRef.current = -1;
    hunkNavigationRevisionRef.current += 1;
    setHunkIndex(-1);
    setPendingAnnotation(null);
  }, [activeEntryKey, file?.diff]);

  useEffect(() => {
    if (!onReanchorAnnotations) return;
    for (const section of renderedSections) {
      if (section.file?.diff && !section.file.truncated) {
        onReanchorAnnotations(
          section.entry.path,
          section.entry.kind,
          section.file.diff,
        );
      }
    }
  }, [onReanchorAnnotations, renderedSections]);

  useEffect(() => {
    selectFileRef.current = onSelectFile;
  }, [onSelectFile]);
  useEffect(() => {
    openFileRef.current = onOpenFile;
  }, [onOpenFile]);
  useEffect(() => {
    roamgateLocalStorage.setItem(DIFF_VIEW_MODE_KEY, viewMode);
  }, [viewMode]);
  useEffect(() => {
    roamgateLocalStorage.setItem(DESKTOP_DIFF_WRAP_KEY, String(desktopWrap));
  }, [desktopWrap]);
  useEffect(() => {
    roamgateLocalStorage.setItem(MOBILE_DIFF_WRAP_KEY, String(mobileWrap));
  }, [mobileWrap]);
  useEffect(() => {
    requestedImagePreviewsRef.current.clear();
    imagePreviewRequestByKeyRef.current.clear();
    imagePreviewRequestSeqRef.current += 1;
    setImagePreviews({});
  }, [connectionClient, resourceKey]);
  useEffect(() => {
    const activeKeys = new Set(imagePreviewTargets.map((target) => target.key));
    for (const key of requestedImagePreviewsRef.current.keys()) {
      if (!activeKeys.has(key)) requestedImagePreviewsRef.current.delete(key);
    }
    for (const key of imagePreviewRequestByKeyRef.current.keys()) {
      if (!activeKeys.has(key)) imagePreviewRequestByKeyRef.current.delete(key);
    }
    setImagePreviews((current) => {
      const retained = Object.fromEntries(
        Object.entries(current).filter(([key]) => activeKeys.has(key)),
      );
      return Object.keys(retained).length === Object.keys(current).length
        ? current
        : retained;
    });

    const requests = imagePreviewTargets.flatMap((target) => {
      if (requestedImagePreviewsRef.current.get(target.key) === target.file) {
        return [];
      }
      requestedImagePreviewsRef.current.set(target.key, target.file);
      const requestSeq = ++imagePreviewRequestSeqRef.current;
      imagePreviewRequestByKeyRef.current.set(target.key, requestSeq);
      return [{ target, requestSeq }];
    });
    if (!requests.length) return;

    setImagePreviews((current) => ({
      ...current,
      ...Object.fromEntries(
        requests.map(({ target }) => [
          target.key,
          { preview: null, loading: true, error: null },
        ]),
      ),
    }));

    for (const { target, requestSeq } of requests) {
      startImagePreviewRequest(
        target,
        connectionClient,
        () =>
          connectionClient.isCurrent() &&
          imagePreviewRequestByKeyRef.current.get(target.key) === requestSeq,
        completeImagePreview,
      );
    }
  }, [completeImagePreview, connectionClient, imagePreviewTargets]);

  useEffect(() => {
    if (!activeEntryKey || !sectionRef.current) return;
    requestAnimationFrame(() => {
      const target = Array.from(
        sectionRef.current?.querySelectorAll<HTMLElement>(
          "[data-diff-entry-key]",
        ) ?? [],
      ).find((element) => element.dataset.diffEntryKey === activeEntryKey);
      target?.scrollIntoView({ block: "start" });
    });
  }, [activeEntryKey, renderedKey]);

  useEffect(() => {
    setSearchIndex(searchMatchCount ? 0 : -1);
  }, [deferredSearchQuery, searchMatchCount]);

  useEffect(() => {
    if (!currentSearchEntryKey || !sectionRef.current) return;
    setManualCollapseStates((current) => {
      if (current.get(currentSearchEntryKey) === false) return current;
      const next = new Map(current);
      next.set(currentSearchEntryKey, false);
      writeDiffCollapseState(resourceKey, next);
      return next;
    });
    requestAnimationFrame(() => {
      const target = Array.from(
        sectionRef.current?.querySelectorAll<HTMLElement>(
          "[data-diff-entry-key]",
        ) ?? [],
      ).find(
        (element) => element.dataset.diffEntryKey === currentSearchEntryKey,
      );
      target?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  }, [currentSearchEntryKey, resourceKey]);

  const focusSearch = useCallback(() => {
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, []);

  const goToSearchMatch = useCallback(
    (delta: number) => {
      if (!searchMatchCount) return;
      setSearchIndex((index) => {
        const base = index < 0 ? 0 : index;
        return (base + delta + searchMatchCount) % searchMatchCount;
      });
    },
    [searchMatchCount],
  );

  const toggleSectionCollapsed = useCallback(
    (key: string, collapsed: boolean) => {
      setManualCollapseStates((current) => {
        const next = new Map(current);
        next.set(key, !collapsed);
        writeDiffCollapseState(resourceKey, next);
        return next;
      });
    },
    [resourceKey],
  );

  useEffect(() => {
    if (embedded || mobile) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector(".shortcut-modal"))
        return;
      if (!shortcutMatches(e, "preview.search")) return;
      const section = sectionRef.current;
      if (!section || section.offsetParent === null) return;
      if (isEditableSearchTarget(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      focusSearch();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [embedded, mobile, focusSearch]);

  const diffList = visibleEntries.length ? (
    <Virtualizer
      className={`pierre-diff-scroll ${mobile ? "is-compact" : ""}`}
      contentClassName="pierre-diff-scroll-content"
    >
      {renderedSections.map((section) => (
        <DiffFileSection
          key={section.key}
          section={section}
          loading={loading && activeEntryKey === section.key && !section.file}
          imagePreviewState={
            section.file
              ? imagePreviews[imagePreviewKey(connectionClient, section.file)]
              : undefined
          }
          options={pierreOptions}
          currentSearchMatch={currentSearchEntryKey === section.key}
          embedded={embedded}
          mobile={mobile}
          annotations={
            annotationsByPath.get(section.key) ?? EMPTY_DIFF_REVIEW_ANNOTATIONS
          }
          annotationSelectionActive={
            pendingAnnotation?.path === section.entry.path &&
            pendingAnnotation.kind === section.entry.kind
          }
          onToggle={toggleSectionCollapsed}
          onSelectFile={onSelectFile ? handleSelectFile : undefined}
          onOpenFile={onOpenFile ? handleOpenFile : undefined}
          onRequestAnnotation={
            onCreateAnnotation ? handleRequestAnnotation : undefined
          }
          onEditAnnotation={onEditAnnotation}
        />
      ))}
    </Virtualizer>
  ) : null;

  return (
    <section
      ref={sectionRef}
      className={`diff-content-view ${embedded ? "is-embedded" : ""} ${
        mobile ? "is-mobile" : ""
      }`}
      aria-label={embedded ? "File changes" : "Diff Viewer content"}
      tabIndex={-1}
      onKeyDownCapture={(e) => {
        if (
          !embedded &&
          !mobile &&
          shortcutMatches(e.nativeEvent, "preview.search")
        ) {
          if (isEditableSearchTarget(e.target)) return;
          e.preventDefault();
          e.stopPropagation();
          focusSearch();
        }
      }}
    >
      <div className="diff-content-head">
        {mobile && backAction ? (
          <button
            type="button"
            className="diff-content-back"
            title={backAction.label}
            aria-label={backAction.label}
            onClick={backAction.onClick}
          >
            <ChevronLeft size={14} aria-hidden="true" />
          </button>
        ) : null}
        {embedded ? null : (
          <div className="diff-content-title">
            <strong>
              {changedFileCount
                ? `${changedFileCount} changed file${
                    changedFileCount === 1 ? "" : "s"
                  }`
                : "Diff Viewer"}
            </strong>
          </div>
        )}
        {mobile ? (
          <button
            type="button"
            className={`diff-wrap-toggle ${mobileWrap ? "is-active" : ""}`}
            onClick={() => setMobileWrap((value) => !value)}
            aria-pressed={mobileWrap}
          >
            Wrap
          </button>
        ) : null}
        <div className="diff-content-actions">
          {hunkTargets.length ? (
            <div
              className="diff-hunk-navigation"
              aria-label="Change navigation"
            >
              <button
                type="button"
                onClick={() => goToHunk(-1)}
                aria-label="Previous change"
                title="Previous change"
              >
                <ChevronUp size={14} />
              </button>
              <span>
                {hunkIndex < 0 ? "–" : hunkIndex + 1}/{hunkTargets.length}
                {mobile
                  ? ""
                  : ` ${hunkTargets.length === 1 ? "change" : "changes"}`}
              </span>
              <button
                type="button"
                onClick={() => goToHunk(1)}
                aria-label="Next change"
                title="Next change"
              >
                <ChevronDown size={14} />
              </button>
            </div>
          ) : null}
          {!embedded && !mobile ? (
            <div className="diff-search-controls">
              <label className="diff-search">
                <Search size={13} />
                <input
                  ref={searchInputRef}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      e.stopPropagation();
                      goToSearchMatch(e.shiftKey ? -1 : 1);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      setSearchQuery("");
                    }
                  }}
                  placeholder="Find loaded files"
                  disabled={!hasSearchableDiff}
                />
              </label>
              <span
                className="diff-search-count"
                role="status"
                aria-live="polite"
              >
                {deferredSearchQuery && searchMatchCount
                  ? `${searchIndex + 1}/${searchMatchCount}`
                  : deferredSearchQuery
                    ? "No results"
                    : ""}
              </span>
              <button
                type="button"
                className="diff-search-button"
                onClick={() => goToSearchMatch(-1)}
                disabled={!searchMatchCount}
                aria-label="Previous matching loaded file"
              >
                <ChevronUp size={14} />
              </button>
              <button
                type="button"
                className="diff-search-button"
                onClick={() => goToSearchMatch(1)}
                disabled={!searchMatchCount}
                aria-label="Next matching loaded file"
              >
                <ChevronDown size={14} />
              </button>
              {searchQuery ? (
                <button
                  type="button"
                  className="diff-search-button"
                  onClick={() => {
                    setSearchQuery("");
                    focusSearch();
                  }}
                  aria-label="Clear diff search"
                >
                  <X size={14} />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        {!mobile ? (
          <div className="diff-display-controls">
            <div className="diff-view-toggle" aria-label="Diff view mode">
              <button
                type="button"
                className={viewMode === "split" ? "is-active" : ""}
                onClick={() => setViewMode("split")}
                aria-pressed={viewMode === "split"}
              >
                Split
              </button>
              <button
                type="button"
                className={viewMode === "unified" ? "is-active" : ""}
                onClick={() => setViewMode("unified")}
                aria-pressed={viewMode === "unified"}
              >
                Unified
              </button>
            </div>
            <button
              type="button"
              className={`diff-wrap-toggle ${desktopWrap ? "is-active" : ""}`}
              onClick={() => setDesktopWrap((value) => !value)}
              aria-pressed={desktopWrap}
            >
              Wrap
            </button>
          </div>
        ) : null}
      </div>

      {error && !visibleEntries.length ? (
        <div className="diff-content-state is-error">{error}</div>
      ) : null}
      {summaryLoading && !visibleEntries.length ? (
        <div className="diff-content-state">
          <span className="file-loading-spinner" />
          Loading diff
        </div>
      ) : null}
      {!summaryLoading && !error && !visibleEntries.length ? (
        <div className="diff-content-state">No changed files.</div>
      ) : null}
      {hasExpandedTextDiff && diffList ? (
        <WorkerPoolContextProvider
          poolOptions={DIFF_WORKER_POOL_OPTIONS}
          highlighterOptions={DIFF_HIGHLIGHTER_OPTIONS}
        >
          {diffList}
        </WorkerPoolContextProvider>
      ) : (
        diffList
      )}
      <AnnotationComposerPopover
        draft={annotationComposerDraft}
        onSave={saveAnnotation}
        onClose={closeAnnotationComposer}
      />
    </section>
  );
}

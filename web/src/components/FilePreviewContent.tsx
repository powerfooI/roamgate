import { shortcutMatches } from "../shortcutPreferences";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { EditorView as CodeMirrorEditorView } from "@codemirror/view";
import { ChevronLeft, FolderPlus, RefreshCw } from "lucide-react";
import { fileReviewLineLabel, MAX_QUOTE_LENGTH } from "../annotations";
import {
  FileAnnotationDrag,
  type FileAnnotationRequest,
} from "./fileAnnotationDrag";
import type {
  FileLineReviewAnnotation,
  NewReviewAnnotation,
  ReviewAnnotation,
} from "../annotations";
import type { FileExplorerEntry, FilePreview } from "../types";
import { copyTextFromUserGesture } from "../terminalClipboard";
import { useConnectionClient } from "../useConnectionClient";
import {
  resolveWorkspaceMarkdownImageUrl,
  workspaceMarkdownDocumentPath,
  workspaceFileUrl,
} from "../workspaceFileUrl";
import { MarkdownPreview, type MarkdownSelectionTarget } from "./markdown";
import {
  AnnotationComposerPopover,
  type AnnotationComposerDraft,
} from "./AnnotationComposerPopover";
import { MermaidDiagram } from "./MermaidDiagram";
import { ImagePreview } from "./ImagePreview";
import {
  handlePreviewEditorCopy,
  isEditablePreviewTarget,
  isPreviewKeyboardTarget,
  selectAllInPreviewEditor,
  selectAllInPreviewElement,
} from "./previewSelection";
import { highlightCodeTokens } from "./syntaxHighlighting";
import { store, useStoreSelector } from "../store";
import {
  directoryPreviewName,
  directoryPreviewPath,
  normalizeFilesystemPath,
} from "../filesystemPaths";
import { CreateWorkspaceDialog } from "./CreateWorkspaceDialog";
import "./FilePreviewContent.css";

export type ActiveFilePreviewSelection = {
  entry: FileExplorerEntry | null;
  preview: FilePreview | null;
  loading: boolean;
  error: string | null;
  fragment?: string;
};

export type FilePreviewSelectionMeta = {
  userInitiated?: boolean;
};

type AppTheme = "dark" | "light";

const PDF_INLINE_PREVIEW_MAX_BYTES = 25 * 1024 * 1024;

type PendingFileAnnotation =
  | {
      kind: "line";
      x: number;
      y: number;
      path: string;
      line: number;
      endLine?: number;
      quote: string;
    }
  | {
      kind: "quote";
      x: number;
      y: number;
      path: string;
      quote: string;
      section: string[];
    };

type CodeMirrorPreviewDeps = Awaited<
  ReturnType<typeof importCodeMirrorPreviewDeps>
>;

let codeMirrorPreviewDepsPromise: Promise<CodeMirrorPreviewDeps> | null = null;

async function importCodeMirrorPreviewDeps() {
  const [codemirror, state, view, searchModule] = await Promise.all([
    import("codemirror"),
    import("@codemirror/state"),
    import("@codemirror/view"),
    import("@codemirror/search"),
  ]);

  return {
    basicSetup: codemirror.basicSetup,
    configuredShortcutGuard: state.Prec.highest(
      view.keymap.of([
        { key: "Mod-f", run: () => true },
        { key: "Mod-a", run: () => true },
      ]),
    ),
    Compartment: state.Compartment,
    Decoration: view.Decoration,
    RangeSet: state.RangeSet,
    GutterMarker: view.GutterMarker,
    gutter: view.gutter,
    EditorState: state.EditorState,
    EditorView: view.EditorView,
    ViewPlugin: view.ViewPlugin,
    keymap: view.keymap,
    openSearchPanel: searchModule.openSearchPanel,
    search: searchModule.search,
    searchKeymap: searchModule.searchKeymap,
  };
}

function loadCodeMirrorPreviewDeps() {
  codeMirrorPreviewDepsPromise ??= importCodeMirrorPreviewDeps();
  return codeMirrorPreviewDepsPromise;
}

function openPreviewSearch(view: CodeMirrorEditorView | null) {
  if (!view) return;
  void loadCodeMirrorPreviewDeps().then((deps) => deps.openSearchPanel(view));
}

function isMarkdownPath(path: string) {
  const lower = path.toLowerCase();
  return (
    lower.endsWith(".md") ||
    lower.endsWith(".markdown") ||
    lower.endsWith(".mdown") ||
    lower.endsWith(".mkdn")
  );
}

function isMermaidPath(path: string) {
  const lower = path.toLowerCase();
  return lower.endsWith(".mmd") || lower.endsWith(".mermaid");
}

function isPdfPath(path: string) {
  return path.toLowerCase().endsWith(".pdf");
}

function currentDocumentTheme(): AppTheme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function useDocumentTheme() {
  const [theme, setTheme] = useState<AppTheme>(() => currentDocumentTheme());

  useEffect(() => {
    const observer = new MutationObserver(() =>
      setTheme(currentDocumentTheme()),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  return theme;
}

export function FilePreviewContent({
  entry,
  preview,
  loading,
  error,
  fragment,
  changesContent,
  changesKey,
  annotations = [],
  backAction,
  onOpenChanges,
  onOpenFile,
  onRefresh,
  onCreateAnnotation,
  onReanchorAnnotations,
}: {
  entry: FileExplorerEntry | null;
  preview: FilePreview | null;
  loading: boolean;
  error: string | null;
  fragment?: string;
  changesContent?: ReactNode;
  changesKey?: string;
  backAction?: { label: string; onClick: () => void };
  annotations?: readonly ReviewAnnotation[];
  onOpenChanges?: () => void;
  onOpenFile?: (path: string, fragment?: string) => void;
  onRefresh?: () => void;
  onCreateAnnotation?: (annotation: NewReviewAnnotation) => void;
  onReanchorAnnotations?: (path: string, text: string) => void;
}) {
  const connectionClient = useConnectionClient();
  const workspaces = useStoreSelector((state) => state.workspaces);
  const previewSectionRef = useRef<HTMLElement | null>(null);
  const previewContentRef = useRef<HTMLDivElement | null>(null);
  const editorViewRef = useRef<CodeMirrorEditorView | null>(null);
  const onOpenChangesRef = useRef(onOpenChanges);
  onOpenChangesRef.current = onOpenChanges;
  const [previewMode, setPreviewMode] = useState<"rendered" | "raw">(
    "rendered",
  );
  const [detailTab, setDetailTab] = useState<"file" | "changes">("file");
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [pendingAnnotation, setPendingAnnotation] =
    useState<PendingFileAnnotation | null>(null);
  const [markdownSelection, setMarkdownSelection] =
    useState<MarkdownSelectionTarget | null>(null);
  const theme = useDocumentTheme();
  const previewText = preview?.text ?? null;
  const previewPath = preview?.path ?? "";
  const hasPreviewText = previewText !== null;
  const hasMarkdownPreview = hasPreviewText && isMarkdownPath(previewPath);
  const hasMermaidPreview = hasPreviewText && isMermaidPath(previewPath);
  const hasPdfPreview = Boolean(preview && isPdfPath(previewPath));
  const pdfTooLarge =
    hasPdfPreview && (preview?.size ?? 0) > PDF_INLINE_PREVIEW_MAX_BYTES;
  const hasRichPreview = hasMarkdownPreview || hasMermaidPreview;
  const renderRichPreview = hasRichPreview && previewMode === "rendered";
  const inlinePreviewUrl = useMemo(() => {
    if (!preview?.workspace_id || !previewPath) return null;
    return workspaceFileUrl(
      connectionClient,
      preview.workspace_id,
      previewPath,
      { inline: true, revision: preview.resource_revision },
    );
  }, [
    connectionClient,
    preview?.resource_revision,
    preview?.workspace_id,
    previewPath,
  ]);
  const markdownImageUrlResolver = useMemo(() => {
    if (!preview?.workspace_id || !previewPath) return undefined;
    return (source: string) =>
      resolveWorkspaceMarkdownImageUrl(
        source,
        previewPath,
        connectionClient,
        preview.workspace_id,
        preview.resource_revision,
      );
  }, [
    connectionClient,
    preview?.resource_revision,
    preview?.workspace_id,
    previewPath,
  ]);
  const markdownLinkUrlResolver = useMemo(() => {
    if (!preview?.workspace_id) return undefined;
    return (path: string) =>
      workspaceFileUrl(connectionClient, preview.workspace_id, path);
  }, [connectionClient, preview?.workspace_id]);
  const changesAvailable =
    changesContent !== undefined && !!changesKey && !!onOpenChanges;
  const showingChanges = detailTab === "changes" && changesAvailable;
  const directoryPath = directoryPreviewPath(preview);
  const directoryWorkspaceRoot = directoryPath
    ? workspaces.some((workspace) => {
        const root = workspace.worktree?.checkout_path ?? workspace.cwd;
        return !!root && normalizeFilesystemPath(root) === directoryPath;
      })
    : false;
  const showDirectoryWorkspaceAction =
    !!directoryPath && !directoryWorkspaceRoot;
  const directoryWorkspaceName = directoryPath
    ? directoryPreviewName(directoryPath)
    : "";
  const lineAnnotations = useMemo(
    () =>
      annotations.filter(
        (annotation): annotation is FileLineReviewAnnotation =>
          annotation.source === "file" &&
          annotation.anchor === "line" &&
          annotation.path === previewPath,
      ),
    [annotations, previewPath],
  );
  const annotationComposerDraft: AnnotationComposerDraft | null =
    pendingAnnotation
      ? {
          x: pendingAnnotation.x,
          y: pendingAnnotation.y,
          title:
            pendingAnnotation.kind === "line"
              ? `${pendingAnnotation.path} · ${fileReviewLineLabel(pendingAnnotation)}`
              : pendingAnnotation.section.length
                ? `${pendingAnnotation.path} · ${pendingAnnotation.section.join(" › ")}`
                : `${pendingAnnotation.path} · selected passage`,
          quote: pendingAnnotation.quote,
        }
      : null;

  useEffect(() => {
    setPreviewMode("rendered");
  }, [entry?.path]);

  useEffect(() => {
    setPendingAnnotation(null);
    setMarkdownSelection(null);
  }, [previewPath]);

  useEffect(() => {
    if (previewText === null || !previewPath || preview?.truncated) return;
    onReanchorAnnotations?.(previewPath, previewText);
  }, [onReanchorAnnotations, preview?.truncated, previewPath, previewText]);

  useEffect(() => {
    if (hasMarkdownPreview && renderRichPreview && !showingChanges) return;
    setMarkdownSelection(null);
  }, [hasMarkdownPreview, renderRichPreview, showingChanges]);

  useEffect(() => {
    if (detailTab === "changes" && changesAvailable) {
      onOpenChangesRef.current?.();
    }
  }, [changesAvailable, changesKey, detailTab]);

  useEffect(() => {
    if (showingChanges || !hasPreviewText) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector(".shortcut-modal"))
        return;
      const find = shortcutMatches(e, "preview.search");
      if (!find && !shortcutMatches(e, "preview.selectAll")) return;
      const section = previewSectionRef.current;
      if (!section || section.offsetParent === null) return;
      if (isEditablePreviewTarget(e.target)) return;
      if (find) {
        if (renderRichPreview) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        openPreviewSearch(editorViewRef.current);
        return;
      }
      if (!isPreviewKeyboardTarget(section, e.target)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (renderRichPreview) {
        selectAllInPreviewElement(previewContentRef.current);
      } else {
        selectAllInPreviewEditor(editorViewRef.current);
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [hasPreviewText, renderRichPreview, showingChanges]);

  useEffect(() => {
    const section = previewSectionRef.current;
    if (!section) return;
    const onCopy = (event: ClipboardEvent) => {
      handlePreviewEditorCopy(editorViewRef.current, event);
    };
    section.addEventListener("copy", onCopy);
    return () => section.removeEventListener("copy", onCopy);
  }, []);

  const closeAnnotationComposer = useCallback(() => {
    setPendingAnnotation(null);
  }, []);

  const saveAnnotation = useCallback(
    (comment: string) => {
      const pending = pendingAnnotation;
      if (!pending || !onCreateAnnotation) return;
      if (pending.kind === "line") {
        onCreateAnnotation({
          source: "file",
          anchor: "line",
          path: pending.path,
          line: pending.line,
          ...(pending.endLine === undefined
            ? {}
            : { endLine: pending.endLine }),
          quote: pending.quote,
          comment,
        });
      } else {
        onCreateAnnotation({
          source: "file",
          anchor: "quote",
          path: pending.path,
          quote: pending.quote,
          section: pending.section,
          comment,
        });
      }
      setPendingAnnotation(null);
      setMarkdownSelection(null);
      window.getSelection()?.removeAllRanges();
    },
    [onCreateAnnotation, pendingAnnotation],
  );

  const copyPreviewText = async () => {
    if (previewText === null) return;
    try {
      await copyTextFromUserGesture(previewText);
      store.notify({
        kind: "success",
        message: "File content copied",
        detail: previewPath,
        autoDismissMs: 3000,
      });
    } catch (copyError) {
      store.notify({
        kind: "error",
        message: "Failed to copy file content",
        detail: (copyError as Error).message,
      });
    }
  };

  return (
    <section
      ref={previewSectionRef}
      className="file-preview"
      aria-label="File preview"
      tabIndex={-1}
      onKeyDownCapture={(e) => {
        if (shortcutMatches(e.nativeEvent, "preview.search")) {
          if (showingChanges || renderRichPreview) return;
          e.preventDefault();
          e.stopPropagation();
          openPreviewSearch(editorViewRef.current);
        }
      }}
    >
      <div className="file-preview-head">
        <div className="file-preview-title-row">
          {backAction ? (
            <button
              type="button"
              className="file-preview-back"
              onClick={backAction.onClick}
            >
              <ChevronLeft size={13} aria-hidden="true" />
              {backAction.label}
            </button>
          ) : null}
          <div className="file-preview-title" title={entry?.name}>
            {entry?.name ?? "Preview"}
          </div>
          <div className="file-preview-head-actions">
            {!showingChanges && showDirectoryWorkspaceAction ? (
              <button
                type="button"
                className="file-preview-refresh"
                title="New workspace with this directory as CWD"
                aria-label="New workspace with this directory as CWD"
                onClick={() => setWorkspaceDialogOpen(true)}
              >
                <FolderPlus size={13} aria-hidden="true" />
              </button>
            ) : null}
            {!showingChanges && entry && onRefresh ? (
              <button
                type="button"
                className="file-preview-refresh"
                title="Refresh preview"
                aria-label="Refresh preview"
                disabled={loading}
                onClick={onRefresh}
              >
                <RefreshCw
                  size={13}
                  className={loading ? "is-spinning" : undefined}
                  aria-hidden="true"
                />
              </button>
            ) : null}
            {!showingChanges && hasPreviewText && !preview?.truncated ? (
              <button
                type="button"
                className="file-preview-copy"
                title="Copy entire file content"
                onClick={() => void copyPreviewText()}
              >
                Copy
              </button>
            ) : null}
            {!showingChanges && hasMermaidPreview ? (
              <div
                className="file-preview-mode-options"
                role="group"
                aria-label="Mermaid preview mode"
              >
                <button
                  type="button"
                  className="file-preview-mode-toggle"
                  aria-pressed={previewMode === "rendered"}
                  onClick={() => setPreviewMode("rendered")}
                >
                  Diagram
                </button>
                <button
                  type="button"
                  className="file-preview-mode-toggle"
                  aria-pressed={previewMode === "raw"}
                  onClick={() => setPreviewMode("raw")}
                >
                  Source
                </button>
              </div>
            ) : null}
            {!showingChanges && hasMarkdownPreview ? (
              <button
                type="button"
                className="file-preview-mode-toggle"
                onClick={() =>
                  setPreviewMode((mode) =>
                    mode === "rendered" ? "raw" : "rendered",
                  )
                }
              >
                {previewMode === "rendered" ? "Raw" : "Rendered"}
              </button>
            ) : null}
            {changesAvailable ? (
              <button
                type="button"
                className="file-preview-changes-toggle"
                aria-pressed={showingChanges}
                title={showingChanges ? "Show file preview" : "Show changes"}
                onClick={() =>
                  setDetailTab(showingChanges ? "file" : "changes")
                }
              >
                Changes
              </button>
            ) : null}
          </div>
        </div>
        {entry ? <span>{entry.path}</span> : null}
      </div>

      {showingChanges ? (
        <div
          className="file-preview-changes"
          role="region"
          aria-label={`Changes for ${entry?.name ?? "selected file"}`}
        >
          {changesContent}
        </div>
      ) : (
        <div
          ref={previewContentRef}
          className="file-preview-file-content"
          role="region"
          aria-label={`Preview of ${entry?.name ?? "selected file"}`}
        >
          {!entry ? (
            <div className="file-preview-state">
              Select a text file to preview.
            </div>
          ) : null}
          {loading ? (
            <div className="file-preview-state">
              <span className="file-loading-spinner" />
              Loading preview
            </div>
          ) : null}
          {error ? (
            <div className="file-preview-state is-error">{error}</div>
          ) : null}
          {!loading && !error && directoryPath ? (
            <div className="file-preview-state">
              Directories cannot be previewed.
            </div>
          ) : null}
          {!loading && !error && preview?.image_data_url ? (
            <ImagePreview
              key={previewPath}
              src={preview.image_data_url}
              name={entry?.name ?? preview.path}
            />
          ) : null}
          {!loading &&
          !error &&
          hasPdfPreview &&
          !pdfTooLarge &&
          inlinePreviewUrl ? (
            <iframe
              className="file-preview-pdf"
              src={inlinePreviewUrl}
              title={`PDF preview: ${entry?.name ?? previewPath}`}
            />
          ) : null}
          {!loading && !error && pdfTooLarge ? (
            <div className="file-preview-state">
              PDF is too large to preview. Use Download from the file menu.
            </div>
          ) : null}
          {!loading &&
          !error &&
          preview?.binary &&
          !preview.image_data_url &&
          !hasPdfPreview ? (
            <div className="file-preview-state">
              Binary file cannot be previewed.
            </div>
          ) : null}
          {!loading && !error && preview?.truncated && !hasPdfPreview ? (
            <div className="file-preview-banner">
              Preview truncated at 512 KB.
            </div>
          ) : null}
          {!loading && !error && hasMarkdownPreview && renderRichPreview ? (
            <MarkdownPreview
              text={previewText}
              imageUrlResolver={markdownImageUrlResolver}
              documentPath={
                onOpenFile && preview
                  ? workspaceMarkdownDocumentPath(previewPath, preview.root)
                  : undefined
              }
              linkUrlResolver={markdownLinkUrlResolver}
              fragment={fragment}
              onOpenDocument={onOpenFile}
              onSelectionChange={
                onCreateAnnotation ? setMarkdownSelection : undefined
              }
            />
          ) : null}
          {!loading && !error && hasMermaidPreview && renderRichPreview ? (
            <MermaidDiagram
              key={previewPath}
              code={previewText}
              className="file-preview-mermaid"
            />
          ) : null}
          {!loading &&
          !error &&
          hasPreviewText &&
          !renderRichPreview &&
          !hasPdfPreview ? (
            <CodeMirrorPreview
              text={previewText}
              path={previewPath}
              theme={theme}
              annotations={lineAnnotations}
              editorViewRef={editorViewRef}
              onRequestAnnotation={
                onCreateAnnotation
                  ? ({ line, endLine, quote, x, y }) =>
                      setPendingAnnotation({
                        kind: "line",
                        path: previewPath,
                        line,
                        endLine,
                        quote,
                        x,
                        y,
                      })
                  : undefined
              }
            />
          ) : null}
        </div>
      )}
      {markdownSelection &&
      onCreateAnnotation &&
      hasMarkdownPreview &&
      renderRichPreview &&
      !showingChanges
        ? createPortal(
            <button
              type="button"
              className="markdown-annotate-button"
              style={{
                left: Math.min(
                  Math.max(8, markdownSelection.x),
                  Math.max(8, window.innerWidth - 154),
                ),
                top: Math.min(
                  Math.max(8, markdownSelection.y),
                  Math.max(8, window.innerHeight - 42),
                ),
              }}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                setPendingAnnotation({
                  kind: "quote",
                  path: previewPath,
                  quote: markdownSelection.quote,
                  section: markdownSelection.section,
                  x: markdownSelection.x,
                  y: markdownSelection.y,
                });
                setMarkdownSelection(null);
              }}
            >
              Annotate selection
            </button>,
            document.body,
          )
        : null}
      <AnnotationComposerPopover
        draft={annotationComposerDraft}
        onSave={saveAnnotation}
        onClose={closeAnnotationComposer}
      />
      <CreateWorkspaceDialog
        open={workspaceDialogOpen}
        initialName={directoryWorkspaceName}
        initialCwd={directoryPath ?? ""}
        onClose={() => setWorkspaceDialogOpen(false)}
      />
    </section>
  );
}

type CodeMirrorAnnotationRequest = FileAnnotationRequest;

type CodeMirrorAnnotationRuntime = {
  deps: CodeMirrorPreviewDeps;
  compartment: InstanceType<CodeMirrorPreviewDeps["Compartment"]>;
  view: CodeMirrorEditorView;
};

function codeMirrorAnnotationExtensions(
  deps: CodeMirrorPreviewDeps,
  text: string,
  annotations: readonly FileLineReviewAnnotation[],
  onRequestAnnotation?: (request: CodeMirrorAnnotationRequest) => void,
) {
  if (!onRequestAnnotation && annotations.length === 0) return [];
  const annotationsByLine = new Map<number, FileLineReviewAnnotation[]>();
  for (const annotation of annotations) {
    const current = annotationsByLine.get(annotation.line);
    if (current) current.push(annotation);
    else annotationsByLine.set(annotation.line, [annotation]);
  }

  const normalizedText = text.replace(/\r\n?/g, "\n");
  const lineStarts = [0];
  for (let index = 0; index < normalizedText.length; index += 1) {
    if (normalizedText[index] === "\n") lineStarts.push(index + 1);
  }

  const annotatedLines = new Set<number>();
  for (const annotation of annotations) {
    const end = Math.min(
      annotation.endLine ?? annotation.line,
      lineStarts.length,
    );
    for (let line = annotation.line; line <= end; line += 1)
      annotatedLines.add(line);
  }

  class ReviewGutterMarker extends deps.GutterMarker {
    constructor(
      private count: number,
      private stale: boolean,
    ) {
      super();
    }

    toDOM() {
      const marker = document.createElement("span");
      marker.className = `cm-review-annotation-marker ${
        this.stale ? "is-stale" : ""
      }`;
      marker.textContent = String(this.count);
      marker.title = `${this.count} review comment${this.count === 1 ? "" : "s"}`;
      return marker;
    }
  }

  const dragPlugin = deps.ViewPlugin.define(
    (view) =>
      new FileAnnotationDrag(
        view,
        (request) => onRequestAnnotation?.(request),
        () =>
          store.notify({
            kind: "info",
            message: "Select fewer lines to annotate",
            detail: `The selected text exceeds the ${MAX_QUOTE_LENGTH.toLocaleString("en-US")}-character annotation limit.`,
          }),
      ),
  );

  return [
    dragPlugin,
    deps.gutter({
      class: "cm-review-annotation-gutter",
      markers: (view) =>
        deps.RangeSet.of(
          Array.from(annotationsByLine.entries())
            .sort(([left], [right]) => left - right)
            .flatMap(([lineNumber, matches]) => {
              if (lineNumber > view.state.doc.lines) return [];
              const line = view.state.doc.line(lineNumber);
              return [
                new ReviewGutterMarker(
                  matches.length,
                  matches.every((annotation) => annotation.stale),
                ).range(line.from),
              ];
            }),
          true,
        ),
      domEventHandlers: {
        mousedown: (view, line, event) => {
          if (
            !(event instanceof MouseEvent) ||
            event.button !== 0 ||
            !onRequestAnnotation
          ) {
            return false;
          }
          return (
            view
              .plugin(dragPlugin)
              ?.start(view.state.doc.lineAt(line.from).number, event) ?? false
          );
        },
      },
    }),
    deps.EditorView.decorations.of(
      deps.Decoration.set(
        Array.from(annotatedLines)
          .sort((left, right) => left - right)
          .flatMap((lineNumber) => {
            const from = lineStarts[lineNumber - 1];
            return from === undefined
              ? []
              : [
                  deps.Decoration.line({
                    attributes: { "data-review-annotated": "true" },
                  }).range(from),
                ];
          }),
      ),
    ),
  ];
}

function CodeMirrorPreview({
  text,
  path,
  theme,
  annotations,
  editorViewRef,
  onRequestAnnotation,
}: {
  text: string;
  path: string;
  theme: AppTheme;
  annotations: readonly FileLineReviewAnnotation[];
  editorViewRef: MutableRefObject<CodeMirrorEditorView | null>;
  onRequestAnnotation?: (request: CodeMirrorAnnotationRequest) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const annotationRuntimeRef = useRef<CodeMirrorAnnotationRuntime | null>(null);
  const annotationsRef = useRef(annotations);
  const requestAnnotationRef = useRef(onRequestAnnotation);
  annotationsRef.current = annotations;
  requestAnnotationRef.current = onRequestAnnotation;

  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;
    let cancelled = false;
    let view: CodeMirrorEditorView | null = null;
    parent.textContent = "";

    void loadCodeMirrorPreviewDeps().then((deps) => {
      if (cancelled || !containerRef.current) return;
      parent.textContent = "";
      const syntaxCompartment = new deps.Compartment();
      const annotationCompartment = new deps.Compartment();
      view = new deps.EditorView({
        parent,
        state: deps.EditorState.create({
          doc: text,
          extensions: [
            deps.basicSetup,
            deps.configuredShortcutGuard,
            deps.search({ top: true }),
            deps.keymap.of(deps.searchKeymap),
            deps.EditorState.readOnly.of(true),
            deps.EditorView.editable.of(false),
            deps.EditorView.contentAttributes.of({ tabindex: "0" }),
            syntaxCompartment.of([]),
            annotationCompartment.of(
              codeMirrorAnnotationExtensions(
                deps,
                text,
                annotationsRef.current,
                (request) => requestAnnotationRef.current?.(request),
              ),
            ),
            deps.EditorView.theme(
              {
                "&": {
                  height: "100%",
                  backgroundColor: "var(--viewer-code-bg)",
                  color: "var(--text-code)",
                },
                ".cm-scroller": {
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                  fontSize: "12px",
                  lineHeight: "1.55",
                },
                ".cm-content": {
                  caretColor: "var(--accent)",
                  padding: "10px 0",
                },
                ".cm-content ::selection": {
                  backgroundColor:
                    "color-mix(in srgb, var(--accent) 32%, transparent) !important",
                  color: "inherit",
                },
                ".cm-line": {
                  padding: "0 12px",
                },
                ".cm-gutters": {
                  backgroundColor: "var(--viewer-code-bg)",
                  color: "var(--muted)",
                  borderRight: "1px solid var(--border-soft)",
                },
                ".cm-lineNumbers .cm-gutterElement": {
                  padding: "0 10px 0 12px",
                  minWidth: "42px",
                },
                ".cm-activeLineGutter, .cm-activeLine": {
                  backgroundColor:
                    "color-mix(in srgb, var(--accent) 10%, transparent)",
                },
                ".cm-selectionBackground, &.cm-focused .cm-selectionBackground":
                  {
                    backgroundColor:
                      "color-mix(in srgb, var(--accent) 32%, transparent) !important",
                  },
                ".cm-cursor": {
                  borderLeftColor: "var(--accent)",
                },
                ".cm-panels, .cm-panels.cm-panels-top, .cm-panels.cm-panels-bottom":
                  {
                    backgroundColor: "var(--viewer-header-bg)",
                    color: "var(--text)",
                    borderColor: "var(--border-soft)",
                  },
                ".cm-panel.cm-search": {
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: "8px",
                  padding: "8px 10px",
                  backgroundColor: "var(--viewer-header-bg)",
                  color: "var(--text)",
                },
                ".cm-panel.cm-search .cm-textfield, .cm-panel.cm-search input":
                  {
                    height: "30px",
                    padding: "0 8px",
                    backgroundColor: "var(--viewer-code-bg)",
                    color: "var(--text)",
                    border: "1px solid var(--viewer-border)",
                    borderRadius: "7px",
                    outline: "none",
                  },
                ".cm-panel.cm-search .cm-textfield:focus, .cm-panel.cm-search input:focus":
                  {
                    borderColor: "var(--accent)",
                    boxShadow: "0 0 0 2px var(--accent-soft)",
                  },
                ".cm-panel.cm-search .cm-button, .cm-panel.cm-search button": {
                  height: "30px",
                  padding: "0 10px",
                  backgroundColor: "var(--viewer-panel-bg)",
                  color: "var(--text)",
                  border: "1px solid var(--viewer-border)",
                  borderRadius: "7px",
                  backgroundImage: "none",
                  font: "inherit",
                },
                ".cm-panel.cm-search .cm-button:hover, .cm-panel.cm-search button:hover":
                  {
                    backgroundColor: "var(--viewer-header-bg)",
                  },
                ".cm-panel.cm-search .cm-button:disabled, .cm-panel.cm-search button:disabled":
                  {
                    opacity: "0.48",
                  },
                ".cm-panel.cm-search label": {
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  color: "var(--text)",
                },
                ".cm-panel.cm-search input[type=checkbox]": {
                  width: "16px",
                  height: "16px",
                  margin: "0",
                  padding: "0",
                  accentColor: "var(--accent)",
                },
                ".cm-searchMatch": {
                  backgroundColor:
                    "color-mix(in srgb, var(--yellow) 36%, transparent)",
                  outline:
                    "1px solid color-mix(in srgb, var(--yellow) 45%, transparent)",
                },
                ".cm-searchMatch-selected": {
                  backgroundColor:
                    "color-mix(in srgb, var(--yellow) 58%, transparent)",
                  color: "var(--text-strong)",
                  outline: "1px solid var(--yellow)",
                },
                ".cm-matchingBracket": {
                  backgroundColor:
                    "color-mix(in srgb, var(--accent) 18%, transparent)",
                  color: "var(--text-strong)",
                  outline:
                    "1px solid color-mix(in srgb, var(--accent) 38%, transparent)",
                },
                ".cm-nonmatchingBracket": {
                  backgroundColor: "var(--danger-soft)",
                  color: "var(--danger-text)",
                  outline: "1px solid var(--danger-border)",
                },
                ".cm-foldPlaceholder": {
                  backgroundColor: "var(--viewer-panel-bg)",
                  color: "var(--muted)",
                  border: "1px solid var(--viewer-border)",
                },
                ".cm-tooltip, .cm-tooltip.cm-tooltip-autocomplete": {
                  border: "1px solid var(--viewer-border)",
                  backgroundColor: "var(--viewer-panel-bg)",
                  color: "var(--text)",
                },
              },
              { dark: theme === "dark" },
            ),
          ],
        }),
      });
      editorViewRef.current = view;
      annotationRuntimeRef.current = {
        deps,
        compartment: annotationCompartment,
        view,
      };
      const activeView = view;

      void highlightCodeTokens(text, path)
        .then((tokens) => {
          if (cancelled || view !== activeView) return;
          const decorations = deps.Decoration.set(
            tokens.map(({ from, to, className }) =>
              deps.Decoration.mark({ class: className }).range(from, to),
            ),
            true,
          );
          activeView.dispatch({
            effects: syntaxCompartment.reconfigure(
              deps.EditorView.decorations.of(decorations),
            ),
          });
        })
        .catch(() => {
          // Highlighting is progressive; the plain-text preview remains usable.
        });
    });

    return () => {
      cancelled = true;
      if (editorViewRef.current === view) editorViewRef.current = null;
      if (annotationRuntimeRef.current?.view === view) {
        annotationRuntimeRef.current = null;
      }
      view?.destroy();
    };
  }, [editorViewRef, path, text, theme]);

  useEffect(() => {
    const runtime = annotationRuntimeRef.current;
    if (!runtime) return;
    runtime.view.dispatch({
      effects: runtime.compartment.reconfigure(
        codeMirrorAnnotationExtensions(
          runtime.deps,
          text,
          annotations,
          (request) => requestAnnotationRef.current?.(request),
        ),
      ),
    });
  }, [annotations, text]);

  return (
    <div ref={containerRef} className="file-preview-code syntax-highlighted" />
  );
}

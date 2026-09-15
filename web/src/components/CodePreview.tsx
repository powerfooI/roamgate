import { shortcutMatches } from "../shortcutPreferences";
import { useEffect, useRef } from "react";
import {
  handlePreviewEditorCopy,
  isEditablePreviewTarget,
  isPreviewKeyboardTarget,
  selectAllInPreviewEditor,
} from "./previewSelection";
import "./CodePreview.css";

type CodePreviewDeps = Awaited<ReturnType<typeof importCodePreviewDeps>>;

let depsPromise: Promise<CodePreviewDeps> | null = null;

async function importCodePreviewDeps() {
  const [
    codemirror,
    state,
    view,
    searchModule,
    language,
    highlight,
    jsonModule,
  ] = await Promise.all([
    import("codemirror"),
    import("@codemirror/state"),
    import("@codemirror/view"),
    import("@codemirror/search"),
    import("@codemirror/language"),
    import("@lezer/highlight"),
    import("@codemirror/lang-json"),
  ]);
  const t = highlight.tags;
  const highlightStyle = language.HighlightStyle.define([
    { tag: t.comment, color: "var(--syntax-comment)", fontStyle: "italic" },
    { tag: [t.keyword, t.controlKeyword], color: "var(--syntax-keyword)" },
    { tag: [t.string, t.special(t.string)], color: "var(--syntax-string)" },
    { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syntax-number)" },
    { tag: [t.propertyName, t.attributeName], color: "var(--syntax-property)" },
    { tag: [t.variableName], color: "var(--syntax-variable)" },
    { tag: [t.operator, t.compareOperator], color: "var(--syntax-operator)" },
    {
      tag: [t.punctuation, t.separator, t.bracket],
      color: "var(--syntax-punctuation)",
    },
  ]);
  return {
    basicSetup: codemirror.basicSetup,
    configuredShortcutGuard: state.Prec.highest(
      view.keymap.of([
        { key: "Mod-f", run: () => true },
        { key: "Mod-a", run: () => true },
      ]),
    ),
    EditorState: state.EditorState,
    EditorView: view.EditorView,
    keymap: view.keymap,
    openSearchPanel: searchModule.openSearchPanel,
    search: searchModule.search,
    searchKeymap: searchModule.searchKeymap,
    syntaxHighlighting: language.syntaxHighlighting,
    highlightStyle,
    json: jsonModule.json,
  };
}

function loadCodePreviewDeps() {
  depsPromise ??= importCodePreviewDeps();
  return depsPromise;
}

export function CodePreview({
  text,
  searchable = false,
}: {
  text: string;
  searchable?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<InstanceType<CodePreviewDeps["EditorView"]> | null>(
    null,
  );

  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;
    let cancelled = false;
    let editor: InstanceType<CodePreviewDeps["EditorView"]> | null = null;
    parent.textContent = "";
    void loadCodePreviewDeps().then((deps) => {
      if (cancelled || !containerRef.current) return;
      parent.textContent = "";
      editor = new deps.EditorView({
        parent,
        state: deps.EditorState.create({
          doc: text,
          extensions: [
            deps.basicSetup,
            deps.configuredShortcutGuard,
            ...(searchable
              ? [deps.search({ top: true }), deps.keymap.of(deps.searchKeymap)]
              : []),
            deps.EditorState.readOnly.of(true),
            deps.EditorView.editable.of(false),
            deps.EditorView.contentAttributes.of({ tabindex: "0" }),
            deps.json(),
            deps.syntaxHighlighting(deps.highlightStyle),
            deps.EditorView.theme({
              "&": {
                height: "100%",
                backgroundColor: "var(--input-bg)",
                color: "var(--text-code)",
              },
              ".cm-scroller": {
                fontFamily: "var(--mono-font)",
                fontSize: "12px",
                lineHeight: "1.45",
              },
              ".cm-content": {
                padding: "10px 0",
              },
              ".cm-line": {
                padding: "0 12px",
              },
              ".cm-gutters": {
                backgroundColor: "var(--input-bg)",
                color: "var(--muted)",
                borderRight: "1px solid var(--border-soft)",
              },
              ".cm-lineNumbers .cm-gutterElement": {
                minWidth: "42px",
                padding: "0 10px 0 12px",
              },
              ".cm-activeLineGutter, .cm-activeLine": {
                backgroundColor:
                  "color-mix(in srgb, var(--accent) 10%, transparent)",
              },
              ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
                backgroundColor:
                  "color-mix(in srgb, var(--accent) 32%, transparent) !important",
              },
              ".cm-panels, .cm-panels.cm-panels-top, .cm-panels.cm-panels-bottom":
                {
                  backgroundColor: "var(--panel)",
                  color: "var(--text)",
                  borderColor: "var(--border-soft)",
                },
              ".cm-panel.cm-search": {
                display: "flex",
                alignItems: "center",
                gap: "6px",
                minHeight: "42px",
                overflowX: "auto",
                padding: "6px 10px",
                backgroundColor: "var(--panel)",
                color: "var(--text)",
              },
              ".cm-panel.cm-search .cm-textfield, .cm-panel.cm-search input": {
                width: "150px",
                height: "28px",
                padding: "0 8px",
                backgroundColor: "var(--input-bg)",
                color: "var(--text)",
                border: "1px solid var(--border)",
                borderRadius: "7px",
                outline: "none",
              },
              ".cm-panel.cm-search .cm-button, .cm-panel.cm-search button": {
                width: "auto",
                height: "28px",
                minWidth: "0",
                padding: "0 9px",
                backgroundColor: "var(--panel)",
                color: "var(--text)",
                border: "1px solid var(--border)",
                borderRadius: "7px",
                backgroundImage: "none",
                font: "inherit",
              },
              ".cm-panel.cm-search label": {
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                flex: "0 0 auto",
                width: "auto",
                minWidth: "0",
                margin: "0 2px",
                color: "var(--text)",
                fontSize: "12px",
                whiteSpace: "nowrap",
              },
              ".cm-panel.cm-search input[type=checkbox]": {
                width: "14px",
                height: "14px",
                flex: "0 0 auto",
                margin: "0",
                padding: "0",
                accentColor: "var(--accent)",
              },
              ".cm-panel.cm-search [name=replace], .cm-panel.cm-search [name=replaceAll]":
                {
                  display: "none",
                },
              ".cm-panel.cm-search button[name=close]": {
                marginLeft: "auto",
                width: "28px",
                height: "28px",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "0",
                lineHeight: "1",
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
            }),
          ],
        }),
      });
      editorRef.current = editor;
      if (searchable) deps.openSearchPanel(editor);
    });
    return () => {
      cancelled = true;
      editor?.destroy();
      if (editorRef.current === editor) editorRef.current = null;
      if (parent) parent.textContent = "";
    };
  }, [searchable, text]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector(".shortcut-modal"))
        return;
      const find = shortcutMatches(e, "preview.search");
      if (!find && !shortcutMatches(e, "preview.selectAll")) return;
      const parent = containerRef.current;
      if (!parent) return;
      const target = e.target as Node | null;
      if (isEditablePreviewTarget(e.target)) return;
      const editor = editorRef.current;
      if (!editor) return;
      if (find) {
        if (!searchable || !target || !parent.contains(target)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        void loadCodePreviewDeps().then((deps) => {
          deps.openSearchPanel(editor);
        });
        return;
      }
      if (parent.offsetParent === null) return;
      if (!isPreviewKeyboardTarget(parent, target)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      selectAllInPreviewEditor(editor);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [searchable]);

  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;
    const onCopy = (event: ClipboardEvent) => {
      handlePreviewEditorCopy(editorRef.current, event);
    };
    parent.addEventListener("copy", onCopy);
    return () => parent.removeEventListener("copy", onCopy);
  }, []);

  return <div ref={containerRef} className="code-preview" tabIndex={0} />;
}

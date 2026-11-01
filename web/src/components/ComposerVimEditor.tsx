import {
  cursorLineBoundaryBackward,
  cursorLineBoundaryForward,
  history,
  historyKeymap,
  insertNewline,
  selectLineBoundaryBackward,
  selectLineBoundaryForward,
} from "@codemirror/commands";
import { EditorSelection, EditorState, Prec } from "@codemirror/state";
import {
  EditorView,
  keymap,
  placeholder as placeholderText,
} from "@codemirror/view";
import { getCM, Vim, vim } from "@replit/codemirror-vim";
import { type RefObject, useEffect, useRef } from "react";

/** What the message box's buttons can do to the editor. */
export type ComposerVimHandle = {
  /** Esc, for keyboards without one: leaves insert mode. */
  escape: () => void;
};
import { scrollChatPage } from "./chatPaging";
import { defineExCommands, vimExEditors } from "./vimEx";

/**
 * The agent chat's message box with Vim keys (the review's `:vim` setting).
 * It starts in insert mode; Esc goes to normal mode, `:w` sends, `:q`
 * leaves the box. Enter sends where the plain box sends on Enter and adds a
 * line elsewhere; Shift+Enter always adds one.
 */
export function ComposerVimEditor({
  value,
  selection,
  placeholder,
  label,
  enterSends,
  onChange,
  onSelect,
  onSubmit,
  onPasteImages,
  onComposingChange,
  handleRef,
}: {
  /** The box's text; a change from outside (an upload, the terminal's box)
   * replaces it and puts the cursor at `selection`. */
  value: string;
  selection: { start: number; end: number } | null;
  placeholder: string;
  label: string;
  enterSends: boolean;
  onChange: (text: string, start: number, end: number) => void;
  onSelect: (start: number, end: number) => void;
  onSubmit: () => void;
  onPasteImages: (files: File[]) => void;
  onComposingChange: (composing: boolean) => void;
  handleRef?: RefObject<ComposerVimHandle | null>;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // What the box reported and the draft has not caught up with: the draft
  // comes back with each, maybe after more was typed, and must not undo it.
  const reportedRef = useRef(new Set<string>());
  // The draft as last seen: a render that brings the same draft (the chat's
  // history poll, a new selection object) is no change from outside, and
  // the box may be ahead of it with what was just typed.
  const lastValueRef = useRef(value);
  const handlers = useRef({
    onChange,
    onSelect,
    onSubmit,
    onPasteImages,
    onComposingChange,
    enterSends,
  });
  handlers.current = {
    onChange,
    onSelect,
    onSubmit,
    onPasteImages,
    onComposingChange,
    enterSends,
  };
  const initial = useRef({ value, placeholder, label, handleRef });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { value, placeholder, label, handleRef } = initial.current;
    defineExCommands();
    const submit = () => {
      handlers.current.onSubmit();
      return true;
    };
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        selection: { anchor: value.length },
        extensions: [
          // Page Up / Down scroll the chat in every mode: ahead of Vim, which
          // would page the box itself in normal mode.
          Prec.highest(
            keymap.of([
              { key: "PageUp", run: (view) => scrollChatPage(view.dom, -1) },
              { key: "PageDown", run: (view) => scrollChatPage(view.dom, 1) },
            ]),
          ),
          vim({ status: false }),
          // Undo and redo: vim's u and Ctrl-R, and Mod-Z / Mod-Shift-Z.
          history(),
          keymap.of(historyKeymap),
          keymap.of([
            { key: "Mod-Enter", run: submit },
            // Without the default keymap nothing else adds a line.
            {
              key: "Enter",
              run: (view) =>
                handlers.current.enterSends ? submit() : insertNewline(view),
            },
            { key: "Shift-Enter", run: insertNewline },
            // Start and end of the line.
            {
              key: "Home",
              run: cursorLineBoundaryBackward,
              shift: selectLineBoundaryBackward,
            },
            {
              key: "End",
              run: cursorLineBoundaryForward,
              shift: selectLineBoundaryForward,
            },
          ]),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            "aria-label": label,
            spellcheck: "true",
            autocorrect: "on",
            autocapitalize: "sentences",
          }),
          placeholderText(placeholder),
          EditorView.updateListener.of((update) => {
            const { from, to } = update.state.selection.main;
            if (update.docChanged) {
              const text = update.state.doc.toString();
              reportedRef.current.add(text);
              handlers.current.onChange(text, from, to);
            } else if (update.selectionSet) handlers.current.onSelect(from, to);
          }),
          EditorView.domEventHandlers({
            keydown: (event) => {
              // Typing belongs to the box, not to the app's shortcuts.
              event.stopPropagation();
              return false;
            },
            paste: (event) => {
              const images = Array.from(
                event.clipboardData?.files ?? [],
              ).filter((file) => file.type.startsWith("image/"));
              if (!images.length) return false;
              event.preventDefault();
              handlers.current.onPasteImages(images);
              return true;
            },
            compositionstart: () => {
              handlers.current.onComposingChange(true);
              return false;
            },
            compositionend: () => {
              handlers.current.onComposingChange(false);
              return false;
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    const cm = getCM(view);
    if (cm) {
      vimExEditors.set(cm, {
        commit: () => handlers.current.onSubmit(),
        cancel: () => view.contentDOM.blur(),
      });
      // Writing first: insert mode, as a message box is for typing.
      const enterInsert = () => {
        if (!cm.state.vim?.insertMode) Vim.handleKey(cm, "a", "mapping");
      };
      view.contentDOM.addEventListener("focus", enterInsert);
      if (handleRef)
        handleRef.current = {
          escape: () => {
            Vim.handleKey(cm, "<Esc>", "user");
            view.focus();
          },
        };
    }
    return () => {
      if (handleRef) handleRef.current = null;
      viewRef.current = null;
      view.destroy();
    };
  }, []);

  // Someone else's change to the draft (an upload, the terminal's box).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (value === lastValueRef.current) return;
    lastValueRef.current = value;
    const current = view.state.doc.toString();
    const reported = reportedRef.current;
    if (current === value) {
      reported.clear();
      return;
    }
    // Our own earlier text coming back late: newer typing stays.
    if (reported.has(value)) return;
    reported.clear();
    const length = value.length;
    const clamp = (offset: number) => Math.max(0, Math.min(offset, length));
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      selection: selection
        ? EditorSelection.range(clamp(selection.start), clamp(selection.end))
        : EditorSelection.cursor(length),
    });
  }, [value, selection]);

  return <div ref={hostRef} className="agent-history-composer-editor" />;
}

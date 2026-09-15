import { roamgateLocalStorage } from "../browserStorage";
import {
  shortcutMatches,
  shortcutTitle,
  useShortcutPreferences,
} from "../shortcutPreferences";
import {
  CircleHelp,
  CornerDownLeft,
  CornerDownRight,
  ImagePlus,
  Keyboard,
  X,
} from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type MobileTerminalShortcut,
  mobileTerminalShortcutOption,
} from "../mobileTerminalShortcuts";
import {
  beginTerminalComposerSubmission,
  beginTerminalComposerUpload,
  clearTerminalComposerDraft,
  finishTerminalComposerSubmission,
  finishTerminalComposerUpload,
  insertIntoTerminalComposerDraft,
  readTerminalComposerDraft,
  readTerminalComposerSelection,
  subscribeTerminalComposerDraft,
  subscribeTerminalComposerSubmission,
  subscribeTerminalComposerUpload,
  terminalComposerSubmissionPending,
  terminalComposerUploadCount,
  writeTerminalComposerDraft,
  writeTerminalComposerSelection,
} from "../terminalComposer";
import { MessageDialog } from "./ModalDialogs";
import "./TerminalComposer.css";

const TERMINAL_COMPOSER_HELP =
  "Input Composer uses your phone’s native editor for reliable IME, dictation, multiline text, and cursor editing before anything is sent to the terminal. Adding an image opens the system file picker, which takes focus from the composer and may dismiss the keyboard. After you choose an image, its uploaded path is inserted into the draft; tap the text area to reopen the keyboard if needed.";
const TERMINAL_COMPOSER_SHORTCUTS_OPEN_STORAGE_KEY =
  "terminalComposerShortcutsOpen";

/**
 * Bottom-docked mobile terminal composer. A plain textarea owns all editing
 * (IME, dictation, selection, autocorrect, multiline paste) and text only
 * reaches the PTY when the user explicitly chooses Insert or Send, which
 * sidesteps the xterm helper-textarea races described in the IME recovery
 * code. Drafts are write-through to the in-memory store so pane switches and
 * virtual-keyboard resizes never lose text.
 *
 * The configurable mobile shortcut keys live at the top of the dock so the
 * composer is the single mobile control surface. The textarea only receives
 * focus when the user taps it, so opening the composer does not unexpectedly
 * summon the virtual keyboard or hide other mobile controls.
 *
 * Images arrive through clipboard paste or the file picker, upload once, and
 * land in the draft as plain paths at the caret; they reach the terminal only
 * through an explicit Insert or Send like any other text.
 */
export function TerminalComposer({
  draftKey,
  shortcutRows,
  onRunShortcut,
  shortcutDisabledReason,
  onClose,
  onSubmit,
  onUploadImage,
  onError,
}: {
  draftKey: string;
  shortcutRows: (MobileTerminalShortcut | null)[][];
  onRunShortcut: (shortcut: MobileTerminalShortcut) => void;
  shortcutDisabledReason?: (shortcut: MobileTerminalShortcut) => string | null;
  onClose: () => void;
  onSubmit: (text: string, submit: boolean) => Promise<void>;
  onUploadImage: (file: File) => Promise<string>;
  onError: (message: string) => void;
}) {
  useShortcutPreferences();
  const [text, setText] = useState(() => readTerminalComposerDraft(draftKey));
  const [submissionPending, setSubmissionPending] = useState(() =>
    terminalComposerSubmissionPending(draftKey),
  );
  const [uploadCount, setUploadCount] = useState(() =>
    terminalComposerUploadCount(draftKey),
  );
  const [composing, setComposing] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(
    () =>
      roamgateLocalStorage.getItem(
        TERMINAL_COMPOSER_SHORTCUTS_OPEN_STORAGE_KEY,
      ) !== "false",
  );
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composingRef = useRef(false);
  const focusSelectionAfterInsertRef = useRef(false);
  const activeDraftKeyRef = useRef(draftKey);
  activeDraftKeyRef.current = draftKey;

  // Load the incoming pane's draft and subscribe to updates from async work
  // that may outlive an earlier composer mount for this pane.
  useEffect(() => {
    const applyDraft = (draft: string) => setText(draft);
    applyDraft(readTerminalComposerDraft(draftKey));
    return subscribeTerminalComposerDraft(draftKey, applyDraft);
  }, [draftKey]);

  useEffect(() => {
    setSubmissionPending(terminalComposerSubmissionPending(draftKey));
    return subscribeTerminalComposerSubmission(draftKey, setSubmissionPending);
  }, [draftKey]);

  useEffect(() => {
    setUploadCount(terminalComposerUploadCount(draftKey));
    return subscribeTerminalComposerUpload(draftKey, setUploadCount);
  }, [draftKey]);

  // Autosize within the CSS max-height.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [text]);

  // Restore the shared selection after a programmatic insertion. The shared
  // value belongs to the draft key, so an upload started by an older mount can
  // place its path at the current mount's completion-time caret.
  useEffect(() => {
    const textarea = textareaRef.current;
    const selection = readTerminalComposerSelection(draftKey);
    const shouldFocus = focusSelectionAfterInsertRef.current;
    focusSelectionAfterInsertRef.current = false;
    if (!textarea || !selection) return;
    if (shouldFocus && !helpOpen) textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(selection.start, selection.end);
  }, [draftKey, helpOpen, text]);

  // No visualViewport lift here: App.tsx owns keyboard geometry and exposes
  // the measured inset through shared CSS variables.
  const updateText = (textarea: HTMLTextAreaElement) => {
    setText(textarea.value);
    writeTerminalComposerDraft(draftKey, textarea.value);
    writeTerminalComposerSelection(
      draftKey,
      textarea.selectionStart,
      textarea.selectionEnd,
    );
  };

  const insertAtCaret = (targetDraftKey: string, insertion: string) => {
    const textarea =
      activeDraftKeyRef.current === targetDraftKey ? textareaRef.current : null;
    focusSelectionAfterInsertRef.current = textarea !== null;
    insertIntoTerminalComposerDraft(
      targetDraftKey,
      insertion,
      textarea?.selectionStart,
      textarea?.selectionEnd,
    );
  };

  const uploadAndInsert = async (files: File[]) => {
    const images = files.filter(
      (file) => file.type === "" || file.type.startsWith("image/"),
    );
    if (images.length === 0) return;
    const uploadDraftKey = draftKey;
    if (!beginTerminalComposerUpload(uploadDraftKey)) return;
    try {
      for (const file of images) {
        const path = await onUploadImage(file);
        insertAtCaret(uploadDraftKey, path);
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : "Image upload failed");
    } finally {
      finishTerminalComposerUpload(uploadDraftKey);
    }
  };

  const submit = async (sendEnter: boolean) => {
    const draft = text;
    const submittedDraftKey = draftKey;
    if (
      !draft ||
      uploadCount > 0 ||
      composingRef.current ||
      !beginTerminalComposerSubmission(submittedDraftKey)
    ) {
      return;
    }

    // Remove the submitted prefix before the request so an unmount/remount
    // cannot expose it as a second send while the first request is pending.
    // New text remains in the shared draft and is restored with the submitted
    // text if the request fails.
    const current = readTerminalComposerDraft(submittedDraftKey);
    const next = current.startsWith(draft)
      ? current.slice(draft.length)
      : current;
    if (next) {
      writeTerminalComposerDraft(submittedDraftKey, next);
    } else {
      clearTerminalComposerDraft(submittedDraftKey);
    }

    try {
      await onSubmit(draft, sendEnter);
    } catch (error) {
      const pendingText = readTerminalComposerDraft(submittedDraftKey);
      writeTerminalComposerDraft(submittedDraftKey, `${draft}${pendingText}`);
      onError(error instanceof Error ? error.message : "Failed to send input");
    } finally {
      finishTerminalComposerSubmission(submittedDraftKey);
      textareaRef.current?.focus({ preventScroll: true });
    }
  };

  const keepTextareaFocus = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.currentTarget.blur();
  };

  const busy = submissionPending || uploadCount > 0;
  const submitDisabled = !text || busy || composing;
  const hasShortcuts = shortcutRows.some((row) =>
    row.some((shortcut) => shortcut !== null),
  );
  const shortcutColumns = Math.max(1, ...shortcutRows.map((row) => row.length));

  return (
    <>
      <div
        className="terminal-composer"
        role="dialog"
        aria-label="Terminal composer"
      >
        {hasShortcuts && shortcutsOpen ? (
          <div
            className="terminal-composer-shortcuts"
            style={
              {
                "--mobile-shortcut-columns": shortcutColumns,
              } as CSSProperties
            }
            aria-label="Terminal shortcuts"
          >
            {shortcutRows.map((row, rowIndex) => (
              <div
                className="terminal-composer-shortcut-row"
                key={`composer-shortcut-row-${rowIndex}`}
              >
                {row.map((shortcut, slotIndex) => {
                  if (!shortcut) {
                    return (
                      <span
                        className="terminal-composer-shortcut-spacer"
                        aria-hidden="true"
                        key={`composer-shortcut-${rowIndex}-${slotIndex}`}
                      />
                    );
                  }
                  const option = mobileTerminalShortcutOption(shortcut.action);
                  return (
                    <button
                      type="button"
                      aria-label={`Send ${option?.label ?? shortcut.label}`}
                      onPointerDown={keepTextareaFocus}
                      disabled={!!shortcutDisabledReason?.(shortcut)}
                      title={
                        shortcutDisabledReason?.(shortcut) ??
                        option?.label ??
                        shortcut.label
                      }
                      onClick={() => onRunShortcut(shortcut)}
                      key={shortcut.id}
                    >
                      {shortcut.label}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          className="terminal-composer-input"
          value={text}
          rows={1}
          placeholder="Compose input for the terminal…"
          autoComplete="off"
          aria-label="Terminal input draft"
          onChange={(e) => updateText(e.currentTarget)}
          onSelect={(e) =>
            writeTerminalComposerSelection(
              draftKey,
              e.currentTarget.selectionStart,
              e.currentTarget.selectionEnd,
            )
          }
          onCompositionStart={() => {
            composingRef.current = true;
            setComposing(true);
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
            setComposing(false);
          }}
          onPaste={(e) => {
            const images = Array.from(e.clipboardData?.items ?? [])
              .filter(
                (item) =>
                  item.kind === "file" && item.type.startsWith("image/"),
              )
              .map((item) => item.getAsFile())
              .filter((file): file is File => file !== null);
            // No image on the clipboard: let the native text paste proceed.
            if (images.length === 0) return;
            e.preventDefault();
            void uploadAndInsert(images);
          }}
          onKeyDown={(e) => {
            if (
              !e.nativeEvent.isComposing &&
              !composingRef.current &&
              shortcutMatches(e.nativeEvent, "composer.send")
            ) {
              e.preventDefault();
              void submit(true);
            }
          }}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            // Reset so picking the same file again still fires change.
            e.target.value = "";
            if (files.length > 0) void uploadAndInsert(files);
          }}
        />
        <div className="terminal-composer-actions">
          <button
            type="button"
            className="terminal-composer-close"
            title="Close composer"
            aria-label="Close composer"
            onPointerDown={keepTextareaFocus}
            onClick={onClose}
          >
            <X size={15} />
          </button>
          {hasShortcuts ? (
            <button
              type="button"
              className={`terminal-composer-shortcuts-toggle ${
                shortcutsOpen ? "is-open" : ""
              }`}
              title={shortcutsOpen ? "Hide shortcuts" : "Show shortcuts"}
              aria-label={
                shortcutsOpen
                  ? "Hide terminal shortcuts"
                  : "Show terminal shortcuts"
              }
              aria-expanded={shortcutsOpen}
              onPointerDown={keepTextareaFocus}
              onClick={() => {
                const open = !shortcutsOpen;
                roamgateLocalStorage.setItem(
                  TERMINAL_COMPOSER_SHORTCUTS_OPEN_STORAGE_KEY,
                  String(open),
                );
                setShortcutsOpen(open);
              }}
            >
              <Keyboard size={15} />
            </button>
          ) : null}
          <button
            type="button"
            className="terminal-composer-attach"
            title="Add an image"
            aria-label="Add an image"
            disabled={busy}
            onPointerDown={keepTextareaFocus}
            onClick={() => fileInputRef.current?.click()}
          >
            <ImagePlus size={15} />
          </button>
          <button
            type="button"
            className="terminal-composer-help"
            title="About Input Composer"
            aria-label="About Input Composer"
            aria-haspopup="dialog"
            aria-expanded={helpOpen}
            onPointerDown={keepTextareaFocus}
            onClick={() => setHelpOpen(true)}
          >
            <CircleHelp size={15} />
          </button>
          <span className="terminal-composer-hint">
            {uploadCount > 0
              ? "Uploading image…"
              : submissionPending
                ? "Sending…"
                : ""}
          </span>
          <button
            type="button"
            className="terminal-composer-submit"
            title="Insert into the terminal without executing"
            aria-label="Insert draft into the terminal"
            disabled={submitDisabled}
            onPointerDown={keepTextareaFocus}
            onClick={() => void submit(false)}
          >
            <CornerDownRight size={14} />
            Insert
          </button>
          <button
            type="button"
            className="terminal-composer-submit is-primary"
            title={shortcutTitle(
              "Insert into the terminal and send Enter",
              "composer.send",
            )}
            aria-label="Send draft to the terminal"
            disabled={submitDisabled}
            onPointerDown={keepTextareaFocus}
            onClick={() => void submit(true)}
          >
            <CornerDownLeft size={14} />
            Send
          </button>
        </div>
      </div>
      {helpOpen && typeof document !== "undefined"
        ? createPortal(
            <MessageDialog
              open
              title="About Input Composer"
              message={TERMINAL_COMPOSER_HELP}
              onClose={() => setHelpOpen(false)}
            />,
            document.body,
          )
        : null}
    </>
  );
}

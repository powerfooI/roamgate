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
  Paperclip,
  Keyboard,
  SquareTerminal,
  X,
} from "lucide-react";
import { type CSSProperties, useEffect, useId, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
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
import {
  type ComposerCommand,
  completeComposerCommand,
  composerCommandPrefix,
  filterComposerCommands,
  terminalComposerCommands,
} from "../terminalComposerCommands";
import { MessageDialog } from "./ModalDialogs";
import {
  filesFromTerminalDrop,
  isNativeFileDrag,
  terminalUploadedPathsText,
} from "../terminalFileDrop";
import {
  isWorkspacePathDrag,
  workspacePathFromDrag,
} from "../workspacePathDrag";
import "./TerminalComposer.css";

const TERMINAL_COMPOSER_HELP =
  "Input Composer uses your phone’s native editor for reliable IME, dictation, multiline text, and cursor editing before anything is sent to the terminal. Adding a file opens the system file picker, which takes focus from the composer and may dismiss the keyboard. After you choose a file, its uploaded path is inserted into the draft; tap the text area to reopen the keyboard if needed.";
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
 * Files arrive through clipboard paste, drop, or the file picker, upload once, and
 * land in the draft as plain paths at the caret; they reach the terminal only
 * through an explicit Insert or Send like any other text.
 */
export function TerminalComposer({
  draftKey,
  agent,
  shortcutRows,
  onRunShortcut,
  shortcutDisabledReason,
  onClose,
  onSubmit,
  onUploadImage,
  onUploadFile,
  onError,
}: {
  draftKey: string;
  agent?: string;
  shortcutRows: (MobileTerminalShortcut | null)[][];
  onRunShortcut: (shortcut: MobileTerminalShortcut) => void;
  shortcutDisabledReason?: (shortcut: MobileTerminalShortcut) => string | null;
  onClose: () => void;
  onSubmit: (text: string, submit: boolean) => Promise<void>;
  onUploadImage: (file: File) => Promise<string>;
  onUploadFile: (file: File) => Promise<string>;
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
  const [pickerMode, setPickerMode] = useState<"browse" | "inline" | null>(
    null,
  );
  const [activeCommand, setActiveCommand] = useState(0);
  const [replacement, setReplacement] = useState<{
    command: ComposerCommand;
    draft: string;
  } | null>(null);
  const commands = terminalComposerCommands(agent);
  const pickerId = useId();
  const commandListRef = useRef<HTMLDivElement | null>(null);
  const commandPickerRef = useRef<HTMLElement | null>(null);
  const commandsButtonRef = useRef<HTMLButtonElement | null>(null);
  const replacementCancelRef = useRef<HTMLButtonElement | null>(null);
  const matches =
    pickerMode === "inline"
      ? filterComposerCommands(commands, /^\/[^\s]*/.exec(text)?.[0] ?? "")
      : commands;
  const pickerOpen = pickerMode !== null && commands.length > 0;
  const selectedCommand = matches[activeCommand];

  // Agent metadata can arrive while editing. Reset only its command UI, not
  // the textarea (or its focus, selection, and active IME composition).
  useEffect(() => {
    setPickerMode(null);
    setActiveCommand(0);
    setReplacement(null);
  }, [agent]);

  useEffect(() => {
    if (pickerOpen)
      commandListRef.current?.children[activeCommand]?.scrollIntoView({
        block: "nearest",
      });
  }, [activeCommand, pickerOpen, text]);

  // Async uploads or edits must not be discarded by a stale confirmation.
  useEffect(() => {
    if (replacement && replacement.draft !== text) setReplacement(null);
  }, [replacement, text]);
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
    setReplacement(null);
    if (pickerMode !== "browse") {
      setPickerMode(
        composerCommandPrefix(
          textarea.value,
          textarea.selectionStart,
          textarea.selectionEnd,
        ) !== null
          ? "inline"
          : null,
      );
      setActiveCommand(0);
    }
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

  const uploadAndInsert = async (
    files: File[],
    upload: (file: File) => Promise<string>,
  ) => {
    if (files.length === 0) return;
    const uploadDraftKey = draftKey;
    if (!beginTerminalComposerUpload(uploadDraftKey)) return;
    try {
      const paths: string[] = [];
      for (const file of files) paths.push(await upload(file));
      insertAtCaret(uploadDraftKey, terminalUploadedPathsText(paths));
    } catch (error) {
      onError(error instanceof Error ? error.message : "File upload failed");
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

    dismissCommands();

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

  const keepTextareaFocus = (e: React.MouseEvent<HTMLButtonElement>) => {
    // Cancel the focus-taking mouse event, not pointerdown: WebKit can
    // suppress a touch's click entirely when pointerdown is cancelled.
    e.preventDefault();
  };

  const dismissCommands = () => {
    setPickerMode(null);
    setReplacement(null);
    setActiveCommand(0);
  };

  const commandEditorFocused = () =>
    document.activeElement === textareaRef.current;

  const focusPickerWithoutKeyboard = () => {
    if (!commandEditorFocused())
      commandPickerRef.current?.focus({ preventScroll: true });
  };

  const closeCommandPicker = () => {
    const target = commandEditorFocused()
      ? textareaRef.current
      : commandsButtonRef.current;
    dismissCommands();
    target?.focus({ preventScroll: true });
  };

  const selectCommand = (command: ComposerCommand, confirmed = false) => {
    if (busy || composingRef.current) return;
    const draft = readTerminalComposerDraft(draftKey);
    if (confirmed && replacement?.draft !== draft) {
      setReplacement(null);
      return;
    }
    if (pickerMode === "browse" && draft && !confirmed) {
      setReplacement({ command, draft });
      return;
    }
    const textarea = textareaRef.current;
    const next =
      pickerMode === "inline"
        ? completeComposerCommand(
            draft,
            command,
            textarea?.selectionStart ?? 0,
            textarea?.selectionEnd ?? 0,
          )
        : {
            text: `${command.name} `,
            start: command.name.length + 1,
            end: command.name.length + 1,
          };
    if (!next) return;
    writeTerminalComposerDraft(draftKey, next.text);
    writeTerminalComposerSelection(draftKey, next.start, next.end);
    focusSelectionAfterInsertRef.current = true;
    dismissCommands();
    // Also restore focus/selection when choosing the already-present command.
    textarea?.focus({ preventScroll: true });
    textarea?.setSelectionRange(next.start, next.end);
  };

  const commandKeyDown = (e: React.KeyboardEvent) => {
    if (
      !pickerOpen ||
      e.nativeEvent.isComposing ||
      composingRef.current ||
      e.keyCode === 229
    )
      return false;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeCommandPicker();
      return true;
    }
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || replacement)
      return false;
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && matches.length) {
      e.preventDefault();
      e.stopPropagation();
      setActiveCommand(
        (index) =>
          (index + (e.key === "ArrowDown" ? 1 : -1) + matches.length) %
          matches.length,
      );
      return true;
    }
    if (e.key === "Tab" && selectedCommand && !busy) {
      e.preventDefault();
      e.stopPropagation();
      // Keyboard selection must enter the confirmation's tab order. Touch
      // selection keeps the editor focused so its soft keyboard stays open.
      flushSync(() => selectCommand(selectedCommand));
      replacementCancelRef.current?.focus({ preventScroll: true });
      return true;
    }
    return false;
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
                      onMouseDown={keepTextareaFocus}
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
        {pickerOpen ? (
          <section
            ref={commandPickerRef}
            className="terminal-composer-commands"
            role="group"
            tabIndex={-1}
            aria-label="Agent commands"
            aria-activedescendant={
              !replacement && selectedCommand
                ? `${pickerId}-${activeCommand}`
                : undefined
            }
            onKeyDown={commandKeyDown}
          >
            <div className="terminal-composer-command-heading">
              <span>Commands</span>
              <button
                type="button"
                aria-label="Dismiss commands"
                onMouseDown={keepTextareaFocus}
                onClick={closeCommandPicker}
              >
                <X size={16} />
              </button>
            </div>
            {replacement ? (
              <div
                className="terminal-composer-command-confirm"
                role="group"
                aria-label="Confirm draft replacement"
              >
                <p role="status">
                  Replace the entire draft with {replacement.command.name}?
                  Nothing will be sent.
                </p>
                <button
                  type="button"
                  ref={replacementCancelRef}
                  tabIndex={0}
                  onMouseDown={keepTextareaFocus}
                  onClick={() => {
                    setReplacement(null);
                    focusPickerWithoutKeyboard();
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busy || composing}
                  tabIndex={0}
                  onMouseDown={keepTextareaFocus}
                  onClick={() => selectCommand(replacement.command, true)}
                >
                  Replace draft
                </button>
              </div>
            ) : (
              <>
                <div
                  id={pickerId}
                  ref={commandListRef}
                  role="listbox"
                  aria-label="Agent commands"
                  className="terminal-composer-command-list"
                >
                  {matches.map((command, index) => (
                    <button
                      type="button"
                      role="option"
                      id={`${pickerId}-${index}`}
                      key={command.name}
                      tabIndex={-1}
                      aria-selected={index === activeCommand}
                      disabled={busy || composing}
                      onMouseDown={keepTextareaFocus}
                      onClick={() => selectCommand(command)}
                    >
                      <span>
                        <strong>{command.name}</strong> {command.arguments}
                      </span>
                      <span>{command.description}</span>
                    </button>
                  ))}
                </div>
                {matches.length === 0 ? (
                  <span
                    className="terminal-composer-command-note"
                    role="status"
                  >
                    No matching commands. You can still type and send your own.
                  </span>
                ) : null}
              </>
            )}
          </section>
        ) : null}
        <textarea
          ref={textareaRef}
          className="terminal-composer-input"
          value={text}
          rows={1}
          placeholder="Compose input for the terminal…"
          autoComplete="off"
          aria-label="Terminal input draft"
          role="combobox"
          aria-expanded={pickerOpen && !replacement}
          aria-controls={pickerOpen && !replacement ? pickerId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={
            pickerOpen && !replacement && selectedCommand
              ? `${pickerId}-${activeCommand}`
              : undefined
          }
          onChange={(e) => updateText(e.currentTarget)}
          onSelect={(e) => {
            const textarea = e.currentTarget;
            writeTerminalComposerSelection(
              draftKey,
              textarea.selectionStart,
              textarea.selectionEnd,
            );
            if (
              pickerMode === "inline" &&
              composerCommandPrefix(
                textarea.value,
                textarea.selectionStart,
                textarea.selectionEnd,
              ) === null
            )
              dismissCommands();
          }}
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
            void uploadAndInsert(images, onUploadImage);
          }}
          onDragOver={(e) => {
            if (
              !isWorkspacePathDrag(e.dataTransfer) &&
              !isNativeFileDrag(e.dataTransfer)
            )
              return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }}
          onDrop={(e) => {
            if (isWorkspacePathDrag(e.dataTransfer)) {
              e.preventDefault();
              const path = workspacePathFromDrag(e.dataTransfer);
              if (path) insertAtCaret(draftKey, path);
              return;
            }
            if (!isNativeFileDrag(e.dataTransfer)) return;
            e.preventDefault();
            const files = filesFromTerminalDrop(e.dataTransfer);
            if (files === "directory") {
              onError("Drop files only; directories are not supported.");
            } else if (files?.length) {
              void uploadAndInsert(files, onUploadFile);
            }
          }}
          onKeyDown={(e) => {
            if (
              e.nativeEvent.isComposing ||
              composingRef.current ||
              e.keyCode === 229
            )
              return;
            if (shortcutMatches(e.nativeEvent, "composer.send")) {
              e.preventDefault();
              void submit(true);
              return;
            }
            commandKeyDown(e);
          }}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            // Reset so picking the same file again still fires change.
            e.target.value = "";
            if (files.length > 0) void uploadAndInsert(files, onUploadFile);
          }}
        />
        <div className="terminal-composer-actions">
          <button
            type="button"
            className="terminal-composer-close"
            title="Close composer"
            aria-label="Close composer"
            onMouseDown={keepTextareaFocus}
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
              onMouseDown={keepTextareaFocus}
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
            title="Add a file"
            aria-label="Add a file"
            disabled={busy}
            onMouseDown={keepTextareaFocus}
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip size={15} />
          </button>
          <button
            type="button"
            className="terminal-composer-help"
            title="About Input Composer"
            aria-label="About Input Composer"
            aria-haspopup="dialog"
            aria-expanded={helpOpen}
            onMouseDown={keepTextareaFocus}
            onClick={() => setHelpOpen(true)}
          >
            <CircleHelp size={15} />
          </button>
          <button
            type="button"
            className="terminal-composer-commands-toggle"
            aria-label="Commands"
            ref={commandsButtonRef}
            aria-expanded={pickerOpen}
            aria-controls={pickerOpen && !replacement ? pickerId : undefined}
            disabled={commands.length === 0 || busy || composing}
            title={
              commands.length
                ? "Browse agent commands"
                : "No built-in commands for this agent; type any command in the draft"
            }
            onMouseDown={keepTextareaFocus}
            onClick={() => {
              flushSync(() => {
                setPickerMode("browse");
                setActiveCommand(0);
                setReplacement(null);
              });
              // Keep an open editor keyboard. Otherwise focus the non-editable
              // picker so external keys work without summoning a soft keyboard.
              focusPickerWithoutKeyboard();
            }}
          >
            <SquareTerminal size={17} aria-hidden="true" />
          </button>
          <span className="terminal-composer-hint">
            {uploadCount > 0
              ? "Uploading file…"
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
            onMouseDown={keepTextareaFocus}
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
            onMouseDown={keepTextareaFocus}
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

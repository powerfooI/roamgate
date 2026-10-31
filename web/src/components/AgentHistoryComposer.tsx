import { scrollChatPage } from "./chatPaging";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { ImagePlus, Send, TriangleAlert, X } from "lucide-react";
import { useLayoutPreferences } from "../layoutPreferences";
import {
  shortcutLabel,
  shortcutMatches,
  useShortcutPreferences,
} from "../shortcutPreferences";
import {
  beginTerminalComposerUpload,
  finishTerminalComposerUpload,
  insertIntoTerminalComposerDraft,
  readTerminalComposerDraft,
  readTerminalComposerSelection,
  retainTerminalComposerUploadPaths,
  submitTerminalComposerDraft,
  subscribeTerminalComposerDraft,
  subscribeTerminalComposerSubmission,
  subscribeTerminalComposerUpload,
  terminalComposerDraftKeyIsActive,
  terminalComposerSubmissionPending,
  terminalComposerUploadCount,
  writeTerminalComposerDraft,
  writeTerminalComposerSelection,
} from "../terminalComposer";
import { terminalUploadedPathsText } from "../terminalFileDrop";
import {
  attachmentDisplay,
  rememberComposerAttachment,
  withoutAttachment,
} from "../composerAttachments";
import { type AgentCommand, matchCommands } from "../claudeCommands";
import { agentPromptWarning, agentStateKind } from "./agentSession";
import { useTouchReleaseSubmit } from "./useTouchReleaseSubmit";
import "./AgentHistoryComposer.css";

// Grow with the draft up to this height, then scroll inside the textarea.
const MAX_INPUT_HEIGHT_PX = 160;

/**
 * Message input under the chat-style session history. It shares the pane's
 * terminal composer draft, so text moves with the user between the terminal
 * and the history panel, and both surfaces send through the same submission
 * contract.
 *
 * Text reaches the agent by being typed into its terminal. When the agent is
 * not waiting at its prompt, a send attempt only shows where the text will
 * land; it goes out after an explicit Send anyway, never a repeated Enter.
 * Touch keyboards cannot type Shift+Enter, so there Enter adds a line and
 * sending uses the button or the composer send shortcut.
 */
export function AgentHistoryComposer({
  draftKey,
  agent,
  status,
  stateSeq,
  onSend,
  onUploadImage,
  commands = [],
  onError,
}: {
  draftKey: string;
  agent?: string;
  status?: string;
  // Herdr's agent state-change sequence; it advances on every transition.
  stateSeq?: number;
  onSend: (text: string) => Promise<void>;
  onUploadImage: (file: File) => Promise<string>;
  /** The agent's /commands, offered while one is being typed. */
  commands?: AgentCommand[];
  onError: (message: string) => void;
}) {
  useShortcutPreferences();
  const { mobile } = useLayoutPreferences();
  const [text, setText] = useState(() => readTerminalComposerDraft(draftKey));
  const [submissionPending, setSubmissionPending] = useState(() =>
    terminalComposerSubmissionPending(draftKey),
  );
  const [uploadCount, setUploadCount] = useState(() =>
    terminalComposerUploadCount(draftKey),
  );
  const [composing, setComposing] = useState(false);
  const composingRef = useRef(false);
  const compositionEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const compositionUploadsRef = useRef<Array<() => void>>([]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const warning = agentPromptWarning(agent, status);
  const agentState = agentStateKind(status);
  // What a warning was shown for: the draft, the agent, and its state.
  const context = JSON.stringify([text, agent, agentState, stateSeq]);
  // The context the open warning belongs to. Any change revokes it, even one
  // that later changes back, so Send anyway never confirms stale context.
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const confirming = warning !== null && confirmation === context;
  const enterAddsLine =
    mobile || globalThis.matchMedia?.("(pointer: coarse)")?.matches === true;

  const resumeUploads = useCallback(() => {
    for (const resume of compositionUploadsRef.current.splice(0)) resume();
  }, []);

  useEffect(
    () => () => {
      if (compositionEndTimerRef.current !== null)
        clearTimeout(compositionEndTimerRef.current);
      composingRef.current = false;
      resumeUploads();
    },
    [resumeUploads],
  );

  useEffect(() => {
    if (confirmation !== null && confirmation !== context)
      setConfirmation(null);
  }, [confirmation, context]);

  useEffect(() => {
    setText(readTerminalComposerDraft(draftKey));
    setSubmissionPending(terminalComposerSubmissionPending(draftKey));
    setUploadCount(terminalComposerUploadCount(draftKey));
    const unsubscribeDraft = subscribeTerminalComposerDraft(draftKey, setText);
    const unsubscribeSubmission = subscribeTerminalComposerSubmission(
      draftKey,
      setSubmissionPending,
    );
    const unsubscribeUpload = subscribeTerminalComposerUpload(
      draftKey,
      setUploadCount,
    );
    return () => {
      unsubscribeDraft();
      unsubscribeSubmission();
      unsubscribeUpload();
    };
  }, [draftKey]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    void text;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_INPUT_HEIGHT_PX)}px`;
    const selection = readTerminalComposerSelection(draftKey);
    if (selection) {
      // The shared selection is in the draft; the box shows attachments short.
      const shown = attachmentDisplay(text);
      textarea.setSelectionRange(
        shown.shownOffset(selection.start),
        shown.shownOffset(selection.end),
      );
    }
  }, [draftKey, text]);

  const busy = submissionPending || uploadCount > 0;
  const sendDisabled = !text.trim() || busy || composing;

  const uploadImages = async (files: File[]) => {
    if (
      files.length === 0 ||
      composingRef.current ||
      terminalComposerSubmissionPending(draftKey) ||
      !beginTerminalComposerUpload(draftKey)
    )
      return;
    const paths: string[] = [];
    let failed = false;
    try {
      for (const file of files) {
        if (file.type && !file.type.startsWith("image/"))
          throw new Error("Choose an image to attach.");
        const path = await onUploadImage(file);
        rememberComposerAttachment(path, file);
        paths.push(path);
      }
    } catch (error) {
      failed = true;
      onError(error instanceof Error ? error.message : "Image upload failed");
    } finally {
      try {
        if (paths.length) {
          // Recovery also edits the draft; both outcomes must wait for IME input.
          if (composingRef.current)
            await new Promise<void>((resolve) =>
              compositionUploadsRef.current.push(resolve),
            );
          const active = terminalComposerDraftKeyIsActive(draftKey);
          if (failed || !active)
            retainTerminalComposerUploadPaths(
              draftKey,
              terminalUploadedPathsText(paths),
            );
          else
            insertIntoTerminalComposerDraft(
              draftKey,
              terminalUploadedPathsText(paths),
            );
          if (!active)
            onError(
              "Connection or pane changed; image paths retained in the original draft.",
            );
        }
      } finally {
        finishTerminalComposerUpload(draftKey);
      }
    }
  };

  const send = async (confirmed: boolean) => {
    const draft = text;
    if (
      !draft.trim() ||
      composingRef.current ||
      terminalComposerUploadCount(draftKey) > 0
    )
      return;
    if (warning !== null && !confirmed) {
      setConfirmation(context);
      return;
    }
    try {
      await submitTerminalComposerDraft(draftKey, draft, onSend, () =>
        setConfirmation(null),
      );
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Failed to send message",
      );
    }
  };

  const keepTextareaFocus = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
  };
  // The phone keyboard can move these bottom-anchored buttons before click.
  const touchSubmit = useTouchReleaseSubmit({
    submitKey: draftKey,
    resetKey: JSON.stringify([draftKey, context]),
    canStart: () =>
      !composingRef.current &&
      terminalComposerUploadCount(draftKey) === 0 &&
      !terminalComposerSubmissionPending(draftKey),
    canFinish: () => true,
  });
  const sendShortcut = shortcutLabel("composer.send");
  const sendTitle = enterAddsLine
    ? `Send to the agent's terminal (${sendShortcut})`
    : "Send to the agent's terminal (Enter); Shift+Enter for a new line";
  const name = agent?.trim();
  const shown = attachmentDisplay(text);
  // A /command being typed: the matching commands, until Esc puts them away
  // for this draft.
  const [focused, setFocused] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandsDismissed, setCommandsDismissed] = useState<string | null>(
    null,
  );
  const commandMatches =
    focused && commandsDismissed !== text ? matchCommands(text, commands) : [];
  const commandSelected =
    commandMatches[Math.min(commandIndex, commandMatches.length - 1)];
  const completeCommand = (command: AgentCommand) => {
    const draft = `/${command.name} `;
    writeTerminalComposerDraft(draftKey, draft);
    writeTerminalComposerSelection(draftKey, draft.length, draft.length);
    setCommandIndex(0);
  };
  // Keys for the list, ahead of the box: arrows move, Tab
  // completes, Enter completes unless the name is already whole, Esc closes.
  const onCommandKeys = (event: React.KeyboardEvent) => {
    if (!commandMatches.length || event.nativeEvent.isComposing) return;
    const exact = commandMatches.some((each) => `/${each.name}` === text);
    const plain =
      !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
    let handled = true;
    if (event.key === "ArrowDown" && plain)
      setCommandIndex((index) => (index + 1) % commandMatches.length);
    else if (event.key === "ArrowUp" && plain)
      setCommandIndex(
        (index) => (index - 1 + commandMatches.length) % commandMatches.length,
      );
    else if (event.key === "Tab" && plain && commandSelected)
      completeCommand(commandSelected);
    else if (event.key === "Enter" && plain && !exact && commandSelected)
      completeCommand(commandSelected);
    else if (event.key === "Escape") {
      // The box still gets its Esc.
      setCommandsDismissed(text);
      return;
    } else handled = false;
    if (!handled) return;
    event.preventDefault();
    event.nativeEvent.stopPropagation();
  };

  return (
    <div
      className="agent-history-composer"
      onKeyDownCapture={onCommandKeys}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setFocused(false);
      }}
    >
      {commandMatches.length ? (
        <ul
          className="agent-history-composer-commands"
          role="listbox"
          aria-label="Commands"
        >
          {commandMatches.map((command) => (
            <li key={command.name}>
              <button
                type="button"
                role="option"
                aria-selected={command === commandSelected}
                className={command === commandSelected ? "is-selected" : ""}
                // Keep the box focused, and its keyboard up on a phone.
                onMouseDown={(event) => event.preventDefault()}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => completeCommand(command)}
              >
                <strong>/{command.name}</strong>
                {command.description ? (
                  <span>{command.description}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {confirming ? (
        <div className="agent-history-composer-warning" role="alert">
          <TriangleAlert size={14} aria-hidden="true" />
          <p>{warning}</p>
          <div className="agent-history-composer-warning-actions">
            <button
              type="button"
              className="ghost"
              onMouseDown={keepTextareaFocus}
              onClick={() => setConfirmation(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={sendDisabled}
              onMouseDown={keepTextareaFocus}
              {...touchSubmit.buttonProps(() => void send(true))}
            >
              Send anyway
            </button>
          </div>
        </div>
      ) : null}
      {shown.attachments.length ? (
        <div className="agent-history-composer-attachments">
          {shown.attachments.map((attachment, index) => (
            <span key={attachment.path} title={attachment.name}>
              {attachment.url ? (
                <img src={attachment.url} alt={attachment.name} />
              ) : null}
              <span>#{index + 1}</span>
              <button
                type="button"
                aria-label={`Remove image ${index + 1}`}
                onMouseDown={keepTextareaFocus}
                onClick={() =>
                  writeTerminalComposerDraft(
                    draftKey,
                    withoutAttachment(text, attachment.path),
                  )
                }
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="agent-history-composer-row">
        <button
          type="button"
          className="agent-history-composer-attach"
          aria-label="Add images"
          title="Add images"
          disabled={busy || composing}
          onMouseDown={keepTextareaFocus}
          onClick={() => fileInputRef.current?.click()}
        >
          <ImagePlus size={17} aria-hidden="true" />
        </button>
        <textarea
          ref={textareaRef}
          value={shown.text}
          rows={1}
          aria-label={`Message ${name || "agent"}`}
          placeholder={name ? `Message ${name}...` : "Message..."}
          enterKeyHint={enterAddsLine ? "enter" : "send"}
          autoComplete="off"
          onChange={(event) => {
            const textarea = event.currentTarget;
            const draft = shown.toDraft(textarea.value);
            const next = attachmentDisplay(draft);
            writeTerminalComposerDraft(draftKey, draft);
            writeTerminalComposerSelection(
              draftKey,
              next.draftOffset(textarea.value, textarea.selectionStart),
              next.draftOffset(textarea.value, textarea.selectionEnd),
            );
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files);
            const images = (
              files.length
                ? files
                : Array.from(event.clipboardData.items)
                    .map((item) => item.getAsFile())
                    .filter((file): file is File => file !== null)
            ).filter((file) => file.type.startsWith("image/"));
            if (images.length === 0) return;
            event.preventDefault();
            void uploadImages(images);
          }}
          onSelect={(event) => {
            const textarea = event.currentTarget;
            // Skip selections of a value the shared draft has not committed.
            const committed = attachmentDisplay(
              readTerminalComposerDraft(draftKey),
            );
            if (textarea.value !== committed.text) return;
            writeTerminalComposerSelection(
              draftKey,
              committed.draftOffset(textarea.value, textarea.selectionStart),
              committed.draftOffset(textarea.value, textarea.selectionEnd),
            );
          }}
          onCompositionStart={() => {
            touchSubmit.cancel();
            if (compositionEndTimerRef.current !== null) {
              clearTimeout(compositionEndTimerRef.current);
              compositionEndTimerRef.current = null;
            }
            composingRef.current = true;
            setComposing(true);
          }}
          onCompositionEnd={() => {
            // The final native input can follow compositionend in the same task.
            compositionEndTimerRef.current = setTimeout(() => {
              compositionEndTimerRef.current = null;
              composingRef.current = false;
              setComposing(false);
              resumeUploads();
            }, 0);
          }}
          onKeyDown={(event) => {
            if (
              event.nativeEvent.isComposing ||
              composingRef.current ||
              event.keyCode === 229
            )
              return;
            if (
              (event.key === "PageUp" || event.key === "PageDown") &&
              scrollChatPage(
                event.currentTarget,
                event.key === "PageUp" ? -1 : 1,
              )
            ) {
              event.preventDefault();
              return;
            }
            if (event.key === "Escape" && confirming) {
              event.preventDefault();
              event.stopPropagation();
              setConfirmation(null);
              return;
            }
            const plainEnter =
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.altKey &&
              !event.ctrlKey &&
              !event.metaKey;
            if (
              (plainEnter && !enterAddsLine) ||
              shortcutMatches(event.nativeEvent, "composer.send")
            ) {
              event.preventDefault();
              if (!event.repeat) void send(false);
            }
          }}
        />
        <button
          type="button"
          className="agent-history-composer-send"
          aria-label="Send message to the agent"
          title={sendTitle}
          disabled={sendDisabled || confirming}
          onMouseDown={keepTextareaFocus}
          {...touchSubmit.buttonProps(() => void send(false))}
        >
          <Send size={13} />
          {uploadCount > 0
            ? "Uploading..."
            : submissionPending
              ? "Sending..."
              : "Send"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            void uploadImages(files);
          }}
        />
      </div>
    </div>
  );
}

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { ImagePlus, Send, TriangleAlert } from "lucide-react";
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
  onError,
}: {
  draftKey: string;
  agent?: string;
  status?: string;
  // Herdr's agent state-change sequence; it advances on every transition.
  stateSeq?: number;
  onSend: (text: string) => Promise<void>;
  onUploadImage: (file: File) => Promise<string>;
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
    if (selection) textarea.setSelectionRange(selection.start, selection.end);
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
        if (!file.type.startsWith("image/"))
          throw new Error("Choose an image to attach.");
        paths.push(await onUploadImage(file));
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

  return (
    <div className="agent-history-composer">
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
          value={text}
          rows={1}
          aria-label={`Message ${name || "agent"}`}
          placeholder={name ? `Message ${name}...` : "Message..."}
          enterKeyHint={enterAddsLine ? "enter" : "send"}
          autoComplete="off"
          onChange={(event) => {
            const textarea = event.currentTarget;
            writeTerminalComposerDraft(draftKey, textarea.value);
            writeTerminalComposerSelection(
              draftKey,
              textarea.selectionStart,
              textarea.selectionEnd,
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
            if (textarea.value !== readTerminalComposerDraft(draftKey)) return;
            writeTerminalComposerSelection(
              draftKey,
              textarea.selectionStart,
              textarea.selectionEnd,
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

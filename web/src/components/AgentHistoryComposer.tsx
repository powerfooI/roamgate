import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Send, TriangleAlert } from "lucide-react";
import { useLayoutPreferences } from "../layoutPreferences";
import {
  shortcutLabel,
  shortcutMatches,
  useShortcutPreferences,
} from "../shortcutPreferences";
import {
  readTerminalComposerDraft,
  submitTerminalComposerDraft,
  subscribeTerminalComposerDraft,
  subscribeTerminalComposerSubmission,
  subscribeTerminalComposerUpload,
  terminalComposerSubmissionPending,
  terminalComposerUploadCount,
  writeTerminalComposerDraft,
  writeTerminalComposerSelection,
} from "../terminalComposer";
import { agentPromptWarning, agentStateKind } from "./agentSession";
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
  onSend,
  onError,
}: {
  draftKey: string;
  agent?: string;
  status?: string;
  onSend: (text: string) => Promise<void>;
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
  // The draft and agent state the warning was shown for. A different draft or
  // state needs a fresh warning before anything is sent.
  const [confirmation, setConfirmation] = useState<{
    draft: string;
    state: string;
  } | null>(null);
  const composingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const warning = agentPromptWarning(agent, status);
  const agentState = agentStateKind(status);
  const confirming =
    warning !== null &&
    confirmation?.draft === text &&
    confirmation.state === agentState;
  const enterAddsLine =
    mobile || globalThis.matchMedia?.("(pointer: coarse)")?.matches === true;

  useEffect(() => {
    setText(readTerminalComposerDraft(draftKey));
    setSubmissionPending(terminalComposerSubmissionPending(draftKey));
    setUploadCount(terminalComposerUploadCount(draftKey));
    setConfirmation(null);
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
  }, [text]);

  const busy = submissionPending || uploadCount > 0;
  const sendDisabled = !text.trim() || busy || composing;

  const send = async (confirmed: boolean) => {
    const draft = text;
    if (
      !draft.trim() ||
      composingRef.current ||
      terminalComposerUploadCount(draftKey) > 0
    )
      return;
    if (warning !== null && !confirmed) {
      setConfirmation({ draft, state: agentState });
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
  const sendShortcut = shortcutLabel("composer.send");
  const sendTitle = enterAddsLine
    ? `Send to the agent's terminal (${sendShortcut})`
    : "Send to the agent's terminal (Enter); Shift+Enter for a new line";
  const name = agent?.trim();

  return (
    <form
      className="agent-history-composer"
      onSubmit={(event) => {
        event.preventDefault();
        // Submitting again only re-arms the warning; Send anyway confirms.
        void send(false);
      }}
    >
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
              onClick={() => void send(true)}
            >
              Send anyway
            </button>
          </div>
        </div>
      ) : null}
      <div className="agent-history-composer-row">
        <textarea
          ref={textareaRef}
          value={text}
          rows={1}
          aria-label={`Message ${name || "agent"}`}
          placeholder={name ? `Message ${name}...` : "Message..."}
          enterKeyHint={enterAddsLine ? "enter" : "send"}
          autoComplete="off"
          onChange={(event) =>
            writeTerminalComposerDraft(draftKey, event.currentTarget.value)
          }
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
            composingRef.current = true;
            setComposing(true);
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
            setComposing(false);
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
          type="submit"
          className="agent-history-composer-send"
          aria-label="Send message to the agent"
          title={sendTitle}
          disabled={sendDisabled || confirming}
          onMouseDown={keepTextareaFocus}
        >
          <Send size={13} />
          {submissionPending ? "Sending..." : "Send"}
        </button>
      </div>
    </form>
  );
}

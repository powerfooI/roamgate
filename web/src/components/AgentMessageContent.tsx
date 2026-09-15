import { useState } from "react";
import { Copy, X } from "lucide-react";
import { UI_LOCALE } from "../uiLocale";
import { CloseButton } from "./CloseButton";
import { MarkdownPreview } from "./markdown";
import "./AgentMessageContent.css";

export type AgentMessage = {
  id: string;
  role: "user" | "assistant" | "tool";
  kind?: "message" | "tool_call" | "tool_result" | "error";
  tool_name?: string;
  source_call_id?: string;
  is_error?: boolean;
  text: string;
  sent_at: string;
  text_bytes?: number;
};

export function formatAgentMessageTime(sentAt: string) {
  const time = new Date(sentAt);
  if (Number.isNaN(time.getTime())) return sentAt;
  return time.toLocaleString(UI_LOCALE, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function agentMessageRoleLabel(message: AgentMessage) {
  return message.role === "tool"
    ? `${message.kind === "tool_call" ? "Tool arguments" : message.is_error ? "Tool error" : "Tool output"}: ${message.tool_name ?? "tool"}`
    : message.role === "assistant"
      ? "Assistant"
      : "User";
}

// Message rendering is shared by the modal and the inline History reader.
export function AgentMessageContent({
  message,
  embedded = false,
  onClose,
}: {
  message: AgentMessage;
  embedded?: boolean;
  onClose: () => void;
}) {
  const isTool = message.role === "tool";
  const [viewMode, setViewMode] = useState<"rendered" | "raw">(
    message.role === "assistant" ? "rendered" : "raw",
  );
  const [viewModeMessageId, setViewModeMessageId] = useState(message.id);
  if (message.id !== viewModeMessageId) {
    // A refreshed snapshot replaces objects, not the user's selected message.
    // Reset only when switching to another entry.
    setViewModeMessageId(message.id);
    setViewMode(message.role === "assistant" ? "rendered" : "raw");
  }
  // Redacted tool entry whose on-demand content has not arrived (yet).
  const contentPending =
    isTool && message.text.length === 0 && (message.text_bytes ?? 0) > 0;
  const roleLabel = agentMessageRoleLabel(message);

  return (
    <>
      <div
        className={`modal-head agent-message-modal-head ${embedded ? "is-embedded" : ""}`}
      >
        <div>
          <h3>{roleLabel} Message</h3>
          <time>{formatAgentMessageTime(message.sent_at)}</time>
          {message.source_call_id ? (
            <p>Call ID: {message.source_call_id}</p>
          ) : null}
        </div>
        <div className="agent-message-modal-actions">
          {!isTool ? (
            <button
              type="button"
              className="agent-message-mode-toggle"
              onClick={() =>
                setViewMode((mode) =>
                  mode === "rendered" ? "raw" : "rendered",
                )
              }
              aria-label={
                viewMode === "rendered"
                  ? "Show raw markdown"
                  : "Show rendered markdown"
              }
              title={viewMode === "rendered" ? "Show raw" : "Show rendered"}
            >
              {viewMode === "rendered" ? "Raw" : "Rendered"}
            </button>
          ) : null}
          {!contentPending ? (
            <button
              type="button"
              className="agent-history-icon"
              onClick={() => void navigator.clipboard?.writeText(message.text)}
              aria-label="Copy message"
              title="Copy"
            >
              <Copy size={15} />
            </button>
          ) : null}
          {embedded ? (
            <button
              type="button"
              className="agent-history-icon"
              onClick={onClose}
              aria-label="Close message detail"
              title="Close detail"
            >
              <X size={15} />
            </button>
          ) : (
            <CloseButton label="Close message" onClick={onClose} />
          )}
        </div>
      </div>
      {contentPending ? (
        <pre className="agent-message-modal-content">Loading tool content…</pre>
      ) : !isTool && viewMode === "rendered" ? (
        <div className="agent-message-modal-content is-rendered">
          <MarkdownPreview
            text={message.text}
            className="agent-message-markdown"
            breaks
          />
        </div>
      ) : (
        <pre className="agent-message-modal-content">{message.text}</pre>
      )}
    </>
  );
}

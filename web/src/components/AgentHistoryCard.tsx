import { memo, useEffect, useRef, useState } from "react";
import { Copy } from "lucide-react";
import { historyEntryLabel, type HistoryEntry } from "./agentHistory";
import { formatBytes } from "./agentSession";
import { UI_LOCALE } from "../uiLocale";
import { copyTextWithFeedback } from "../copyText";
import "./AgentHistoryCard.css";

export const HISTORY_PREVIEW_CHARS = 4000;

export const AgentHistoryCard = memo(function AgentHistoryCard({
  entry,
  index,
  highlighted = false,
  selected = false,
  contentLoading = false,
  onExpand,
  onLoadContent,
}: {
  entry: HistoryEntry;
  index: number;
  highlighted?: boolean;
  selected?: boolean;
  contentLoading?: boolean;
  onExpand: (entry: HistoryEntry) => void;
  onLoadContent?: (entry: HistoryEntry) => void;
}) {
  const contentRef = useRef<HTMLPreElement>(null);
  const [clipped, setClipped] = useState(false);
  const preview = entry.text.slice(0, HISTORY_PREVIEW_CHARS);
  const truncated = clipped || preview.length < entry.text.length;
  // Tool payloads are redacted on the wire; the user fetches them on demand.
  const contentPending =
    entry.role === "tool" &&
    entry.text.length === 0 &&
    (entry.text_bytes ?? 0) > 0;
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const update = () =>
      setClipped(content.scrollHeight > content.clientHeight + 1);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(content);
    return () => observer.disconnect();
  }, [preview]);
  const label = historyEntryLabel(entry);
  const time = new Date(entry.sent_at);
  return (
    <article
      className={`agent-history-card is-${entry.role} ${highlighted ? "is-minimap-target" : ""} ${selected ? "is-selected" : ""}`}
      data-sequence={index}
    >
      <div className="agent-history-card-meta">
        <strong className="agent-history-card-role">{label}</strong>
        <small>#{index}</small>
        <time title={entry.sent_at}>
          {Number.isNaN(time.getTime())
            ? entry.sent_at
            : time.toLocaleString(UI_LOCALE, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
        </time>
        <span />
        {!contentPending ? (
          <button
            type="button"
            className="agent-history-copy"
            onClick={() => void copyTextWithFeedback(entry.text)}
            aria-label={`Copy entry ${index}`}
            title="Copy"
          >
            <Copy size={13} />
          </button>
        ) : null}
      </div>
      {entry.source_call_id ? (
        <div className="agent-history-tool-id" title={entry.source_call_id}>
          Call ID: {entry.source_call_id}
        </div>
      ) : null}
      {contentPending ? (
        <button
          type="button"
          className="agent-history-tool-load"
          disabled={contentLoading}
          onClick={() => onLoadContent?.(entry)}
          aria-label={`Load ${entry.kind === "tool_call" ? "arguments" : "output"} for entry ${index}`}
        >
          {contentLoading
            ? "Loading…"
            : `Load ${entry.kind === "tool_call" ? "arguments" : "output"} (${formatBytes(entry.text_bytes)})`}
        </button>
      ) : (
        <button
          type="button"
          className={`agent-history-card-open ${truncated ? "is-truncated" : ""}`}
          onClick={() => onExpand(entry)}
          aria-label={`View ${label} entry ${index}`}
        >
          {entry.kind === "tool_call" ? (
            <div className="agent-history-tool-label">Arguments</div>
          ) : entry.kind === "tool_result" ? (
            <div className="agent-history-tool-label">
              {entry.is_error ? "Error output" : "Output"}
            </div>
          ) : null}
          <pre ref={contentRef}>{preview}</pre>
          {truncated ? (
            <span>
              View full {entry.role === "tool" ? "tool details" : "message"}
            </span>
          ) : null}
        </button>
      )}
    </article>
  );
});

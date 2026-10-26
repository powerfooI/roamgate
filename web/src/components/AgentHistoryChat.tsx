import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  Check,
  ChevronRight,
  Copy,
  Square,
  Volume2,
  Wrench,
  X,
} from "lucide-react";
import { useChatSpeech } from "../useChatSpeech";
import { copyTextWithFeedback } from "../copyText";
import { formatUiDateTime } from "../uiLocale";
import { HISTORY_PREVIEW_CHARS } from "./AgentHistoryCard";
import {
  historyEntryLabel,
  isToolContentPending,
  type HistoryEntry,
} from "./agentHistory";
import {
  pairToolSteps,
  previewToolArgumentFields,
  takeQueuedToolLoads,
  toolPayloadKey,
  summarizeToolSteps,
  toolArgumentFields,
  toolArgumentHeadline,
  type HistoryChatItem,
  type ToolStep,
} from "./agentHistoryView";
import { formatBytes } from "./agentSession";
import { MarkdownPreview } from "./markdown";
import "./AgentHistoryChat.css";

// Treat the list as pinned while the reader is within this distance of the
// newest message, so polling refreshes keep following live output.
const FOLLOW_THRESHOLD_PX = 48;

const EMPTY_LOADING: ReadonlySet<string> = new Set();
const noop = () => {};

const ChatBubble = memo(function ChatBubble({
  entry,
  sequence,
  highlighted,
  speech,
  onOpen,
}: {
  entry: HistoryEntry;
  sequence: number;
  highlighted: boolean;
  speech: ReturnType<typeof useChatSpeech>;
  onOpen: (entry: HistoryEntry) => void;
}) {
  const preview = entry.text.slice(0, HISTORY_PREVIEW_CHARS);
  const truncated = preview.length < entry.text.length;
  const label = historyEntryLabel(entry);
  const tone = entry.kind === "error" ? "is-error" : `is-${entry.role}`;
  const playback = speech.state?.messageId === entry.id ? speech.state : null;
  const speaking = playback?.status === "speaking";
  const status =
    playback?.status === "failed"
      ? playback.error
      : playback?.status === "completed"
        ? "Speech completed"
        : playback?.status === "stopped"
          ? "Speech stopped"
          : speaking
            ? "Speaking"
            : "";
  return (
    <article
      className={`agent-history-chat-message ${tone} ${highlighted ? "is-minimap-target" : ""}`}
      data-sequence={sequence}
    >
      <div className="agent-history-chat-bubble">
        {entry.role === "user" ? (
          <p>{preview}</p>
        ) : (
          <MarkdownPreview
            text={preview}
            className="agent-history-chat-markdown"
            breaks
          />
        )}
        {truncated ? (
          <button
            type="button"
            className="agent-history-chat-more"
            onClick={() => onOpen(entry)}
          >
            View full message
          </button>
        ) : null}
      </div>
      <div className="agent-history-chat-meta">
        <time dateTime={entry.sent_at} title={entry.sent_at}>
          {formatUiDateTime(entry.sent_at)}
        </time>
        <button
          type="button"
          className="agent-history-copy"
          onClick={() => void copyTextWithFeedback(entry.text)}
          aria-label={`Copy ${label.toLowerCase()} message`}
          title="Copy"
        >
          <Copy size={12} />
        </button>
        {entry.role === "assistant" ? (
          <button
            type="button"
            className={`agent-history-copy agent-history-speak${speaking ? " is-speaking" : ""}`}
            disabled={!speech.supported || !entry.text.trim()}
            aria-label={
              speaking ? "Stop speaking message" : "Speak assistant message"
            }
            aria-pressed={speaking}
            title={
              !speech.supported
                ? "Speech is not supported by this browser"
                : speaking
                  ? "Stop"
                  : "Speak"
            }
            onClick={() => speech.toggle(entry.id, entry.text)}
          >
            {speaking ? <Square size={12} /> : <Volume2 size={12} />}
          </button>
        ) : null}
        {status ? (
          <span className="agent-history-speech-status" role="status">
            {status}
          </span>
        ) : null}
      </div>
    </article>
  );
});

// Opening a block fetches small arguments so each row can show a headline;
// larger payloads (e.g. whole-file writes) wait until their step is opened.
const AUTO_LOAD_ARGUMENT_BYTES = 16 * 1024;
// Background headline fetches run through a queue with this many requests in
// flight, so opening a long block does not fire one request per call at once.
const BACKGROUND_LOADS_IN_FLIGHT = 3;

type ToolContentLoader = {
  loading: ReadonlySet<string>;
  // Fetch now (the reader asked for this payload).
  load: (entry: HistoryEntry) => void;
  // Fetch when a background slot frees up.
  enqueue: (entry: HistoryEntry) => void;
};

function ToolContentLoad({
  entry,
  label,
  loader,
}: {
  entry: HistoryEntry;
  label: string;
  loader: ToolContentLoader;
}) {
  const loading = loader.loading.has(entry.id);
  return (
    <button
      type="button"
      className="agent-history-tool-load"
      disabled={loading}
      onClick={() => loader.load(entry)}
    >
      {loading
        ? "Loading…"
        : `Load ${label} (${formatBytes(entry.text_bytes)})`}
    </button>
  );
}

function ToolArguments({
  call,
  onOpen,
}: {
  call: HistoryEntry;
  onOpen: (entry: HistoryEntry) => void;
}) {
  const allFields = toolArgumentFields(call.text);
  if (allFields.length === 0) {
    return <p className="agent-history-chat-step-empty">No arguments</p>;
  }
  const { fields, truncated } = previewToolArgumentFields(
    allFields,
    HISTORY_PREVIEW_CHARS,
  );
  return (
    <>
      <dl className="agent-history-chat-args">
        {fields.map((field, index) => (
          <div
            key={field.key || index}
            className={field.code ? "is-code" : undefined}
          >
            {field.key ? <dt>{field.key}</dt> : null}
            <dd>{field.code ? <pre>{field.value}</pre> : field.value}</dd>
          </div>
        ))}
      </dl>
      {truncated ? (
        <button
          type="button"
          className="agent-history-chat-more"
          onClick={() => onOpen(call)}
        >
          View full arguments
        </button>
      ) : null}
    </>
  );
}

function ToolStepDetail({
  step,
  loader,
  onOpen,
}: {
  step: ToolStep;
  loader: ToolContentLoader;
  onOpen: (entry: HistoryEntry) => void;
}) {
  const { call, result } = step;
  const output = result?.text.slice(0, HISTORY_PREVIEW_CHARS) ?? "";
  return (
    <div className="agent-history-chat-step-detail">
      {call ? (
        <section>
          <h4>Arguments</h4>
          {isToolContentPending(call) ? (
            <ToolContentLoad entry={call} label="arguments" loader={loader} />
          ) : (
            <ToolArguments call={call} onOpen={onOpen} />
          )}
        </section>
      ) : null}
      <section>
        <h4>{result?.is_error ? "Error" : "Output"}</h4>
        {!result ? (
          <p className="agent-history-chat-step-empty">
            No output recorded yet
          </p>
        ) : isToolContentPending(result) ? (
          <ToolContentLoad entry={result} label="output" loader={loader} />
        ) : output ? (
          <>
            <pre className="agent-history-chat-step-output">{output}</pre>
            {output.length < result.text.length ? (
              <button
                type="button"
                className="agent-history-chat-more"
                onClick={() => onOpen(result)}
              >
                View full output
              </button>
            ) : null}
          </>
        ) : (
          <p className="agent-history-chat-step-empty">Empty output</p>
        )}
      </section>
    </div>
  );
}

function ToolStepRow({
  step,
  expanded,
  loader,
  onToggle,
  onOpen,
}: {
  step: ToolStep;
  expanded: boolean;
  loader: ToolContentLoader;
  onToggle: () => void;
  onOpen: (entry: HistoryEntry) => void;
}) {
  const { call, result } = step;
  const status = !result ? "pending" : result.is_error ? "error" : "done";
  const headline =
    call && !isToolContentPending(call)
      ? toolArgumentHeadline(call.text)
      : call && loader.loading.has(call.id)
        ? "Loading…"
        : "";
  const sentAt = (call ?? result)?.sent_at;
  return (
    <li
      className={`agent-history-chat-step is-${status} ${expanded ? "is-expanded" : ""}`}
    >
      <button
        type="button"
        className="agent-history-chat-step-row"
        aria-expanded={expanded}
        title={sentAt ? formatUiDateTime(sentAt) : undefined}
        onClick={onToggle}
      >
        {status === "done" ? (
          <Check size={12} aria-label="Succeeded" />
        ) : status === "error" ? (
          <X size={12} aria-label="Failed" />
        ) : (
          <Wrench size={12} aria-label="No output yet" />
        )}
        <span className="agent-history-chat-step-name">{step.name}</span>
        <span className="agent-history-chat-step-headline">{headline}</span>
      </button>
      {expanded ? (
        <ToolStepDetail step={step} loader={loader} onOpen={onOpen} />
      ) : null}
    </li>
  );
}

// Collapsed by default; the block keeps its open state across polling
// refreshes because its key follows the first entry's id.
function ToolBlock({
  entries,
  loader,
  onToggle,
  onOpen,
}: {
  entries: HistoryEntry[];
  loader: ToolContentLoader;
  // Called before the reader opens or closes part of the block.
  onToggle: () => void;
  onOpen: (entry: HistoryEntry) => void;
}) {
  const [open, setOpen] = useState(false);
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const listId = useId();
  const steps = useMemo(() => pairToolSteps(entries), [entries]);
  // Each payload version is queued and fetched directly at most once per
  // block, so a failed fetch does not loop on every polling refresh; the Load
  // buttons still retry. A payload rewritten under the same id is a new
  // version and loads again. Opening a step fetches directly even if its
  // arguments are still waiting in the background queue.
  const queuedRef = useRef(new Set<string>());
  const fetchedRef = useRef(new Set<string>());
  const { load, enqueue } = loader;
  useEffect(() => {
    if (!open) return;
    for (const { call } of steps) {
      if (
        !call ||
        !isToolContentPending(call) ||
        (call.text_bytes ?? 0) > AUTO_LOAD_ARGUMENT_BYTES ||
        queuedRef.current.has(toolPayloadKey(call)) ||
        fetchedRef.current.has(toolPayloadKey(call))
      )
        continue;
      queuedRef.current.add(toolPayloadKey(call));
      enqueue(call);
    }
  }, [enqueue, open, steps]);
  useEffect(() => {
    const step = steps.find((item) => item.id === expandedStep);
    if (!step) return;
    for (const entry of [step.call, step.result]) {
      if (
        !entry ||
        !isToolContentPending(entry) ||
        fetchedRef.current.has(toolPayloadKey(entry))
      )
        continue;
      fetchedRef.current.add(toolPayloadKey(entry));
      load(entry);
    }
  }, [expandedStep, load, steps]);
  const summary = summarizeToolSteps(steps);
  const callsLabel = `${summary.calls} tool ${summary.calls === 1 ? "call" : "calls"}`;
  const toolsLabel = summary.tools
    .map(({ name, count }) => (count > 1 ? `${name} ×${count}` : name))
    .join(", ");
  return (
    <div className={`agent-history-chat-tools ${open ? "is-open" : ""}`}>
      <button
        type="button"
        className="agent-history-chat-tools-toggle"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        title={open ? "Collapse tool calls" : "Expand tool calls"}
        onClick={() => {
          onToggle();
          setOpen((current) => !current);
        }}
      >
        <ChevronRight
          size={12}
          className="agent-history-chat-tools-chevron"
          aria-hidden="true"
        />
        <Wrench size={12} aria-hidden="true" />
        <span className="agent-history-chat-tools-label">
          <strong>{callsLabel}</strong>
          <span className="agent-history-chat-tools-names">{toolsLabel}</span>
          {summary.errors > 0 ? (
            <span className="agent-history-chat-tools-errors">
              {summary.errors} {summary.errors === 1 ? "error" : "errors"}
            </span>
          ) : null}
        </span>
      </button>
      {open ? (
        <ul id={listId} className="agent-history-chat-tools-list">
          {steps.map((step) => (
            <ToolStepRow
              key={step.id}
              step={step}
              expanded={expandedStep === step.id}
              loader={loader}
              onToggle={() => {
                onToggle();
                setExpandedStep((current) =>
                  current === step.id ? null : step.id,
                );
              }}
              onOpen={onOpen}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// The drawer owns the scroll and content refs so its minimap can track and
// jump to bubbles through their data-sequence, as it does for timeline cards.
export function AgentHistoryChat({
  items,
  listRef,
  contentRef,
  highlightedSequence = null,
  followKey,
  toolLoading = EMPTY_LOADING,
  onLoadTool = noop,
  speechActive = true,
  speechScopeKey = "",
  onOpen,
}: {
  items: HistoryChatItem[];
  listRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  highlightedSequence?: number | null;
  // Changing this (e.g. a new search) jumps back to the newest message.
  followKey?: string;
  // Tool entries whose redacted payload is being fetched.
  toolLoading?: ReadonlySet<string>;
  onLoadTool?: (entry: HistoryEntry) => void;
  speechActive?: boolean;
  speechScopeKey?: string;
  onOpen: (entry: HistoryEntry) => void;
}) {
  const speech = useChatSpeech(speechActive, speechScopeKey);
  const followRef = useRef(true);
  const queueRef = useRef<HistoryEntry[]>([]);
  const [queueVersion, setQueueVersion] = useState(0);
  const enqueue = useCallback((entry: HistoryEntry) => {
    queueRef.current.push(entry);
    setQueueVersion((version) => version + 1);
  }, []);
  // Payload versions already fetched by any path; the queue skips them.
  const startedRef = useRef(new Set<string>());
  const load = useCallback(
    (entry: HistoryEntry) => {
      startedRef.current.add(toolPayloadKey(entry));
      onLoadTool(entry);
    },
    [onLoadTool],
  );
  // Start queued fetches whenever a slot frees up: the loading set shrinks as
  // the drawer's fetches settle, which re-runs this effect.
  useEffect(() => {
    const { start, rest } = takeQueuedToolLoads(queueRef.current, {
      inFlight: toolLoading.size,
      limit: BACKGROUND_LOADS_IN_FLIGHT,
      started: startedRef.current,
      loadingIds: toolLoading,
    });
    queueRef.current = rest;
    for (const entry of start) load(entry);
  }, [load, queueVersion, toolLoading]);
  const loader = useMemo(
    () => ({ loading: toolLoading, load, enqueue }),
    [toolLoading, load, enqueue],
  );
  // Opening a block or step grows the list under the reader; stop following
  // so that growth (and the payloads it loads) does not scroll it away.
  // Scrolling back to the bottom resumes following.
  const pauseFollow = useCallback(() => {
    followRef.current = false;
  }, []);

  useLayoutEffect(() => {
    followRef.current = true;
  }, [followKey]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && followRef.current) list.scrollTop = list.scrollHeight;
  }, [items, listRef]);

  // Re-pin after layout changes the list did not cause itself: the inspector
  // revealing a hidden view, a resized pane, or lazy markdown (diagrams,
  // images) growing a bubble after its first paint.
  useEffect(() => {
    const list = listRef.current;
    const content = contentRef.current;
    if (!list || !content) return;
    const observer = new ResizeObserver(() => {
      // A list that does not overflow is at its newest message already.
      if (list.scrollHeight <= list.clientHeight) followRef.current = true;
      if (followRef.current) list.scrollTop = list.scrollHeight;
    });
    observer.observe(list);
    observer.observe(content);
    return () => observer.disconnect();
  }, [listRef, contentRef]);

  return (
    <div
      ref={listRef}
      className="agent-history-chat"
      onScroll={(event) => {
        const list = event.currentTarget;
        // A hidden list reports zero geometry; keep the last pin state.
        if (list.clientHeight === 0) return;
        followRef.current =
          list.scrollHeight - list.scrollTop - list.clientHeight <
          FOLLOW_THRESHOLD_PX;
      }}
    >
      <div ref={contentRef} className="agent-history-chat-content">
        {items.map((item) =>
          item.type === "message" ? (
            <ChatBubble
              key={item.entry.id}
              entry={item.entry}
              sequence={item.sequence}
              highlighted={highlightedSequence === item.sequence}
              speech={speech}
              onOpen={onOpen}
            />
          ) : (
            <ToolBlock
              key={item.id}
              entries={item.entries}
              loader={loader}
              onToggle={pauseFollow}
              onOpen={onOpen}
            />
          ),
        )}
      </div>
    </div>
  );
}

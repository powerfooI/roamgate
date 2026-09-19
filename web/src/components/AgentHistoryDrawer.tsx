import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { Copy, Download, Eye, RefreshCw, X } from "lucide-react";
import { useStoreSelector } from "../store";
import { copyTextWithFeedback } from "../copyText";
import { useConnectionClient } from "../useConnectionClient";
import type { Pane } from "../types";
import {
  DEFAULT_INSPECTOR_NAVIGATION_RATIO,
  inspectorNavigationRatioAtPosition,
} from "../workspaceResource";
import { formatUiRelativeTime, UI_LOCALE } from "../uiLocale";
import { shortId } from "../utils";
import { AgentIcon } from "./AgentIcon";
import { AgentMessageContent } from "./AgentMessageContent";
import { AgentMessageDialog } from "./AgentMessageDialog";
import { AgentHistoryCard } from "./AgentHistoryCard";
import { AgentHistoryFilters } from "./AgentHistoryFilters";
import {
  ALL_HISTORY_FILTERS,
  historyEntryCategory,
  historyEntryLabel,
  mergeAgentHistory,
  selectHistoryEntries,
  type HistoryFilters,
  type AgentHistory,
  type AgentHistoryResponse,
  type HistoryEntry as AgentHistoryEntry,
} from "./agentHistory";
import { AgentSessionPreviewDialog } from "./AgentSessionPreviewDialog";
import {
  type AgentSessionSummary,
  downloadSession,
  formatBytes,
  formatCount,
  formatOptionalCompact,
  formatTokenTotal,
  tokenUsage,
} from "./agentSession";
import "./AgentHistoryDrawer.css";

function formatHistoryTime(sentAt: string) {
  const time = new Date(sentAt);
  if (Number.isNaN(time.getTime())) return sentAt;
  return time.toLocaleString(UI_LOCALE, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatRelativeTime(timestamp: string) {
  const time = new Date(timestamp);
  if (Number.isNaN(time.getTime())) return "Unknown";
  const seconds = Math.round((time.getTime() - Date.now()) / 1000);
  const absoluteSeconds = Math.abs(seconds);
  if (absoluteSeconds < 60) return formatUiRelativeTime(seconds, "second");
  if (absoluteSeconds < 3600)
    return formatUiRelativeTime(Math.round(seconds / 60), "minute");
  if (absoluteSeconds < 86400)
    return formatUiRelativeTime(Math.round(seconds / 3600), "hour");
  return formatUiRelativeTime(Math.round(seconds / 86400), "day");
}

type MessageMinimapVisibleRange = { start: number; end: number };

function minimapPrefersReducedMotion() {
  return (
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
  );
}

// The minimap keeps its bars in a uniform-width flex row, so a pointer
// position maps to a message index from the strip geometry alone.
function AgentHistoryMinimap({
  entries,
  visibleRange,
  indicatorRef,
  onSelect,
}: {
  entries: { message: AgentHistoryEntry; sequence: number }[];
  visibleRange: MessageMinimapVisibleRange | null;
  indicatorRef: RefObject<HTMLDivElement>;
  onSelect: (sequence: number) => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const interactingRef = useRef(false);
  const visibleRangeRef = useRef<MessageMinimapVisibleRange | null>(null);
  visibleRangeRef.current = visibleRange;

  // With more messages than the strip can fit, the bars overflow and the
  // strip scrolls horizontally; glide the strip only when the raised wave
  // actually leaves the strip's viewport, so scrolling the timeline does
  // not restart a smooth-scroll animation on every frame. Suppressed while
  // the user is interacting so the strip never moves under their finger.
  const centerWave = useCallback(() => {
    const strip = stripRef.current;
    const range = visibleRangeRef.current;
    if (!strip || !range || interactingRef.current) return;
    if (strip.scrollWidth <= strip.clientWidth) return;
    const startBar = strip.children[range.start - 1];
    const endBar = strip.children[range.end - 1];
    if (!(startBar instanceof HTMLElement) || !(endBar instanceof HTMLElement))
      return;
    const stripRect = strip.getBoundingClientRect();
    const waveLeft =
      startBar.getBoundingClientRect().left - stripRect.left + strip.scrollLeft;
    const waveRight =
      endBar.getBoundingClientRect().right - stripRect.left + strip.scrollLeft;
    if (
      waveLeft >= strip.scrollLeft &&
      waveRight <= strip.scrollLeft + strip.clientWidth
    ) {
      return;
    }
    const target = Math.max(
      0,
      Math.min(
        strip.scrollWidth - strip.clientWidth,
        (waveLeft + waveRight - strip.clientWidth) / 2,
      ),
    );
    strip.scrollTo({
      left: target,
      behavior: minimapPrefersReducedMotion() ? "auto" : "smooth",
    });
  }, []);

  useEffect(() => {
    centerWave();
  }, [centerWave, visibleRange]);

  // The thumb is the strip's own horizontal scrollbar: it tracks the strip's
  // scroll position whether the strip was panned directly or moved by
  // centerWave following the timeline.
  const updateThumb = useCallback(() => {
    const thumb = indicatorRef.current;
    const track = thumb?.parentElement;
    const strip = stripRef.current;
    if (!thumb || !track || !strip) return;
    const max = strip.scrollWidth - strip.clientWidth;
    if (max <= 1) {
      thumb.style.display = "none";
      return;
    }
    const trackWidth = track.clientWidth;
    if (trackWidth <= 0) {
      thumb.style.display = "none";
      return;
    }
    // Clamp to the track: below a 12px track the minimum width would
    // otherwise exceed it, inverting the travel direction.
    const thumbWidth = Math.min(
      trackWidth,
      Math.max((strip.clientWidth / strip.scrollWidth) * trackWidth, 12),
    );
    thumb.style.display = "block";
    thumb.style.width = `${thumbWidth}px`;
    thumb.style.transform = `translateX(${(strip.scrollLeft / max) * (trackWidth - thumbWidth)}px)`;
  }, [indicatorRef]);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    updateThumb();
    strip.addEventListener("scroll", updateThumb, { passive: true });
    const observer = new ResizeObserver(updateThumb);
    observer.observe(strip);
    return () => {
      strip.removeEventListener("scroll", updateThumb);
      observer.disconnect();
    };
  }, [updateThumb, entries.length]);

  // Bars are memoized so scrolling never re-diffs hundreds of divs; the
  // raised wave flips is-in-view imperatively instead.
  const bars = useMemo(
    () =>
      entries.map(({ message, sequence }) => (
        <div
          key={message.id}
          className={`agent-history-minimap-bar is-${message.role}`}
          title={`#${sequence} ${historyEntryLabel(message)}`}
        />
      )),
    [entries],
  );

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const start = (visibleRange?.start ?? 1) - 1;
    const end = (visibleRange?.end ?? 0) - 1;
    for (let i = 0; i < strip.children.length; i++) {
      strip.children[i].classList.toggle("is-in-view", i >= start && i <= end);
    }
  }, [visibleRange, bars]);

  const sequenceAtClientX = useCallback(
    (clientX: number) => {
      const strip = stripRef.current;
      const firstBar = strip?.firstElementChild;
      if (!strip || !(firstBar instanceof HTMLElement)) return null;
      const count = entries.length;
      if (count === 0) return null;
      // Derive the stride (bar width + gap) from the first two bars'
      // geometry so the mapping stays correct whatever gap the CSS uses.
      const firstLeft = firstBar.getBoundingClientRect().left;
      const secondBar = firstBar.nextElementSibling;
      const stride =
        secondBar instanceof HTMLElement
          ? secondBar.getBoundingClientRect().left - firstLeft
          : firstBar.offsetWidth;
      if (stride <= 0) return null;
      const stripRect = strip.getBoundingClientRect();
      const barsLeft = firstLeft - stripRect.left + strip.scrollLeft;
      const contentX = clientX - stripRect.left + strip.scrollLeft - barsLeft;
      const index = Math.max(
        0,
        Math.min(count - 1, Math.floor(contentX / stride)),
      );
      return entries[index]?.sequence ?? null;
    },
    [entries],
  );

  // Horizontal gestures pan the strip itself; the timeline and wave stay
  // put. Only a tap (no dragging) jumps the timeline to that message.
  const panRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startScrollLeft: number;
    panning: boolean;
  } | null>(null);
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Only the primary pointer's primary button starts an interaction:
    // right/middle clicks must not jump, and a second touch must not
    // overwrite the tracked finger.
    if (event.button !== 0 || !event.isPrimary) return;
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startScrollLeft: stripRef.current?.scrollLeft ?? 0,
      panning: false,
    };
    // From press to release the strip must not move under the pointer, so a
    // tap selects the bar that was actually pressed.
    interactingRef.current = true;
    // Capture from the press so a release off the strip still delivers
    // pointerup; otherwise the interaction state would wedge until the
    // pointer re-enters. Touch gets implicit capture already; pen devices
    // are not necessarily direct-manipulation devices, so capture them too.
    if (event.pointerType !== "touch") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    // Belt-and-suspenders cleanup for exotic capture loss: if a mouse move
    // arrives with no buttons down, the press is over, so drop the state
    // instead of turning the move into a ghost pan. Mouse only: some touch
    // stacks report buttons = 0 mid-drag, and touch cleanup already arrives
    // via pointercancel.
    if (event.pointerType === "mouse" && event.buttons === 0) {
      panRef.current = null;
      interactingRef.current = false;
      return;
    }
    const dx = event.clientX - pan.startX;
    const dy = event.clientY - pan.startY;
    if (!pan.panning) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      pan.panning = true;
    }
    // Touch pans natively (touch-action allows it) and cancels this handler;
    // a mouse cannot pan a scrollable by dragging, so move the strip
    // manually (captured since pointerdown).
    if (event.pointerType === "mouse") {
      const strip = stripRef.current;
      if (strip) strip.scrollLeft = pan.startScrollLeft - dx;
    }
  };
  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (pan && pan.pointerId !== event.pointerId) return;
    panRef.current = null;
    interactingRef.current = false;
    if (!pan || pan.panning) return;
    const sequence = sequenceAtClientX(event.clientX);
    if (sequence !== null) onSelect(sequence);
    centerWave();
  };
  const handlePointerCancel = () => {
    panRef.current = null;
    interactingRef.current = false;
  };
  // The strip is a single slider-like control: one tab stop, with arrow-key
  // navigation across messages. The bars themselves stay non-focusable.
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const count = entries.length;
    if (count === 0) return;
    const range = visibleRangeRef.current;
    const current = range?.start ?? 1;
    const span = range ? range.end - range.start + 1 : 1;
    let next: number;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowDown":
        next = current - 1;
        break;
      case "ArrowRight":
      case "ArrowUp":
        next = current + 1;
        break;
      case "PageUp":
        next = current - span;
        break;
      case "PageDown":
        next = current + span;
        break;
      case "Home":
        next = 1;
        break;
      case "End":
        next = count;
        break;
      default:
        return;
    }
    event.preventDefault();
    onSelect(Math.max(1, Math.min(count, next)));
  };

  const currentSequence = visibleRange?.start ?? 1;
  const currentEntry = entries[currentSequence - 1];
  const currentValueText = currentEntry
    ? `#${currentSequence} ${historyEntryLabel(currentEntry.message)}`
    : undefined;

  return (
    <div className="agent-history-minimap-wrap">
      <div
        ref={stripRef}
        className="agent-history-minimap"
        role="slider"
        tabIndex={0}
        aria-label="Jump to message"
        aria-orientation="horizontal"
        aria-valuemin={1}
        aria-valuemax={entries.length}
        aria-valuenow={currentSequence}
        aria-valuetext={currentValueText}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
      >
        {bars}
      </div>
      <div className="agent-history-minimap-scrollbar" aria-hidden="true">
        <div
          ref={indicatorRef}
          className="agent-history-minimap-scrollbar-thumb"
          style={{ display: "none" }}
        />
      </div>
    </div>
  );
}

export function AgentHistoryDrawer({
  pane,
  open,
  embedded = false,
  wide = false,
  onOpenChange,
}: {
  pane: Pane;
  open: boolean;
  embedded?: boolean;
  wide?: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const workspaces = useStoreSelector((state) => state.workspaces);
  const connectionClient = useConnectionClient();
  const workspaceLabel =
    workspaces.find((workspace) => workspace.workspace_id === pane.workspace_id)
      ?.label ?? pane.workspace_id;
  const [history, setHistory] = useState<AgentHistory | null>(null);
  // Tool entries arrive redacted (metadata only) and are fetched on demand.
  const [filters, setFilters] = useState<HistoryFilters>({
    ...ALL_HISTORY_FILTERS,
    tool: false,
  });
  const [toolEntryTexts, setToolEntryTexts] = useState<
    ReadonlyMap<string, { text: string; bytes: number }>
  >(() => new Map());
  const [toolEntryLoading, setToolEntryLoading] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [session, setSession] = useState<AgentSessionSummary | null>(null);
  const [drawerTab, setDrawerTab] = useState<"messages" | "details">(
    "messages",
  );
  const [previewPane, setPreviewPane] = useState<Pane | null>(null);
  const [previewSummary, setPreviewSummary] =
    useState<AgentSessionSummary | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [expandedMessage, setExpandedMessage] =
    useState<AgentHistoryEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [highlightedSequence, setHighlightedSequence] = useState<number | null>(
    null,
  );
  const [visibleRange, setVisibleRange] =
    useState<MessageMinimapVisibleRange | null>(null);
  // Wide layout: the list sits in a resizable master column and the selected
  // entry opens in an inline detail panel instead of the modal dialog.
  const [wideListRatio, setWideListRatio] = useState(
    DEFAULT_INSPECTOR_NAVIGATION_RATIO,
  );
  const [wideSelectedId, setWideSelectedId] = useState<string | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const minimapIndicatorRef = useRef<HTMLDivElement>(null);
  const wideSplitRef = useRef<HTMLDivElement>(null);
  const visibleRangeKeyRef = useRef("");
  const highlightTimerRef = useRef<number | null>(null);
  const loadSeqRef = useRef(0);
  const previewSeqRef = useRef(0);
  const historyRef = useRef<AgentHistory | null>(null);
  const inFlightRef = useRef<number | null>(null);
  const paneIdRef = useRef(pane.pane_id);
  paneIdRef.current = pane.pane_id;
  // Entries whose content fetch failed; suppresses auto-refetch loops while
  // keeping the card's manual Load button usable.
  const toolEntryFailedRef = useRef<Set<string>>(new Set());

  const loadHistory = useCallback(() => {
    if (
      !pane.agent ||
      inFlightRef.current !== null ||
      !connectionClient.isCurrent()
    )
      return;
    const seq = loadSeqRef.current + 1;
    loadSeqRef.current = seq;
    inFlightRef.current = seq;
    setLoading(!historyRef.current);
    const requested = historyRef.current?.cursor ?? null;
    const params = {
      history_version: 2,
      cursor: requested,
      pane_id: pane.pane_id,
      workspace_id: pane.workspace_id,
      tab_id: pane.tab_id,
      agent: pane.agent,
    };
    Promise.allSettled([
      connectionClient.call("agent_history.get", params),
      connectionClient.call("agent_session.get", {
        pane_id: pane.pane_id,
        agent: pane.agent,
      }),
    ])
      .then(([historyResult, sessionResult]) => {
        if (!connectionClient.isCurrent() || loadSeqRef.current !== seq) return;
        if (historyResult.status === "fulfilled") {
          const merged = mergeAgentHistory(
            historyRef.current,
            historyResult.value as AgentHistoryResponse,
            requested,
          );
          historyRef.current = merged;
          setHistory(merged);
          if (merged) {
            // Drop on-demand texts for entries that left the window or whose
            // content changed under the same id (byte-length mismatch).
            setToolEntryTexts((current) => {
              if (current.size === 0) return current;
              const kept = new Map<string, { text: string; bytes: number }>();
              for (const message of merged.messages) {
                const overlay = current.get(message.id);
                if (
                  overlay !== undefined &&
                  (message.text_bytes === undefined ||
                    overlay.bytes === message.text_bytes)
                ) {
                  kept.set(message.id, overlay);
                }
              }
              return kept.size === current.size ? current : kept;
            });
            // Failure marks for entries that left the window are dead weight;
            // drop them so the set cannot grow across refreshes. An entry
            // reappearing later may retry the fetch once.
            const windowedIds = new Set(
              merged.messages.map((message) => message.id),
            );
            for (const id of toolEntryFailedRef.current) {
              if (!windowedIds.has(id)) toolEntryFailedRef.current.delete(id);
            }
          }
          setExpandedMessage((entry) =>
            entry
              ? (merged?.messages.find((message) => message.id === entry.id) ??
                null)
              : null,
          );
        }
        if (sessionResult.status === "fulfilled")
          setSession(sessionResult.value as AgentSessionSummary);
        const errors = [historyResult, sessionResult]
          .filter((result) => result.status === "rejected")
          .map((result) =>
            result.status === "rejected"
              ? result.reason instanceof Error
                ? result.reason.message
                : String(result.reason)
              : "",
          )
          .filter(Boolean);
        setError(errors.join("\n"));
      })
      .finally(() => {
        if (inFlightRef.current === seq) inFlightRef.current = null;
        if (connectionClient.isCurrent() && loadSeqRef.current === seq) {
          setLoading(false);
        }
      });
  }, [
    connectionClient,
    pane.agent,
    pane.pane_id,
    pane.tab_id,
    pane.workspace_id,
  ]);

  useEffect(() => {
    // Resource-derived state belongs to one pane and one connection lease.
    // Invalidate old continuations before loading a colliding pane ID from a
    // switched connection or replacement runtime.
    loadSeqRef.current += 1;
    inFlightRef.current = null;
    historyRef.current = null;
    previewSeqRef.current += 1;
    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }
    setHighlightedSequence(null);
    visibleRangeKeyRef.current = "";
    setVisibleRange(null);
    setWideSelectedId(null);
    setWideListRatio(DEFAULT_INSPECTOR_NAVIGATION_RATIO);
    setHistory(null);
    setSession(null);
    setDrawerTab("messages");
    setExpandedMessage(null);
    setToolEntryTexts(new Map());
    setToolEntryLoading(new Set());
    toolEntryFailedRef.current.clear();
    setPreviewPane(null);
    setPreviewSummary(null);
    setPreviewLoading(false);
    setPreviewError("");
    setLoading(false);
    setError("");
  }, [
    connectionClient,
    pane.agent,
    pane.pane_id,
    pane.workspace_id,
    pane.tab_id,
  ]);

  const loadToolEntry = useCallback(
    (entry: AgentHistoryEntry) => {
      if (!pane.agent || !connectionClient.isCurrent()) return;
      const paneId = pane.pane_id;
      setToolEntryLoading((current) => new Set(current).add(entry.id));
      connectionClient
        .call("agent_history.entry", {
          pane_id: pane.pane_id,
          workspace_id: pane.workspace_id,
          tab_id: pane.tab_id,
          agent: pane.agent,
          entry_id: entry.id,
        })
        .then((result) => {
          if (!connectionClient.isCurrent() || paneIdRef.current !== paneId)
            return;
          toolEntryFailedRef.current.delete(entry.id);
          const text = (result as { text?: unknown }).text;
          const value = typeof text === "string" ? text : "";
          setToolEntryTexts((current) =>
            new Map(current).set(entry.id, {
              text: value,
              bytes: new TextEncoder().encode(value).length,
            }),
          );
        })
        .catch((value) => {
          if (!connectionClient.isCurrent() || paneIdRef.current !== paneId)
            return;
          toolEntryFailedRef.current.add(entry.id);
          setError(value instanceof Error ? value.message : String(value));
        })
        .finally(() => {
          setToolEntryLoading((current) => {
            if (!current.has(entry.id)) return current;
            const next = new Set(current);
            next.delete(entry.id);
            return next;
          });
        });
    },
    [
      connectionClient,
      pane.agent,
      pane.pane_id,
      pane.tab_id,
      pane.workspace_id,
    ],
  );

  const wideSelectedEntry = wide
    ? (history?.messages.find(
        (entry) =>
          entry.id === wideSelectedId && filters[historyEntryCategory(entry)],
      ) ?? null)
    : null;
  const activeMessage = wide
    ? drawerTab === "messages"
      ? wideSelectedEntry
      : null
    : expandedMessage;

  // A refresh can swap the expanded entry for a redacted stub whose fetched
  // text was pruned (e.g. tool arguments rewritten under the same call id).
  // Refetch instead of showing a blank dialog; failed fetches are not
  // retried automatically (the card's manual Load button still works).
  useEffect(() => {
    if (
      !open ||
      !activeMessage ||
      activeMessage.role !== "tool" ||
      activeMessage.text.length > 0 ||
      (activeMessage.text_bytes ?? 0) === 0 ||
      toolEntryLoading.has(activeMessage.id) ||
      toolEntryFailedRef.current.has(activeMessage.id)
    ) {
      return;
    }
    const overlay = toolEntryTexts.get(activeMessage.id);
    if (overlay !== undefined && overlay.bytes === activeMessage.text_bytes)
      return;
    loadToolEntry(activeMessage);
  }, [activeMessage, open, toolEntryTexts, toolEntryLoading, loadToolEntry]);

  useEffect(() => {
    if (!open) return;
    if (document.visibilityState === "visible") loadHistory();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") loadHistory();
    }, 4000);
    return () => {
      window.clearInterval(timer);
      loadSeqRef.current += 1;
      inFlightRef.current = null;
    };
  }, [loadHistory, open]);

  useEffect(() => {
    if (!open) {
      setExpandedMessage(null);
      setPreviewPane(null);
      setPreviewSummary(null);
      setPreviewError("");
    }
  }, [open]);

  const openSessionPreview = useCallback(() => {
    if (
      !pane.agent ||
      session?.status !== "ok" ||
      !connectionClient.isCurrent()
    ) {
      return;
    }
    const seq = ++previewSeqRef.current;
    setPreviewPane(pane);
    setPreviewSummary(null);
    setPreviewError("");
    setPreviewLoading(true);
    connectionClient
      .call("agent_session.get", {
        pane_id: pane.pane_id,
        agent: pane.agent,
        include_text: true,
        include_trajectory: true,
        preview_limit: 1024 * 1024,
      })
      .then((result) => {
        if (connectionClient.isCurrent() && previewSeqRef.current === seq) {
          setPreviewSummary(result as AgentSessionSummary);
        }
      })
      .catch((value) => {
        if (connectionClient.isCurrent() && previewSeqRef.current === seq) {
          setPreviewError(
            value instanceof Error ? value.message : String(value),
          );
        }
      })
      .finally(() => {
        if (connectionClient.isCurrent() && previewSeqRef.current === seq) {
          setPreviewLoading(false);
        }
      });
  }, [connectionClient, pane, session?.status]);

  const closeSessionPreview = useCallback(() => {
    previewSeqRef.current += 1;
    setPreviewPane(null);
    setPreviewSummary(null);
    setPreviewError("");
  }, []);

  useEffect(
    () => () => {
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current);
      }
    },
    [],
  );

  const messages = useMemo(() => history?.messages ?? [], [history?.messages]);
  // Substitute on-demand fetched tool payloads over their redacted stubs.
  // Byte-length validation keeps overlays from going stale when a revision
  // replaces an entry's content under the same id.
  const hydrateEntry = useCallback(
    (entry: AgentHistoryEntry): AgentHistoryEntry => {
      const overlay = toolEntryTexts.get(entry.id);
      return overlay !== undefined &&
        (entry.text_bytes === undefined || overlay.bytes === entry.text_bytes)
        ? { ...entry, text: overlay.text }
        : entry;
    },
    [toolEntryTexts],
  );
  const hydratedMessages = useMemo(
    () => (toolEntryTexts.size === 0 ? messages : messages.map(hydrateEntry)),
    [messages, toolEntryTexts, hydrateEntry],
  );
  const { visible: visibleMessages, counts } = useMemo(
    () => selectHistoryEntries(hydratedMessages, filters),
    [hydratedMessages, filters],
  );
  const changeFilters = (next: HistoryFilters) => {
    setFilters(next);
    setExpandedMessage((entry) =>
      entry && next[historyEntryCategory(entry)] ? entry : null,
    );
    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }
    setHighlightedSequence(null);
    visibleRangeKeyRef.current = "";
    setVisibleRange(null);
    if (contentRef.current) contentRef.current.scrollTop = 0;
  };

  // Track which messages the timeline viewport contains so the minimap can
  // raise their bars as a moving "wave" while scrolling. Geometry-based
  // instead of IntersectionObserver: it updates every scroll frame and does
  // not depend on observer delivery timing, which mobile browsers throttle
  // aggressively during momentum scrolling.
  useEffect(() => {
    const root = contentRef.current;
    const timeline = timelineRef.current;
    if (drawerTab !== "messages" || !root || !timeline) {
      visibleRangeKeyRef.current = "";
      setVisibleRange(null);
      return;
    }
    const publish = (range: MessageMinimapVisibleRange | null) => {
      const key = range ? `${range.start}:${range.end}` : "";
      // Scrolling crosses card boundaries constantly; skip no-op publishes so
      // the drawer only re-renders when the visible range actually changes.
      if (key === visibleRangeKeyRef.current) return;
      visibleRangeKeyRef.current = key;
      setVisibleRange(range);
    };
    let frame = 0;
    const recompute = () => {
      frame = 0;
      const rootRect = root.getBoundingClientRect();
      // A hidden container (e.g. the inspector showing another view) has an
      // empty rect; skip the scan so background scrolls stay O(1) here.
      if (rootRect.width === 0 || rootRect.height === 0) {
        publish(null);
        return;
      }
      // Clip the viewport rect to the visible screen as well. Normally the
      // content container clips the timeline itself, but if an ancestor ends
      // up being the scroller (mobile viewport quirks) the container's rect
      // spans every card and would mark all bars in-view.
      const viewTop = Math.max(rootRect.top, 0);
      const viewBottom = Math.min(rootRect.bottom, window.innerHeight);
      const cards = timeline.children;
      const count = cards.length;
      // Seed the scan near the expected first visible card (scroll fraction
      // × count) instead of scanning from the top, then back up to the true
      // boundary. Heights vary so the seed is approximate, but the walk is
      // bounded by the estimation error instead of the full history, which
      // matters for long sessions and for frames with a dirty layout (each
      // rect read can otherwise force a layout of the whole timeline).
      let start = 0;
      if (count > 0 && root.scrollHeight > 0) {
        const scrollViewTop = root.scrollTop + (viewTop - rootRect.top);
        start = Math.min(
          count - 1,
          Math.max(0, Math.floor((scrollViewTop / root.scrollHeight) * count)),
        );
        while (start > 0) {
          const prev = cards[start - 1].getBoundingClientRect();
          if (prev.bottom <= viewTop) break;
          start--;
        }
      }
      let min = Infinity;
      let max = -Infinity;
      for (let i = start; i < count; i++) {
        const card = cards[i];
        const rect = card.getBoundingClientRect();
        // Cards stack vertically in DOM order, so once one starts below the
        // viewport every later card is below it too.
        if (rect.top >= viewBottom) break;
        if (rect.bottom <= viewTop) continue;
        const sequence = Number((card as HTMLElement).dataset.sequence);
        if (!Number.isFinite(sequence)) continue;
        min = Math.min(min, sequence);
        max = Math.max(max, sequence);
      }
      publish(min <= max ? { start: min, end: max } : null);
    };
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(recompute);
    };
    schedule();
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(root);
    // Scroll events do not bubble, but capture listeners on window fire for
    // scrolls on any descendant, so this covers the content container and
    // any ancestor that ends up scrolling instead. Filter out scrolls that
    // cannot move the timeline so unrelated views never wake this up.
    const onScroll = (event: Event) => {
      const target = event.target;
      if (
        target === document ||
        (target instanceof Node &&
          (root.contains(target) || target.contains(root)))
      ) {
        schedule();
      }
    };
    window.addEventListener("scroll", onScroll, {
      passive: true,
      capture: true,
    });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", schedule);
    };
  }, [drawerTab, visibleMessages, wide]);

  // Stable identity so the message dialog's focus effect only re-runs when the
  // message itself changes, not on every drawer re-render.
  const closeExpandedMessage = useCallback(() => setExpandedMessage(null), []);

  const usage = tokenUsage(session);
  const messageEntries = useMemo(
    () =>
      visibleMessages.map((message, index) => ({
        message,
        sequence: index + 1,
      })),
    [visibleMessages],
  );

  const scrollToMessage = useCallback(
    (sequence: number) => {
      const card = timelineRef.current?.querySelector(
        `[data-sequence="${sequence}"]`,
      );
      if (!(card instanceof HTMLElement)) return;
      if (wide) {
        // Master-detail: the minimap selects the entry in the detail panel
        // and scrolls its row into view instead of flashing a highlight.
        const message = messageEntries[sequence - 1]?.message;
        if (message) setWideSelectedId(message.id);
        card.scrollIntoView({
          behavior: minimapPrefersReducedMotion() ? "auto" : "smooth",
          block: "nearest",
        });
        return;
      }
      const reduceMotion = minimapPrefersReducedMotion();
      card.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "start",
      });
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current);
      }
      setHighlightedSequence(sequence);
      highlightTimerRef.current = window.setTimeout(() => {
        highlightTimerRef.current = null;
        setHighlightedSequence(null);
      }, 1200);
    },
    [messageEntries, wide],
  );

  const updateWideRatioFromPointer = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const split = wideSplitRef.current;
      if (!split) return;
      const bounds = split.getBoundingClientRect();
      setWideListRatio(
        inspectorNavigationRatioAtPosition(
          event.clientX - bounds.left,
          bounds.width,
        ),
      );
    },
    [],
  );

  const handleWideResizerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const split = wideSplitRef.current;
      if (!split) return;
      const availableWidth = split.getBoundingClientRect().width;
      let next: number | null = null;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        next = inspectorNavigationRatioAtPosition(
          wideListRatio * availableWidth +
            (event.key === "ArrowLeft" ? -16 : 16),
          availableWidth,
        );
      } else if (event.key === "Home") {
        next = inspectorNavigationRatioAtPosition(0, availableWidth);
      } else if (event.key === "End") {
        next = inspectorNavigationRatioAtPosition(
          availableWidth,
          availableWidth,
        );
      }
      if (next === null) return;
      event.preventDefault();
      setWideListRatio(next);
    },
    [wideListRatio],
  );
  const sessionReady = session?.status === "ok";
  const historyReady = history?.status === "ok" || messages.length > 0;
  const hasSessionData = sessionReady || historyReady;
  const unavailable = !loading && !hasSessionData;
  const unavailableDetail =
    session?.detail ||
    history?.detail ||
    error ||
    "No readable session transcript was reported for this agent.";
  const unavailableCommand = session?.command || history?.command;
  const updatedAt = sessionReady
    ? session.updated_at
    : historyReady
      ? history?.updated_at
      : undefined;

  const sessionActions = sessionReady ? (
    <div
      className={
        wide ? "agent-history-toolbar-actions" : "agent-history-footer"
      }
    >
      <button
        type="button"
        className="primary-btn"
        onClick={openSessionPreview}
      >
        <Eye size={14} />
        Open transcript
      </button>
      <button
        type="button"
        className="secondary-btn"
        onClick={() => downloadSession(pane, connectionClient)}
      >
        <Download size={14} />
        Export raw
      </button>
    </div>
  ) : null;

  const historyFilters = (
    <AgentHistoryFilters
      filters={filters}
      counts={counts}
      onToggle={(category) =>
        changeFilters({
          ...filters,
          [category]: !filters[category],
        })
      }
    />
  );
  const historyMinimap =
    messageEntries.length > 1 ? (
      <AgentHistoryMinimap
        entries={messageEntries}
        visibleRange={visibleRange}
        indicatorRef={minimapIndicatorRef}
        onSelect={scrollToMessage}
      />
    ) : null;
  const historyCards = (
    <div className="agent-history-timeline" ref={timelineRef}>
      {messageEntries.map(({ message, sequence }) => (
        <AgentHistoryCard
          entry={message}
          index={sequence}
          key={message.id}
          highlighted={highlightedSequence === sequence}
          selected={wide && wideSelectedId === message.id}
          contentLoading={toolEntryLoading.has(message.id)}
          onExpand={
            wide ? (entry) => setWideSelectedId(entry.id) : setExpandedMessage
          }
          onLoadContent={loadToolEntry}
        />
      ))}
    </div>
  );
  const historyTimeline = (
    <div className="agent-history-content" ref={contentRef}>
      {loading && messages.length === 0 ? (
        <div className="agent-history-state">
          <span className="terminal-loading-dot" />
          Loading messages
        </div>
      ) : messageEntries.length === 0 ? (
        <div className="agent-history-state">
          {messages.length > 0 ? (
            <>
              No entries match the selected message types.
              <button
                type="button"
                className="secondary-btn"
                onClick={() => changeFilters(ALL_HISTORY_FILTERS)}
              >
                Show all types
              </button>
            </>
          ) : (
            "No history entries were found in this session."
          )}
        </div>
      ) : (
        historyCards
      )}
    </div>
  );

  // Wide layout: master-detail. The left column is a resizable list of
  // compact entries; the right column reads the selected entry in full.
  const wideMessagesPanel = (
    <div
      className="agent-history-wide"
      ref={wideSplitRef}
      role="tabpanel"
      style={
        {
          "--agent-history-list-width": `${wideListRatio * 100}%`,
        } as CSSProperties
      }
    >
      <div className="agent-history-wide-list">
        {historyFilters}
        {historyMinimap}
        {historyTimeline}
      </div>
      <div
        className="workspace-inspector-split-resizer"
        role="separator"
        tabIndex={0}
        aria-label="Resize message list"
        aria-orientation="vertical"
        aria-valuemin={15}
        aria-valuemax={75}
        aria-valuenow={Math.round(wideListRatio * 100)}
        title="Drag to resize; double-click to reset"
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          updateWideRatioFromPointer(event);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          updateWideRatioFromPointer(event);
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onPointerCancel={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onDoubleClick={() =>
          setWideListRatio(DEFAULT_INSPECTOR_NAVIGATION_RATIO)
        }
        onKeyDown={handleWideResizerKeyDown}
      />
      <div className="agent-history-wide-detail">
        {wideSelectedEntry ? (
          <AgentMessageContent
            message={hydrateEntry(wideSelectedEntry)}
            embedded
            onClose={() => setWideSelectedId(null)}
          />
        ) : (
          <div className="agent-history-wide-placeholder">
            Select a message to read it here.
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      <aside
        className={`agent-history-drawer ${open ? "is-open" : ""} ${
          embedded ? "is-embedded" : ""
        } ${wide ? "is-wide" : ""}`}
        aria-label="Agent session"
        aria-hidden={!open}
      >
        <div className="agent-history-drawer-head">
          <div className="agent-history-identity">
            <AgentIcon agent={pane.agent} />
            <div className="agent-history-title">
              <strong>Session</strong>
              <span title={workspaceLabel}>
                {workspaceLabel} · {pane.agent ?? "Agent"} ·{" "}
                {shortId(pane.pane_id)}
              </span>
            </div>
          </div>
          <span
            className={`agent-history-status is-${pane.agent_status.toLowerCase()}`}
          >
            {pane.agent_status}
          </span>
          <div className="agent-history-actions">
            <button
              type="button"
              className={`agent-history-icon ${loading ? "is-loading" : ""}`}
              onClick={loadHistory}
              aria-label="Refresh session"
              title="Refresh"
              disabled={loading}
            >
              <RefreshCw size={14} />
            </button>
            {!embedded ? (
              <button
                type="button"
                className="agent-history-icon"
                onClick={() => onOpenChange(false)}
                aria-label="Close session"
                title="Close"
              >
                <X size={14} />
              </button>
            ) : null}
          </div>
        </div>

        {unavailable ? (
          <div className="agent-history-unavailable" role="status">
            <strong>Session unavailable</strong>
            <p>{unavailableDetail}</p>
            {unavailableCommand ? (
              <div className="agent-history-command-row">
                <code>{unavailableCommand}</code>
                <button
                  type="button"
                  className="agent-history-icon"
                  onClick={() => void copyTextWithFeedback(unavailableCommand)}
                  aria-label="Copy integration command"
                  title="Copy command"
                >
                  <Copy size={13} />
                </button>
              </div>
            ) : null}
            <button
              type="button"
              className="secondary-btn"
              onClick={loadHistory}
            >
              <RefreshCw size={13} />
              Retry
            </button>
          </div>
        ) : (
          <>
            <div className="agent-history-tabs">
              <div
                className="agent-history-tab-list"
                role="tablist"
                aria-label="Session drawer view"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={drawerTab === "messages"}
                  title="Most recent 200 messages with their tool entries"
                  className={drawerTab === "messages" ? "is-active" : ""}
                  onClick={() => setDrawerTab("messages")}
                >
                  History
                  {messages.length > 0 ? (
                    <span>
                      {messageEntries.length === messages.length
                        ? messages.length
                        : `${messageEntries.length}/${messages.length}`}
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={drawerTab === "details"}
                  className={drawerTab === "details" ? "is-active" : ""}
                  onClick={() => setDrawerTab("details")}
                >
                  Details
                </button>
              </div>
              {wide ? sessionActions : null}
            </div>

            {error ? <div className="agent-history-error">{error}</div> : null}
            {drawerTab === "messages" ? (
              wide ? (
                wideMessagesPanel
              ) : (
                <div className="agent-history-messages" role="tabpanel">
                  {historyFilters}
                  {historyMinimap}
                  {historyTimeline}
                </div>
              )
            ) : (
              <div className="agent-history-details" role="tabpanel">
                {sessionReady ? (
                  <section
                    className="agent-history-overview"
                    aria-label="Session overview"
                  >
                    <div>
                      <strong>{formatCount(session.stats.turns)}</strong>
                      <span>Turns</span>
                    </div>
                    <div>
                      <strong>{formatTokenTotal(session)}</strong>
                      <span>Tokens</span>
                    </div>
                    <div>
                      <strong
                        title={
                          updatedAt ? formatHistoryTime(updatedAt) : undefined
                        }
                      >
                        {updatedAt ? formatRelativeTime(updatedAt) : "-"}
                      </strong>
                      <span>Updated</span>
                    </div>
                    <p>
                      Input {formatOptionalCompact(usage?.input_tokens)}
                      <span>·</span>
                      Cached {formatOptionalCompact(usage?.cached_input_tokens)}
                      <span>·</span>
                      Output {formatOptionalCompact(usage?.output_tokens)}
                    </p>
                  </section>
                ) : null}
                <DetailRow label="Workspace" value={workspaceLabel} />
                <DetailRow label="Agent" value={pane.agent ?? "-"} />
                <DetailRow label="Pane" value={shortId(pane.pane_id)} />
                <DetailRow
                  label="Session ID"
                  value={session?.session?.value || "-"}
                  copyable={!!session?.session?.value}
                />
                <DetailRow
                  label="Session file"
                  value={session?.path || history?.path || "-"}
                  copyable={!!(session?.path || history?.path)}
                />
                <DetailRow
                  label="Records"
                  value={
                    sessionReady ? formatCount(session.stats.records) : "-"
                  }
                />
                <DetailRow
                  label="File size"
                  value={sessionReady ? formatBytes(session.file?.size) : "-"}
                />
                <DetailRow
                  label="Reasoning"
                  value={formatOptionalCompact(usage?.reasoning_output_tokens)}
                />
                <DetailRow
                  label="Updated"
                  value={updatedAt ? formatHistoryTime(updatedAt) : "-"}
                />
              </div>
            )}

            {!wide ? sessionActions : null}
          </>
        )}
      </aside>
      <AgentMessageDialog
        message={
          !wide && expandedMessage ? hydrateEntry(expandedMessage) : null
        }
        onClose={closeExpandedMessage}
      />
      <AgentSessionPreviewDialog
        pane={previewPane}
        summary={previewSummary}
        loading={previewLoading}
        error={previewError}
        onClose={closeSessionPreview}
      />
    </>
  );
}

function DetailRow({
  label,
  value,
  copyable = false,
}: {
  label: string;
  value: string;
  copyable?: boolean;
}) {
  return (
    <div className="agent-history-detail-row">
      <span>{label}</span>
      <code title={value}>{value}</code>
      {copyable ? (
        <button
          type="button"
          className="agent-history-icon"
          onClick={() => void copyTextWithFeedback(value)}
          aria-label={`Copy ${label.toLowerCase()}`}
          title={`Copy ${label.toLowerCase()}`}
        >
          <Copy size={13} />
        </button>
      ) : null}
    </div>
  );
}

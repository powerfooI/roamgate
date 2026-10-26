import {
  useCallback,
  useEffect,
  useMemo,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Copy,
  ChevronDown,
  Search,
  Download,
  Eye,
  Info,
  MessagesSquare,
  RefreshCw,
  X,
} from "lucide-react";
import { useLayoutPreferences } from "../layoutPreferences";
import { store, useStoreSelector } from "../store";
import { copyTextWithFeedback } from "../copyText";
import { useConnectionClient } from "../useConnectionClient";
import {
  sendTerminalComposerText,
  terminalComposerDraftKey,
} from "../terminalComposer";
import { uploadTerminalImage } from "../terminalImageUpload";
import type { Pane } from "../types";
import {
  DEFAULT_INSPECTOR_NAVIGATION_RATIO,
  inspectorNavigationRatioAtPosition,
} from "../workspaceResource";
import { formatUiDateTime, formatUiRelativeTime } from "../uiLocale";
import { prefersReducedMotion, shortId } from "../utils";
import { AgentIcon } from "./AgentIcon";
import { AgentMessageContent } from "./AgentMessageContent";
import { AgentMessageDialog } from "./AgentMessageDialog";
import { AgentHistoryCard } from "./AgentHistoryCard";
import { AgentHistoryChat } from "./AgentHistoryChat";
import { AgentHistoryComposer } from "./AgentHistoryComposer";
import { AgentHistoryFilters } from "./AgentHistoryFilters";
import { ConversationMinimap } from "./ConversationMinimap";
import {
  groupHistoryChatItems,
  searchHistoryChatEntries,
  readAgentHistoryView,
  writeAgentHistoryView,
  type AgentHistoryView,
} from "./agentHistoryView";
import {
  ALL_HISTORY_FILTERS,
  historyEntryLabel,
  mergeAgentHistory,
  isToolContentPending,
  selectHistoryEntries,
  toolOverlayMatches,
  type ToolTextOverlay,
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
  const { mobile } = useLayoutPreferences();
  const [headerExpanded, setHeaderExpanded] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const headerId = useId();
  const searchId = useId();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchToggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (mobile && searchOpen) searchInputRef.current?.focus();
  }, [mobile, searchOpen]);
  const workspaces = useStoreSelector((state) => state.workspaces);
  const activeConnectionId = useStoreSelector(
    (state) => state.activeConnectionId,
  );
  const connectionGeneration = useStoreSelector(
    (state) => state.connectionGeneration,
  );
  const connectionClient = useConnectionClient();
  const workspaceLabel =
    workspaces.find((workspace) => workspace.workspace_id === pane.workspace_id)
      ?.label ?? pane.workspace_id;
  const [history, setHistory] = useState<AgentHistory | null>(null);
  const [query, setQuery] = useState("");
  // Tool entries arrive redacted (metadata only) and are fetched on demand.
  const [filters, setFilters] = useState<HistoryFilters>({
    ...ALL_HISTORY_FILTERS,
    tool: false,
  });
  const [toolEntryTexts, setToolEntryTexts] = useState<
    ReadonlyMap<string, ToolTextOverlay>
  >(() => new Map());
  const [toolEntryLoading, setToolEntryLoading] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [session, setSession] = useState<AgentSessionSummary | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [view, setView] = useState<AgentHistoryView>(readAgentHistoryView);
  const chatView = view === "chat";
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
  // Wide layout: the list sits in a resizable master column and the selected
  // entry opens in an inline detail panel instead of the modal dialog.
  const [wideListRatio, setWideListRatio] = useState(
    DEFAULT_INSPECTOR_NAVIGATION_RATIO,
  );
  const [wideSelectedId, setWideSelectedId] = useState<string | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const wideSplitRef = useRef<HTMLDivElement>(null);
  const highlightTimerRef = useRef<number | null>(null);
  const sentRefreshTimerRef = useRef<number | null>(null);
  // Advances whenever polling stops (close, pane switch, unmount), so a send
  // that resolves afterwards does not schedule a refresh for a stale drawer.
  const pollScopeRef = useRef(0);
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
            // content changed under the same id (hash or byte-length mismatch).
            setToolEntryTexts((current) => {
              if (current.size === 0) return current;
              const kept = new Map<string, ToolTextOverlay>();
              for (const message of merged.messages) {
                const overlay = current.get(message.id);
                if (
                  overlay !== undefined &&
                  toolOverlayMatches(overlay, message)
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
    setWideSelectedId(null);
    setWideListRatio(DEFAULT_INSPECTOR_NAVIGATION_RATIO);
    setHistory(null);
    setQuery("");
    setHeaderExpanded(false);
    setSearchOpen(false);
    setSession(null);
    setDetailsOpen(false);
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
          const { text, text_hash } = result as {
            text?: unknown;
            text_hash?: unknown;
          };
          const value = typeof text === "string" ? text : "";
          setToolEntryTexts((current) =>
            new Map(current).set(entry.id, {
              text: value,
              bytes: new TextEncoder().encode(value).length,
              hash: typeof text_hash === "string" ? text_hash : undefined,
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

  const messages = useMemo(() => history?.messages ?? [], [history?.messages]);
  // Substitute fetched tool payloads only while they still match the entry.
  const hydrateEntry = useCallback(
    (entry: AgentHistoryEntry): AgentHistoryEntry => {
      const overlay = toolEntryTexts.get(entry.id);
      return overlay !== undefined && toolOverlayMatches(overlay, entry)
        ? { ...entry, text: overlay.text }
        : entry;
    },
    [toolEntryTexts],
  );
  const hydratedMessages = useMemo(
    () => (toolEntryTexts.size === 0 ? messages : messages.map(hydrateEntry)),
    [messages, toolEntryTexts, hydrateEntry],
  );
  const timelineSelection = useMemo(
    () => selectHistoryEntries(hydratedMessages, filters, query),
    [hydratedMessages, filters, query],
  );
  // The chat view has no type filter: it shows every entry, with tool entries
  // collapsed into blocks between the conversation bubbles. Its search keeps
  // a tool call and its result together.
  const chatEntries = useMemo(
    () => (chatView ? searchHistoryChatEntries(hydratedMessages, query) : null),
    [chatView, hydratedMessages, query],
  );
  const visibleMessages = chatEntries ?? timelineSelection.visible;
  const counts = timelineSelection.counts;
  const chatItems = useMemo(
    () => (chatView ? groupHistoryChatItems(visibleMessages) : []),
    [chatView, visibleMessages],
  );
  // The chat view reads full messages in the modal dialog at any width; only
  // the wide timeline uses the inline master-detail reader.
  const masterDetail = wide && !chatView;
  const wideSelectedEntry = masterDetail
    ? (visibleMessages.find((entry) => entry.id === wideSelectedId) ?? null)
    : null;
  const activeMessage = masterDetail
    ? !detailsOpen
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
      !isToolContentPending(activeMessage) ||
      toolEntryLoading.has(activeMessage.id) ||
      toolEntryFailedRef.current.has(activeMessage.id)
    ) {
      return;
    }
    const overlay = toolEntryTexts.get(activeMessage.id);
    if (overlay !== undefined && toolOverlayMatches(overlay, activeMessage))
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
      pollScopeRef.current += 1;
      if (sentRefreshTimerRef.current !== null) {
        window.clearTimeout(sentRefreshTimerRef.current);
        sentRefreshTimerRef.current = null;
      }
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

  const changeFilters = (next: HistoryFilters, nextQuery = query) => {
    setFilters(next);
    setQuery(nextQuery);
    setExpandedMessage((entry) =>
      entry &&
      (chatView
        ? searchHistoryChatEntries(hydratedMessages, nextQuery).some(
            (item) => item.id === entry.id,
          )
        : selectHistoryEntries([hydrateEntry(entry)], next, nextQuery).visible
            .length)
        ? entry
        : null,
    );
    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }
    setHighlightedSequence(null);
    // The chat jumps back to its newest message itself (followKey).
    if (!chatView && contentRef.current) contentRef.current.scrollTop = 0;
  };

  // Stable identity so the message dialog's focus effect only re-runs when the
  // message itself changes, not on every drawer re-render.
  const closeExpandedMessage = useCallback(() => setExpandedMessage(null), []);

  const usage = tokenUsage(session);
  // Minimap entries: every visible timeline card, or every chat bubble (tool
  // chip rows are not indexed).
  const messageEntries = useMemo(
    () =>
      chatView
        ? chatItems.flatMap((item) =>
            item.type === "message"
              ? [{ message: item.entry, sequence: item.sequence }]
              : [],
          )
        : visibleMessages.map((message, index) => ({
            message,
            sequence: index + 1,
          })),
    [chatItems, chatView, visibleMessages],
  );

  const scrollToMessage = useCallback(
    (sequence: number) => {
      const card = timelineRef.current?.querySelector(
        `[data-sequence="${sequence}"]`,
      );
      if (!(card instanceof HTMLElement)) return;
      if (masterDetail) {
        // Master-detail: the minimap selects the entry in the detail panel
        // and scrolls its row into view instead of flashing a highlight.
        const message = messageEntries[sequence - 1]?.message;
        if (message) setWideSelectedId(message.id);
        card.scrollIntoView({
          behavior: prefersReducedMotion() ? "auto" : "smooth",
          block: "nearest",
        });
        return;
      }
      const reduceMotion = prefersReducedMotion();
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
    [masterDetail, messageEntries],
  );
  const minimapEntries = useMemo(
    () =>
      messageEntries.map(({ message }) => ({
        id: message.id,
        role: message.role,
        label: historyEntryLabel(message),
        text: message.text,
      })),
    [messageEntries],
  );
  const selectMinimapEntry = useCallback(
    (index: number) => scrollToMessage(index + 1),
    [scrollToMessage],
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
    <>
      <button
        type="button"
        className="agent-history-icon"
        onClick={openSessionPreview}
        aria-label="Open transcript"
        title="Open transcript"
      >
        <Eye size={14} />
      </button>
      <button
        type="button"
        className="agent-history-icon"
        onClick={() => downloadSession(pane, connectionClient)}
        aria-label="Export raw session"
        title="Export raw session"
      >
        <Download size={14} />
      </button>
    </>
  ) : null;

  // Never hide an active desktop query after switching to mobile layout.
  const mobileSearchOpen = searchOpen || query.length > 0;
  const closeSearch = () => {
    changeFilters(filters, "");
    setSearchOpen(false);
    searchToggleRef.current?.focus();
  };
  const historySearch =
    !mobile || mobileSearchOpen ? (
      <div className="agent-history-search" id={searchId}>
        <input
          ref={searchInputRef}
          type="search"
          aria-label="Search history messages"
          placeholder="Search loaded messages"
          title="Search loaded message text. Tool content is searchable after loading it."
          value={query}
          onChange={(event) =>
            changeFilters(filters, event.currentTarget.value)
          }
          onKeyDown={(event) => {
            if (mobile && event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closeSearch();
            }
          }}
        />
        {mobile ? (
          <button
            type="button"
            className="agent-history-icon"
            aria-label="Close search"
            title="Close search"
            onClick={closeSearch}
          >
            <X size={16} />
          </button>
        ) : null}
      </div>
    ) : null;
  const historyFilters = (
    <>
      {historySearch}
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
    </>
  );
  // The timeline keeps a flat strip above its cards; the chat view gets the
  // side rail beside its bubbles.
  const historyMinimap = (orientation: "auto" | "horizontal") =>
    minimapEntries.length > 1 ? (
      <ConversationMinimap
        entries={minimapEntries}
        scrollerRef={contentRef}
        itemsRef={timelineRef}
        orientation={orientation}
        label="Jump to message"
        className={orientation === "horizontal" ? "agent-history-minimap" : ""}
        onSelect={selectMinimapEntry}
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
  const historyEmptyState =
    loading && messages.length === 0 ? (
      <div className="agent-history-state">
        <span className="terminal-loading-dot" />
        Loading messages
      </div>
    ) : visibleMessages.length === 0 ? (
      <div className="agent-history-state">
        {messages.length > 0 ? (
          <>
            {chatView
              ? "No entries match the search."
              : query.trim()
                ? "No entries match the search and selected message types."
                : "No entries match the selected message types."}
            <button
              type="button"
              className="secondary-btn"
              onClick={() =>
                // The chat view only clears its search; the timeline's
                // hidden type filters keep their state.
                changeFilters(chatView ? filters : ALL_HISTORY_FILTERS, "")
              }
            >
              {chatView
                ? "Clear search"
                : query.trim()
                  ? "Reset filters"
                  : "Show all types"}
            </button>
          </>
        ) : (
          "No history entries were found in this session."
        )}
      </div>
    ) : null;
  const historyTimeline = (
    <div className="agent-history-content" ref={contentRef}>
      {historyEmptyState ?? historyCards}
    </div>
  );
  const sendMessage = useCallback(
    async (text: string) => {
      const scope = pollScopeRef.current;
      await sendTerminalComposerText(
        connectionClient,
        pane.pane_id,
        text,
        true,
      );
      if (!connectionClient.isCurrent() || pollScopeRef.current !== scope)
        return;
      // The agent records the prompt in its transcript once it accepts it;
      // refresh shortly instead of waiting for the next poll. A poll still in
      // flight may predate the prompt, so wait for it and load again.
      const refresh = (delay: number) => {
        if (sentRefreshTimerRef.current !== null)
          window.clearTimeout(sentRefreshTimerRef.current);
        sentRefreshTimerRef.current = window.setTimeout(() => {
          sentRefreshTimerRef.current = null;
          if (inFlightRef.current !== null) refresh(500);
          else loadHistory();
        }, delay);
      };
      refresh(1000);
    },
    [connectionClient, loadHistory, pane.pane_id],
  );
  const notifyComposerError = useCallback((detail: string) => {
    store.notify({ kind: "error", message: "Message input failed", detail });
  }, []);
  const composerDraftKey = terminalComposerDraftKey(
    activeConnectionId,
    connectionGeneration,
    pane.pane_id,
    pane.terminal_id,
  );
  const historyChat = (
    <div
      className="agent-history-messages"
      role="region"
      aria-label="History messages"
    >
      {historySearch}
      {historyEmptyState ?? (
        <div className="agent-history-chat-frame">
          <AgentHistoryChat
            items={chatItems}
            speechActive={open}
            speechScopeKey={JSON.stringify([
              composerDraftKey,
              history?.path,
              session?.session?.value,
            ])}
            listRef={contentRef}
            contentRef={timelineRef}
            highlightedSequence={highlightedSequence}
            followKey={query}
            toolLoading={toolEntryLoading}
            onLoadTool={loadToolEntry}
            onOpen={setExpandedMessage}
          />
          {historyMinimap("auto")}
        </div>
      )}
      {!mobile ? (
        <AgentHistoryComposer
          // A pane or connection switch must never render, or send, the
          // previous draft before the new one loads.
          key={composerDraftKey}
          draftKey={composerDraftKey}
          agent={pane.agent}
          status={pane.agent_status}
          stateSeq={pane.state_change_seq}
          onSend={sendMessage}
          onUploadImage={(file) => uploadTerminalImage(connectionClient, file)}
          onError={notifyComposerError}
        />
      ) : null}
    </div>
  );
  const changeView = (next: AgentHistoryView) => {
    setView(next);
    writeAgentHistoryView(next);
    setDetailsOpen(false);
    setExpandedMessage(null);
  };

  const chatViewToggle = (
    <button
      type="button"
      className="agent-history-icon"
      aria-label="Chat view"
      aria-pressed={chatView && !detailsOpen}
      title={chatView && !detailsOpen ? "Show as timeline" : "Show as chat"}
      onClick={() => changeView(chatView && !detailsOpen ? "timeline" : "chat")}
      disabled={!hasSessionData}
    >
      <MessagesSquare size={mobile ? 16 : 14} />
    </button>
  );

  // Wide layout: master-detail. The left column is a resizable list of
  // compact entries; the right column reads the selected entry in full.
  const wideMessagesPanel = (
    <div
      className="agent-history-wide"
      ref={wideSplitRef}
      role="region"
      aria-label="History messages"
      style={
        {
          "--agent-history-list-width": `${wideListRatio * 100}%`,
        } as CSSProperties
      }
    >
      <div className="agent-history-wide-list">
        {historyFilters}
        {historyMinimap("horizontal")}
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
        data-view={detailsOpen ? "details" : view}
        aria-label="Agent session"
        aria-hidden={!open}
        inert={!open}
      >
        {mobile ? (
          <div className="agent-history-mobile-head">
            <button
              type="button"
              className="agent-history-session-toggle"
              aria-expanded={headerExpanded}
              aria-controls={headerId}
              onClick={() => setHeaderExpanded((current) => !current)}
            >
              <ChevronDown size={14} aria-hidden="true" />
              <span>Session</span>
              <span className="agent-history-count">{messages.length}</span>
              <span className="agent-history-mobile-agent">
                {pane.agent ?? "Agent"}
              </span>
            </button>
            <span
              className={`agent-history-status is-${pane.agent_status.toLowerCase()}`}
            >
              {pane.agent_status}
            </span>
            {chatViewToggle}
            <button
              ref={searchToggleRef}
              type="button"
              className="agent-history-icon"
              aria-label="Search history messages"
              title="Search history messages"
              aria-expanded={mobileSearchOpen}
              aria-controls={mobileSearchOpen ? searchId : undefined}
              onClick={() => {
                if (mobileSearchOpen) closeSearch();
                else {
                  setDetailsOpen(false);
                  setSearchOpen(true);
                }
              }}
            >
              <Search size={16} />
            </button>
            <button
              type="button"
              className="agent-history-icon"
              aria-label="Close session"
              title="Close"
              onClick={() => onOpenChange(false)}
            >
              <X size={16} />
            </button>
          </div>
        ) : null}
        <div
          className="agent-history-drawer-head"
          id={headerId}
          hidden={mobile && !headerExpanded}
        >
          <div className="agent-history-identity">
            <AgentIcon agent={pane.agent} />
            <div className="agent-history-title">
              <strong>
                Session
                {messages.length > 0 ? (
                  <span
                    className="agent-history-count"
                    aria-label={`${visibleMessages.length} of ${messages.length} history entries`}
                    title="Most recent 200 messages with their tool entries"
                  >
                    {visibleMessages.length === messages.length
                      ? messages.length
                      : `${visibleMessages.length}/${messages.length}`}
                  </span>
                ) : null}
              </strong>
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
            {!mobile ? chatViewToggle : null}
            <button
              type="button"
              className="agent-history-icon"
              aria-label="Session details"
              aria-pressed={detailsOpen}
              title={detailsOpen ? "Show history" : "Show session details"}
              onClick={() => setDetailsOpen((current) => !current)}
              disabled={!hasSessionData}
            >
              <Info size={14} />
            </button>
            {sessionActions}
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
            {!embedded && !mobile ? (
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
            {error ? <div className="agent-history-error">{error}</div> : null}
            {!detailsOpen ? (
              chatView ? (
                historyChat
              ) : wide ? (
                wideMessagesPanel
              ) : (
                <div
                  className="agent-history-messages"
                  role="region"
                  aria-label="History messages"
                >
                  {historyFilters}
                  {historyMinimap("horizontal")}
                  {historyTimeline}
                </div>
              )
            ) : (
              <div
                className="agent-history-details"
                role="region"
                aria-label="Session details"
              >
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
                          updatedAt ? formatUiDateTime(updatedAt) : undefined
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
                  value={updatedAt ? formatUiDateTime(updatedAt) : "-"}
                />
              </div>
            )}
          </>
        )}
      </aside>
      <AgentMessageDialog
        message={
          !masterDetail && expandedMessage
            ? hydrateEntry(expandedMessage)
            : null
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

import {
  useCallback,
  useEffect,
  useMemo,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { workspaceFileUrl } from "../workspaceFileUrl";
import {
  Check,
  Copy,
  ChevronDown,
  Download,
  Eye,
  Info,
  MessagesSquare,
  RefreshCw,
  Search,
  Square,
  SquareCheck,
  SquareTerminal,
  X,
} from "lucide-react";
import { useLayoutPreferences } from "../layoutPreferences";
import { store, useStoreSelector } from "../store";
import { copyTextWithFeedback } from "../copyText";
import { useConnectionClient } from "../useConnectionClient";
import {
  readTerminalComposerDraft,
  sendTerminalComposerText,
  terminalComposerDraftKey,
} from "../terminalComposer";
import { uploadTerminalImage } from "../terminalImageUpload";
import type { AgentActivity, AgentPrompt } from "../agentPrompt";
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
import {
  newOutboxMessage,
  nextOutboxDeadline,
  type OutboxMessage,
  readOutbox,
  settleOutbox,
  subscribeOutbox,
  updateOutbox,
} from "./chatOutbox";
import { promptKeyInput } from "./promptKeys";
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

/** Keys a menu in the agent's terminal answers to: label, input, name. */
const PROMPT_KEYS: [string, string, string][] = [
  ["\u2190", "\x1b[D", "Left: previous question"],
  ["\u2191", "\x1b[A", "Up"],
  ["\u2193", "\x1b[B", "Down"],
  ["\u2192", "\x1b[C", "Right: next question"],
  ["Tab", "\t", "Tab"],
  ["Enter", "\r", "Enter: confirm"],
  ["Esc", "\x1b", "Escape: cancel"],
];

/** How long a pane's chat waits for its transcript before saying why. */
const UNAVAILABLE_QUIET_MS = 20_000;

export function AgentHistoryDrawer({
  pane,
  open,
  embedded = false,
  wide = false,
  paneChat,
  onOpenChange,
}: {
  pane: Pane;
  open: boolean;
  embedded?: boolean;
  wide?: boolean;
  /**
   * Shown in the pane, in place of its terminal: the chat only, with what
   * the terminal asks while the agent is blocked.
   */
  paneChat?: {
    /** The blocked agent's prompt, read from its screen. */
    prompt?: AgentPrompt | null;
    /** What the working agent says it is doing, from its screen. */
    activity?: AgentActivity | null;
    onShowTerminal: () => void;
    /**
     * The pane is the active one: only its question takes keys typed with
     * nothing focused, or moves the focus.
     */
    active?: boolean;
    /** Types into the terminal: an answer's key, or Esc to stop. */
    onKeys: (text: string) => void;
    /** Where the message box goes: the phone's bottom bar. */
    composerTarget?: HTMLElement | null;
  };
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
  // Images the user uploaded load from the pane's host.
  const imageUrl = useCallback(
    (path: string) =>
      workspaceFileUrl(connectionClient, pane.workspace_id, path, {
        inline: true,
      }),
    [connectionClient, pane.workspace_id],
  );
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
  const chatView = !!paneChat || view === "chat";
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
  // A pane's chat waits quietly while the transcript cannot be read (a
  // server restart, an agent not yet started): the poll keeps trying, and
  // the reason shows only once it has lasted.
  const [unavailableSince, setUnavailableSince] = useState<number | null>(null);
  const [, setUnavailableTick] = useState(0);
  useEffect(() => {
    if (!unavailable) {
      setUnavailableSince(null);
      return;
    }
    setUnavailableSince((since) => since ?? Date.now());
    const timer = window.setTimeout(
      () => setUnavailableTick((tick) => tick + 1),
      UNAVAILABLE_QUIET_MS + 100,
    );
    return () => window.clearTimeout(timer);
  }, [unavailable]);
  const unavailableLasted =
    unavailableSince !== null &&
    Date.now() - unavailableSince >= UNAVAILABLE_QUIET_MS;
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
      // Writing a question's own answer ("Type something.") where Enter would
      // tick the box off again: the text alone.
      const answering = paneChat?.prompt?.options.find(
        (option) => option.cursor && option.freeText,
      );
      await sendTerminalComposerText(
        connectionClient,
        pane.pane_id,
        text,
        answering?.checked === undefined,
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
    [connectionClient, loadHistory, pane.pane_id, paneChat?.prompt],
  );
  // Messages sent from the box that the transcript does not show yet
  // (chatOutbox): shown on their way, then replaced by their entries. Kept
  // per pane outside this chat, which a switch to the terminal unmounts.
  const outboxKey = terminalComposerDraftKey(
    activeConnectionId,
    connectionGeneration,
    pane.pane_id,
    pane.terminal_id,
  );
  const paneOutbox = useSyncExternalStore(subscribeOutbox, () =>
    readOutbox(outboxKey),
  );
  const historyMessagesRef = useRef(history?.messages ?? []);
  historyMessagesRef.current = history?.messages ?? [];
  const settlePaneOutbox = useCallback(
    (entries: readonly AgentHistoryEntry[]) =>
      updateOutbox(outboxKey, (current) =>
        settleOutbox(current, entries, Date.now()),
      ),
    [outboxKey],
  );
  useEffect(() => {
    // Not before the history is read: a message would time out against an
    // empty one.
    if (history) settlePaneOutbox(history.messages);
  }, [history, settlePaneOutbox]);
  useEffect(() => {
    const deadline = nextOutboxDeadline(paneOutbox);
    if (deadline === null) return;
    const timer = window.setTimeout(
      () => settlePaneOutbox(historyMessagesRef.current),
      Math.max(0, deadline - Date.now()) + 50,
    );
    return () => window.clearTimeout(timer);
  }, [paneOutbox, settlePaneOutbox]);
  const sendFromBox = useCallback(
    async (text: string, replacing?: string) => {
      // An answer typed into a question, a /command or a ! shell line is
      // not recorded as the user's message: those are sent as before.
      const answering = paneChat?.prompt?.options.some(
        (option) => option.cursor && option.freeText,
      );
      if (answering || /^\s*[/!]/.test(text)) {
        await sendMessage(text);
        return;
      }
      // The pane's outbox at the time of sending, whatever this chat shows
      // by the time the send settles.
      const key = outboxKey;
      const message = newOutboxMessage(
        pane.pane_id,
        text,
        historyMessagesRef.current,
        Date.now(),
      );
      const update = (patch: Partial<OutboxMessage>) =>
        updateOutbox(key, (current) =>
          current.map((each) =>
            each.id === message.id ? { ...each, ...patch } : each,
          ),
        );
      updateOutbox(key, (current) => [
        ...current.filter((each) => each.id !== replacing),
        message,
      ]);
      try {
        await sendMessage(text);
        update({ state: "sent", sentAtMs: Date.now() });
      } catch (error) {
        // Kept in the chat, marked, rather than put back in the box.
        update({
          state: "failed",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [outboxKey, pane.pane_id, paneChat?.prompt, sendMessage],
  );
  const retrySend = useCallback(
    (message: OutboxMessage) => void sendFromBox(message.text, message.id),
    [sendFromBox],
  );
  const discardSend = useCallback(
    (message: OutboxMessage) =>
      updateOutbox(outboxKey, (current) =>
        current.filter((each) => each.id !== message.id),
      ),
    [outboxKey],
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
  const historyComposer = (
    <AgentHistoryComposer
      // A pane or connection switch must never render, or send, the
      // previous draft before the new one loads.
      key={composerDraftKey}
      draftKey={composerDraftKey}
      agent={pane.agent}
      status={pane.agent_status}
      stateSeq={pane.state_change_seq}
      onSend={sendFromBox}
      onUploadImage={(file) => uploadTerminalImage(connectionClient, file)}
      onError={notifyComposerError}
    />
  );
  // An agent's question takes the keys in its card, as in the terminal.
  const paneActive = paneChat?.active !== false;
  const promptRef = useRef<HTMLDivElement | null>(null);
  // Blocked, or a menu on its screen though it still counts as working.
  const promptShown =
    !!paneChat &&
    (pane.agent_status.toLowerCase() === "blocked" ||
      !!paneChat.prompt?.confirm ||
      !!paneChat.prompt?.tabs);
  const promptTyping = !!paneChat?.prompt?.options.some(
    (option) => option.cursor && option.freeText,
  );
  const focusChatBox = useCallback(() => {
    (paneChat?.composerTarget ?? document)
      .querySelector<HTMLElement>(
        ".agent-history-composer :is(textarea, [contenteditable='true'])",
      )
      ?.focus({ preventScroll: true });
  }, [paneChat?.composerTarget]);
  const onPromptKey = (
    event: Pick<
      ReactKeyboardEvent<HTMLDivElement>,
      | "key"
      | "shiftKey"
      | "ctrlKey"
      | "metaKey"
      | "altKey"
      | "preventDefault"
      | "stopPropagation"
    > & { nativeEvent: KeyboardEvent },
  ) => {
    if (!paneChat || event.nativeEvent.isComposing) return;
    const input = promptKeyInput(event, promptTyping);
    if (input === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (input === "box") focusChatBox();
    else paneChat.onKeys(input);
  };
  // The message box is hidden while a question only takes a choice; an
  // answer of one's own ("Type something.") is written in it.
  const boxHidden = promptShown && !promptTyping;
  // A question takes the keys when it comes, unless the user is writing; the
  // box gets them for an answer of one's own, and back when it goes.
  const promptWas = useRef<"none" | "choice" | "typing">("none");
  useEffect(() => {
    const now = !promptShown ? "none" : promptTyping ? "typing" : "choice";
    const was = promptWas.current;
    promptWas.current = now;
    if (now === was || !paneActive) return;
    const active = document.activeElement;
    const idle =
      !active ||
      active === document.body ||
      !!active.closest(".agent-history-composer, .agent-chat-prompt");
    if (now === "typing") {
      if (idle) requestAnimationFrame(focusChatBox);
    } else if (now === "choice") {
      if (
        idle &&
        (was === "typing" ||
          !readTerminalComposerDraft(composerDraftKey).trim())
      )
        requestAnimationFrame(() =>
          promptRef.current?.focus({ preventScroll: true }),
        );
    } else if (!active || active === document.body)
      requestAnimationFrame(focusChatBox);
  }, [promptShown, promptTyping, composerDraftKey, focusChatBox, paneActive]);
  // With nothing focused (the hidden box had the keys, say), they still go
  // to the question.
  const onPromptKeyRef = useRef(onPromptKey);
  onPromptKeyRef.current = onPromptKey;
  useEffect(() => {
    if (!promptShown || !paneActive) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.target !== document.body) return;
      promptRef.current?.focus({ preventScroll: true });
      onPromptKeyRef.current({
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        nativeEvent: event,
        preventDefault: () => event.preventDefault(),
        stopPropagation: () => event.stopPropagation(),
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [promptShown, paneActive]);
  // Tab from an empty message box goes to the question. The box is a
  // child of the bottom bar on a phone, so this is caught on the drawer
  // (events come up through the portal), with no element around the box.
  const onComposerKeyCapture = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (
      event.key !== "Tab" ||
      event.shiftKey ||
      !promptShown ||
      !(event.target as HTMLElement).closest?.(".agent-history-composer") ||
      readTerminalComposerDraft(composerDraftKey).trim()
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    promptRef.current?.focus({ preventScroll: true });
  };
  // Hidden by not being drawn: its draft stays in the store.
  const shownComposer = boxHidden ? null : historyComposer;
  // The History view on a phone writes through the bottom bar's Message box.
  const paneComposer = paneChat?.composerTarget
    ? createPortal(shownComposer, paneChat.composerTarget)
    : mobile && !paneChat
      ? null
      : shownComposer;
  // What the agent is doing, or asking, under the conversation; also shown
  // before it has one (a new session asking to trust its folder).
  const chatStatus = (
    <>
      {paneChat &&
      !promptShown &&
      pane.agent_status.toLowerCase() === "working" ? (
        <div className="agent-chat-activity" role="status">
          <span className="agent-chat-activity-mark" aria-hidden="true" />
          <strong>{paneChat.activity?.word ?? "Working..."}</strong>
          {paneChat.activity?.detail ? (
            <span>{paneChat.activity.detail}</span>
          ) : null}
        </div>
      ) : null}
      {promptShown ? (
        <div
          ref={promptRef}
          className="agent-chat-prompt"
          role="status"
          tabIndex={-1}
          onKeyDown={onPromptKey}
        >
          <strong>{pane.agent ?? "The agent"} is waiting for you</strong>
          {paneChat.prompt?.tabs ? (
            // AskUserQuestion's questions: the one shown, and the others.
            <div className="agent-chat-prompt-tabs" role="tablist">
              {paneChat.prompt.tabs.map((tab) => (
                <button
                  key={tab.label}
                  type="button"
                  role="tab"
                  aria-selected={tab.current}
                  className={`${tab.current ? "is-current" : ""}${
                    tab.done ? " is-done" : ""
                  }`}
                  onClick={() => {
                    if (tab.input) paneChat.onKeys(tab.input);
                  }}
                >
                  {tab.done ? <Check size={13} aria-hidden="true" /> : null}
                  {tab.label}
                </button>
              ))}
            </div>
          ) : null}
          {paneChat.prompt?.lines.length ? (
            <pre>
              {paneChat.prompt.lines
                .filter((line) =>
                  paneChat.prompt?.options.every(
                    (option) =>
                      !line.includes(
                        option.key
                          ? `${option.key}. ${option.label}`
                          : option.label,
                      ),
                  ),
                )
                .join("\n")}
            </pre>
          ) : null}
          <div
            className={`agent-chat-prompt-actions${
              paneChat.prompt?.options.some((option) => option.detail)
                ? " has-details"
                : ""
            }`}
          >
            {paneChat.prompt?.options.map((option) => (
              <button
                key={option.label}
                type="button"
                className={`secondary-btn${option.cursor ? " is-cursor" : ""}`}
                aria-current={option.cursor ? "true" : undefined}
                onClick={() => paneChat.onKeys(option.input)}
              >
                {option.key ? <kbd>{option.key}</kbd> : null}{" "}
                {option.checked === undefined ? null : option.checked ? (
                  <SquareCheck size={15} aria-label="picked" />
                ) : (
                  <Square size={15} aria-label="not picked" />
                )}{" "}
                {option.label}
                {option.detail ? <small>{option.detail}</small> : null}
              </button>
            ))}
          </div>
          {paneChat.prompt?.submit ? (
            <button
              type="button"
              className="secondary-btn agent-chat-prompt-submit"
              onClick={() => {
                if (paneChat.prompt?.submit)
                  paneChat.onKeys(paneChat.prompt.submit);
              }}
            >
              Submit these answers
            </button>
          ) : null}
          <small className="agent-chat-prompt-hint">
            {promptTyping
              ? "Write your answer in the message box · Enter sends it"
              : "↑↓ or j k · 1–9 · Tab · Enter · Esc"}
          </small>
          {/* The menu's own keys: moving between questions and choices,
              confirming, cancelling. */}
          <div className="agent-chat-prompt-keys" aria-label="Keys">
            {PROMPT_KEYS.filter(
              // The tabs move between questions themselves.
              ([, input]) =>
                !paneChat.prompt?.tabs ||
                (input !== "\x1b[D" && input !== "\x1b[C"),
            ).map(([label, input, name]) => (
              <button
                key={name}
                type="button"
                className="secondary-btn"
                aria-label={name}
                title={name}
                onClick={() => paneChat.onKeys(input)}
              >
                <kbd>{label}</kbd>
              </button>
            ))}
            <button
              type="button"
              className="secondary-btn"
              onClick={paneChat.onShowTerminal}
            >
              <SquareTerminal size={13} /> Terminal
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
  const historyChat = (
    <div
      className="agent-history-messages"
      role="region"
      aria-label="History messages"
      onClick={(event) => {
        // A click on the chat (not on a control, nor ending a selection)
        // goes to its message box, on a desktop; on a phone it would bring
        // the keyboard up with every tap.
        const target = event.target as Element;
        if (
          !paneChat ||
          !paneComposer ||
          target.closest(
            "button, a, input, textarea, select, summary, label, [role='button'], [contenteditable='true'], .agent-history-composer",
          ) ||
          window.getSelection()?.isCollapsed === false ||
          window.matchMedia("(pointer: coarse)").matches
        )
          return;
        event.currentTarget
          .querySelector<HTMLElement>(
            ".agent-history-composer :is(textarea, [contenteditable='true'])",
          )
          ?.focus({ preventScroll: true });
      }}
    >
      {!paneChat || searchOpen || query ? historySearch : null}
      {(paneOutbox.length ? null : historyEmptyState) ?? (
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
            imageUrl={imageUrl}
            outbox={paneOutbox}
            onRetrySend={retrySend}
            onDiscardSend={discardSend}
          />
          {historyMinimap("auto")}
        </div>
      )}
      {chatStatus}
      {paneComposer}
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
        } ${wide ? "is-wide" : ""}${paneChat ? " is-pane-chat" : ""}`}
        data-view={detailsOpen ? "details" : view}
        aria-label="Agent session"
        aria-hidden={!open}
        inert={!open}
        onKeyDownCapture={onComposerKeyCapture}
      >
        {mobile && !paneChat ? (
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
          hidden={mobile && !paneChat && !headerExpanded}
        >
          {paneChat ? (
            <AgentIcon agent={pane.agent} />
          ) : (
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
          )}
          <span
            className={`agent-history-status is-${pane.agent_status.toLowerCase()}`}
          >
            {pane.agent_status}
          </span>
          <div className="agent-history-actions">
            {paneChat ? (
              <>
                <button
                  type="button"
                  className="agent-history-icon"
                  aria-label="Search the conversation"
                  aria-pressed={searchOpen}
                  title="Search"
                  onClick={() => {
                    if (searchOpen) changeFilters(filters, "");
                    setSearchOpen(!searchOpen);
                  }}
                >
                  <Search size={14} />
                </button>
                {pane.agent_status.toLowerCase() === "working" ? (
                  <button
                    type="button"
                    className="agent-history-icon"
                    aria-label="Stop"
                    title="Stop: Esc in the terminal"
                    onClick={() => paneChat.onKeys("\x1b")}
                  >
                    <Square size={14} />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="agent-history-icon"
                  aria-label="Show the terminal"
                  title="Show the terminal"
                  onClick={paneChat.onShowTerminal}
                >
                  <SquareTerminal size={14} />
                </button>
              </>
            ) : (
              <>
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
              </>
            )}
            {paneChat ? null : sessionActions}
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

        {unavailable && paneChat ? (
          <div className="agent-chat-waiting" role="status">
            <span className="agent-chat-activity-mark" aria-hidden="true" />
            <span>No conversation yet</span>
            {unavailableLasted ? <small>{unavailableDetail}</small> : null}
          </div>
        ) : unavailable ? (
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
        ) : null}
        {unavailable && paneChat ? (
          // A pane's chat still types into the agent, and answers its
          // questions, without its transcript.
          <>
            {chatStatus}
            {paneComposer}
          </>
        ) : unavailable ? null : (
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

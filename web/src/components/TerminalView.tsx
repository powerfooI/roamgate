import { createPortal } from "react-dom";
import {
  createReviewAnnotation,
  MAX_QUOTE_LENGTH,
  terminalAnnotationTitle,
  type TerminalReviewAnnotation,
} from "../annotations";
import {
  WORKSPACE_ANNOTATION_REQUEST_EVENT,
  type WorkspaceAnnotationRequest,
} from "../workspaceResource";
import {
  AnnotationComposerPopover,
  type AnnotationComposerDraft,
} from "./AnnotationComposerPopover";
import { isMobileLayout, LAYOUT_CHANGE_EVENT } from "../layoutPreferences";
import { terminalFontOptions } from "../appearance";
import { detectShortcutPlatform } from "../shortcutBindings";
import {
  getShortcutSnapshot,
  shortcutMatches,
  terminalLinkModifierMatches,
} from "../shortcutPreferences";
import {
  ClipboardAddon,
  type ClipboardSelectionType,
} from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import type { ITheme } from "@xterm/xterm";
import { Terminal } from "@xterm/xterm";
import {
  Columns2,
  Keyboard,
  Maximize2,
  Minimize2,
  Rows2,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "@xterm/xterm/css/xterm.css";
import { bridge, type ConnectionClient } from "../api";
import { mobileTerminalShortcutExecution } from "../mobileTerminalShortcutAction";
import {
  defaultMobileTerminalShortcutRows,
  defaultMobileTerminalSideShortcuts,
  type MobileTerminalShortcut,
  type MobileTerminalShortcutRows,
  type MobileTerminalSideShortcuts,
  mobileTerminalShortcutOption,
} from "../mobileTerminalShortcuts";
import { activePaneIdForSnapshot, paneCanClose } from "../paneJump";
import { HerdrSetupCard } from "./HerdrSetupCard";
import {
  shallowEqual,
  store,
  terminalNavigationLoading,
  useStoreSelector,
} from "../store";
import {
  copyTextFromUserGesture,
  createTerminalClipboardProvider,
  decodeTerminalClipboard,
} from "../terminalClipboard";
import {
  clearTerminalComposerDrafts,
  terminalComposerCloseWarning,
  terminalComposerDraftKey,
  terminalComposerDraftPaneIds,
  terminalComposerRequest,
} from "../terminalComposer";
import {
  registerTerminalConnectionDisposer,
  type TerminalConnectionIdentity,
  terminalConnectionKey,
  terminalPushMatches,
} from "../terminalConnection";
import {
  type ResolvedTerminalFile,
  TerminalFileResolutionCache,
} from "../terminalFileLinks";
import {
  TerminalEndpointPresentation,
  terminalMouseUsesSelection,
} from "../terminalEndpointPresentation";
import {
  terminalFocusBlockedByOverlay,
  terminalPointerShouldBlurInput,
  terminalPointerShouldFocusInput,
  terminalTouchShouldFocusInput,
} from "../terminalFocus";
import { uploadTerminalImage } from "../terminalImageUpload";
import {
  isTerminalImeCommittedInputType,
  TerminalImeCommitGuard,
  TerminalImeFallbackTracker,
  TerminalImeKeyEventTracker,
  TerminalImeTextareaFallbackTracker,
  terminalImeEventTime,
  terminalImeFallbackText,
  terminalImeTextareaDelta,
} from "../terminalIme";
import { terminalShortcutSequence } from "../terminalKeys";
import { TerminalHistorySelection } from "../terminalHistorySelection";
import { registerTerminalLinkProvider } from "../terminalLinkProvider";
import {
  findTerminalHttpLinks,
  sanitizeTerminalHttpUrl,
} from "../terminalLinks";
import {
  createTerminalPasteRunner,
  type TerminalPasteTextareaSnapshot,
  terminalPasteInputText,
  terminalPasteRequest,
} from "../terminalPaste";
import {
  readTerminalRecoveryReloadAt,
  shouldArmTerminalRecoveryResume,
  shouldReloadTerminalAfterResume,
  writeTerminalRecoveryReloadAt,
} from "../terminalRecovery";
import {
  rememberTerminalRelayViewport,
  TerminalAttachFrameWatchdog,
  TerminalResizeSync,
  terminalAttachWatchdogMs,
  terminalEndpointViewportSize,
  terminalRelayViewportSize,
} from "../terminalResize";
import { terminalPageScroll, terminalWheelScroll } from "../terminalScroll";
import { TerminalSelectionDragGuard } from "../terminalSelectionGuard";
import { applyTerminalTheme } from "../terminalThemes";
import { paneHasAgentHistory } from "./agentSession";
import { ConfirmDialog, MessageDialog } from "./ModalDialogs";
import { TerminalComposer } from "./TerminalComposer";
import "./TerminalView.css";

function focusTerminalEndpoint(
  client: ConnectionClient,
  terminalId: string | undefined,
) {
  if (
    !terminalId ||
    !client.isCurrent() ||
    !store
      .get()
      .endpointAvailability[terminalId]?.methods.includes("pane.focus")
  )
    return;
  void client
    .call("terminal.focus", { terminal_id: terminalId })
    .catch(() => null);
}

const SYSTEM_CLIPBOARD = "c" as ClipboardSelectionType;

function b64toBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function b64toText(b64: string): string | null {
  try {
    return new TextDecoder().decode(b64toBytes(b64));
  } catch {
    return null;
  }
}
function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function sendBytes(
  client: ConnectionClient,
  bytes: Uint8Array,
  terminalId: string,
) {
  return client.call("terminal.input", {
    terminal_id: terminalId,
    data: bytesToB64(bytes),
  });
}

const FONT_FAMILY =
  'SFMono-Regular, Menlo, Monaco, "0xProto Nerd Font Mono", "JetBrainsMonoNL Nerd Font", "MesloLGS NF", "Hack Nerd Font", "FiraCode Nerd Font", Consolas, "Liberation Mono", "Courier New", "Noto Sans Mono CJK SC", "Source Han Mono SC", "Sarasa Mono SC", "Herdr Nerd Symbols", monospace';
const LINK_BLUE = "\x1b[94m";
const RESET_FOREGROUND = "\x1b[39m";
const ANSI_SEQUENCE_RE =
  /\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
const CLIPBOARD_READ_TIMEOUT_MS = 2000;
const TERMINAL_EVICTION_WINDOW_MS = 60_000;
const TERMINAL_EVICTION_MAX_RETRIES = 3;
const TERMINAL_TOUCH_TAP_SLOP_PX = 8;

function terminalDensity(uiScale: number) {
  const compact = typeof window !== "undefined" && isMobileLayout();
  return terminalFontOptions(compact, uiScale);
}

function isApplePlatform() {
  return detectShortcutPlatform() === "mac";
}

function shouldAvoidVirtualKeyboard() {
  return isMobileLayout() || window.matchMedia("(pointer: coarse)").matches;
}

function terminalCellAtPoint(term: Terminal, clientX: number, clientY: number) {
  const element = term.element;
  if (!element || term.cols <= 0 || term.rows <= 0) return {};
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
  const paddingRight = Number.parseFloat(style.paddingRight) || 0;
  const paddingTop = Number.parseFloat(style.paddingTop) || 0;
  const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
  const width = rect.width - paddingLeft - paddingRight;
  const height = rect.height - paddingTop - paddingBottom;
  if (width <= 0 || height <= 0) return {};

  const x = clientX - rect.left - paddingLeft;
  const y = clientY - rect.top - paddingTop;
  const column = Math.max(
    0,
    Math.min(term.cols - 1, Math.floor(x / (width / term.cols))),
  );
  const row = Math.max(
    0,
    Math.min(term.rows - 1, Math.floor(y / (height / term.rows))),
  );
  return { column, row };
}

function terminalCellAt(term: Terminal, e: WheelEvent) {
  return terminalCellAtPoint(term, e.clientX, e.clientY);
}

function colorHttpLinks(input: string): string {
  let output = "";
  let index = 0;

  for (const match of input.matchAll(ANSI_SEQUENCE_RE)) {
    const start = match.index ?? 0;
    if (start > index)
      output += colorHttpLinksInText(input.slice(index, start));
    output += match[0];
    index = start + match[0].length;
  }

  if (index < input.length) output += colorHttpLinksInText(input.slice(index));
  return output;
}

function colorHttpLinksInText(text: string): string {
  const links = findTerminalHttpLinks(text);
  if (links.length === 0) return text;
  let output = "";
  let offset = 0;
  for (const link of links) {
    output += text.slice(offset, link.start);
    output += `${LINK_BLUE}${link.url}${RESET_FOREGROUND}`;
    offset = link.end;
  }
  return output + text.slice(offset);
}

function isEditableElement(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function isSafariBrowser() {
  return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
}

function trimCopiedLinePadding(text: string) {
  return text.replace(/[ \t]+(?=\r?\n|$)/g, "");
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(errorMessage));
    }, timeoutMs);

    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        window.clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export type TerminalWorkspaceFileRequest = {
  connectionId: string;
  connectionGeneration: number;
  workspaceId: string;
  paneId?: string;
  path: string;
};

export function TerminalView({
  paneId,
  terminalTheme,
  uiScale,
  showMobileKeys = true,
  mobileShortcuts = defaultMobileTerminalShortcutRows(),
  mobileSideShortcuts = defaultMobileTerminalSideShortcuts(),
  composerOpen: controlledComposerOpen,
  onComposerOpenChange,
  agentHistoryOpen: controlledAgentHistoryOpen,
  onAgentHistoryOpenChange,
  onOpenWorkspaceFile,
}: {
  paneId?: string;
  terminalTheme: ITheme;
  uiScale: number;
  showMobileKeys?: boolean;
  mobileShortcuts?: MobileTerminalShortcutRows;
  mobileSideShortcuts?: MobileTerminalSideShortcuts;
  composerOpen?: boolean;
  onComposerOpenChange?: (open: boolean) => void;
  agentHistoryOpen?: boolean;
  onAgentHistoryOpenChange?: (open: boolean) => void;
  onOpenWorkspaceFile?: (request: TerminalWorkspaceFileRequest) => void;
}) {
  const s = useStoreSelector(
    (state) => ({
      activeConnectionId: state.activeConnectionId,
      defaultConnectionId: state.defaultConnectionId,
      connectionGeneration: state.connectionGeneration,
      connectionPaused: state.connectionPaused,
      connections: state.connections,
      layout: state.layout,
      panes: state.panes,
      selectedPaneId: state.selectedPaneId,
      status: state.status,
      terminalAttachEpoch: state.terminalAttachEpoch,
      endpointAvailability: state.endpointAvailability,
      navigationLoading: terminalNavigationLoading(state),
      error: state.error,
    }),
    shallowEqual,
  );
  const terminalIdentity = useMemo<TerminalConnectionIdentity>(
    () => ({
      connectionId: s.activeConnectionId,
      generation: s.connectionGeneration,
    }),
    [s.activeConnectionId, s.connectionGeneration],
  );
  const serverRuntimeGeneration =
    s.connections.find(
      (connection) => connection.id === terminalIdentity.connectionId,
    )?.generation ?? null;
  const connectionClient = useMemo(
    () =>
      bridge.connection(terminalIdentity.connectionId, serverRuntimeGeneration),
    [serverRuntimeGeneration, terminalIdentity],
  );
  const connectionScopeKey = terminalConnectionKey(terminalIdentity);
  const terminalFileResolutionCache = useMemo(
    () =>
      new TerminalFileResolutionCache(
        async (_scopeId, workspaceId, candidates) => {
          const result = (await connectionClient.call("file.resolve", {
            workspace_id: workspaceId,
            paths: candidates,
          })) as { files?: unknown };
          if (!connectionClient.isCurrent() || !Array.isArray(result?.files)) {
            return [];
          }
          return result.files.flatMap((value): ResolvedTerminalFile[] => {
            if (!value || typeof value !== "object") return [];
            const file = value as Record<string, unknown>;
            return typeof file.candidate === "string" &&
              typeof file.path === "string"
              ? [{ candidate: file.candidate, path: file.path }]
              : [];
          });
        },
        { isScopeCurrent: () => connectionClient.isCurrent() },
      ),
    [connectionClient],
  );
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [reviewSelection, setReviewSelection] = useState<
    | (AnnotationComposerDraft & {
        paneId: string;
        workspaceId: string;
        tabId: string;
        terminalId: string;
        composing: boolean;
      })
    | null
  >(null);
  const [uploadError, setUploadError] = useState("");
  const [terminalLoading, setTerminalLoading] = useState(
    s.status === "connected" && !s.connectionPaused,
  );
  const [terminalAttachError, setTerminalAttachError] = useState("");
  const [pasteLoading, setPasteLoading] = useState(false);
  const [attachRetry, setAttachRetry] = useState(0);
  const [mobileKeysOpen, setMobileKeysOpen] = useState(false);
  const [localComposerOpen, setLocalComposerOpen] = useState(false);
  const [closePaneRequested, setClosePaneRequested] = useState(false);
  const [localAgentHistoryOpen, setLocalAgentHistoryOpen] = useState(false);
  const containerRef = useCallback(
    (el: HTMLDivElement | null) => setContainer(el),
    [],
  );
  const termRef = useRef<Terminal | null>(null);
  const endpointPresentationRef = useRef<TerminalEndpointPresentation | null>(
    null,
  );
  // Mirrors termRef as state so the attach effect re-runs when the xterm
  // instance is recreated: the init effect's cleanup resets the attach refs,
  // and without an instance change in the deps the attach effect would not
  // fire again, leaving the recreated terminal detached and blank.
  const [termInstance, setTermInstance] = useState<Terminal | null>(null);
  // Theme changes update xterm in place without recreating the terminal.
  const terminalThemeRef = useRef(terminalTheme);
  const uiScaleRef = useRef(uiScale);
  const fitRef = useRef<FitAddon | null>(null);
  const attachedRef = useRef<string | null>(null);
  const attachingRef = useRef<string | null>(null);
  const desiredTerminalRef = useRef<string | null>(null);
  const renderedTerminalRef = useRef<string | null>(null);
  const attachEvictionsRef = useRef<number[]>([]);
  const resizeSyncRef = useRef<TerminalResizeSync | null>(null);
  const terminalAttachEpochRef = useRef(s.terminalAttachEpoch);
  const attachWatchdogRef = useRef<TerminalAttachFrameWatchdog | null>(null);
  if (attachWatchdogRef.current === null) {
    attachWatchdogRef.current = new TerminalAttachFrameWatchdog();
  }
  const attachTimeoutCountRef = useRef(0);
  const attachTimeoutTerminalRef = useRef<string | null>(null);
  // Timestamp of the last foreground resume; gates the last-resort reload.
  const resumedAtRef = useRef<number | null>(null);
  // When the page last became hidden; measures the suspension length.
  const hiddenAtRef = useRef<number | null>(null);
  const selectedPaneInLayout =
    s.selectedPaneId &&
    s.layout?.panes.some((p) => p.pane_id === s.selectedPaneId)
      ? s.selectedPaneId
      : null;
  const pane = paneId
    ? (s.panes.find((p) => p.pane_id === paneId) ?? null)
    : (s.panes.find((p) => p.pane_id === selectedPaneInLayout) ??
      s.panes.find((p) => p.pane_id === s.layout?.focused_pane_id) ??
      null);
  useEffect(() => {
    setReviewSelection(null);
  }, [
    connectionClient,
    pane?.pane_id,
    pane?.terminal_id,
    pane?.workspace_id,
    pane?.tab_id,
    s.layout?.tab_id,
  ]);
  const activePaneId =
    selectedPaneInLayout ?? s.layout?.focused_pane_id ?? null;
  const isActivePane = !!pane && (!paneId || pane.pane_id === activePaneId);
  const canShowAgentHistory = isActivePane && paneHasAgentHistory(pane);
  const canClosePane = !!pane && paneCanClose(s.panes, pane.pane_id);
  const paneZoomed =
    s.layout?.zoomed === true && s.layout.focused_pane_id === pane?.pane_id;
  const composerOpen = controlledComposerOpen ?? localComposerOpen;
  const composerOpenRef = useRef(composerOpen);
  composerOpenRef.current = composerOpen;
  useLayoutEffect(() => {
    if (!termInstance) return;
    termInstance.options.disableStdin = composerOpen;
    if (composerOpen) termInstance.blur();
  }, [composerOpen, termInstance]);
  const setComposerOpen = useCallback(
    (open: boolean) => {
      if (controlledComposerOpen === undefined) setLocalComposerOpen(open);
      onComposerOpenChange?.(open);
    },
    [controlledComposerOpen, onComposerOpenChange],
  );
  const agentHistoryOpen = controlledAgentHistoryOpen ?? localAgentHistoryOpen;
  const setAgentHistoryOpen = useCallback(
    (open: boolean) => {
      if (controlledAgentHistoryOpen === undefined) {
        setLocalAgentHistoryOpen(open);
      }
      onAgentHistoryOpenChange?.(open);
    },
    [controlledAgentHistoryOpen, onAgentHistoryOpenChange],
  );
  const isActivePaneRef = useRef(isActivePane);
  const previewWorkspaceIdRef = useRef(pane?.workspace_id);
  const paneTerminalIdRef = useRef(pane?.terminal_id);
  const paneIdRef = useRef(pane?.pane_id);
  const paneTabIdRef = useRef(pane?.tab_id);
  const paneLayoutRef = useRef(s.layout);
  useLayoutEffect(() => {
    isActivePaneRef.current = isActivePane;
  }, [isActivePane]);
  useLayoutEffect(() => {
    previewWorkspaceIdRef.current = pane?.workspace_id;
  }, [pane?.workspace_id]);
  useLayoutEffect(() => {
    paneTerminalIdRef.current = pane?.terminal_id;
  }, [pane?.terminal_id]);
  useLayoutEffect(() => {
    paneIdRef.current = pane?.pane_id;
  }, [pane?.pane_id]);
  useLayoutEffect(() => {
    paneTabIdRef.current = pane?.tab_id;
  }, [pane?.tab_id]);
  useLayoutEffect(() => {
    paneLayoutRef.current = s.layout;
  }, [s.layout]);
  const focusTerminalSoon = useCallback(() => {
    if (!isActivePaneRef.current || composerOpenRef.current) return;
    if (shouldAvoidVirtualKeyboard()) return;
    requestAnimationFrame(() => {
      window.setTimeout(() => {
        if (
          !connectionClient.isCurrent() ||
          !isActivePaneRef.current ||
          composerOpenRef.current
        )
          return;
        const term = termRef.current;
        const active = document.activeElement;
        const activeElement = active instanceof HTMLElement ? active : null;
        const activeIsTerminalInput = !!activeElement?.closest(".xterm");
        if (!term || (isEditableElement(active) && !activeIsTerminalInput))
          return;
        // Streaming frames must not steal focus from an open popover, dialog,
        // or menu: moving focus out of an overlay dismisses it.
        if (terminalFocusBlockedByOverlay(activeElement, document)) return;
        term.focus();
      }, 0);
    });
  }, [connectionClient]);
  const focusEndpoint = useCallback(() => {
    focusTerminalEndpoint(connectionClient, paneTerminalIdRef.current);
  }, [connectionClient]);
  useEffect(() => {
    if (isActivePane) focusEndpoint();
  }, [focusEndpoint, isActivePane, pane?.terminal_id]);
  useEffect(() => {
    if (!container) return;
    // Clicking the already-selected pane must also reclaim its cursor after
    // another client has changed the shared same-tab focus.
    container.addEventListener("pointerdown", focusEndpoint);
    return () => container.removeEventListener("pointerdown", focusEndpoint);
  }, [container, focusEndpoint]);
  // Fits the xterm to its container, unless the container is hidden or
  // unmounted (e.g. the diff/files view covers it with display:none). Fitting
  // a hidden container would collapse the terminal to a 2x1 minimum and leak a
  // bogus resize to the server, so callers must treat null as "keep the last
  // known size everywhere".
  const fitVisibleTerminal = useCallback(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return null;
    if (!container || !container.isConnected) return null;
    if (container.clientWidth === 0 || container.clientHeight === 0) {
      return null;
    }
    try {
      fit.fit();
    } catch {
      // A hidden or detaching terminal can reject a transient fit.
    }
    return { cols: term.cols, rows: term.rows };
  }, [container]);
  const relayViewportFor = useCallback(
    (size: { cols: number; rows: number }) => {
      if (!isActivePaneRef.current) return null;
      const relaySize = terminalRelayViewportSize(
        size,
        paneLayoutRef.current,
        paneIdRef.current,
      );
      const tabId = paneTabIdRef.current;
      if (tabId) {
        rememberTerminalRelayViewport(
          terminalIdentity.connectionId,
          terminalIdentity.generation,
          tabId,
          relaySize,
        );
      }
      return relaySize;
    },
    [terminalIdentity],
  );
  useEffect(() => {
    if (isActivePane) focusTerminalSoon();
  }, [focusTerminalSoon, isActivePane]);
  useEffect(() => {
    if (!canShowAgentHistory && agentHistoryOpen) setAgentHistoryOpen(false);
  }, [agentHistoryOpen, canShowAgentHistory, setAgentHistoryOpen]);
  useEffect(() => {
    if (!isActivePane || !canShowAgentHistory) return;
    const onKey = (e: KeyboardEvent) => {
      if (
        e.defaultPrevented ||
        document.querySelector(".modal-backdrop, .command-popover")
      )
        return;
      const isHistoryShortcut = shortcutMatches(e, "terminal.history");
      if (!isHistoryShortcut) return;
      if (
        isEditableElement(e.target) &&
        !(e.target as HTMLElement).closest(".xterm")
      ) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      setAgentHistoryOpen(!agentHistoryOpen);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [
    agentHistoryOpen,
    canShowAgentHistory,
    isActivePane,
    setAgentHistoryOpen,
  ]);

  const blurTerminalInput = () => {
    termRef.current?.textarea?.blur();
  };

  const sendControl = (bytes: number[]) => {
    if (shouldAvoidVirtualKeyboard()) blurTerminalInput();
    const terminalId = desiredTerminalRef.current ?? pane?.terminal_id;
    if (!terminalId) return;
    sendBytes(connectionClient, new Uint8Array(bytes), terminalId).catch(
      () => {},
    );
  };

  const scrollPage = useCallback(
    (direction: "up" | "down", amount: "full" | "half" = "full") => {
      const term = termRef.current;
      if (!term) return;
      if (shouldAvoidVirtualKeyboard()) blurTerminalInput();
      const targetTerminalId =
        desiredTerminalRef.current ?? paneTerminalIdRef.current;
      if (
        !targetTerminalId ||
        (amount === "half" && store.terminalScrollReason(targetTerminalId))
      )
        return;
      connectionClient
        .call("terminal.scroll", {
          terminal_id: targetTerminalId,
          ...terminalPageScroll(direction, term.rows, amount),
        })
        .catch(() => {});
    },
    [connectionClient],
  );
  const preventShortcutFocus = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    if (shouldAvoidVirtualKeyboard()) blurTerminalInput();
    e.currentTarget.blur();
  };
  const preventPaneActionFocus = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.currentTarget.blur();
  };

  const openPathInInspector = useCallback(
    (path: string) => {
      if (!connectionClient.isCurrent()) return;
      const workspaceId = previewWorkspaceIdRef.current;
      if (!workspaceId) {
        store.notify({
          kind: "error",
          message: "Cannot browse file",
          detail: "No active workspace is available.",
        });
        return;
      }
      onOpenWorkspaceFile?.({
        connectionId: terminalIdentity.connectionId,
        connectionGeneration: terminalIdentity.generation,
        workspaceId,
        paneId: paneIdRef.current ?? undefined,
        path,
      });
    },
    [connectionClient, onOpenWorkspaceFile, terminalIdentity],
  );

  const resolveTerminalFilePaths = useCallback(
    async (paths: string[]) => {
      const workspaceId = previewWorkspaceIdRef.current;
      if (!workspaceId) return new Map<string, string>();
      const resolved = await terminalFileResolutionCache.resolve(
        connectionScopeKey,
        workspaceId,
        paths,
      );
      return connectionClient.isCurrent() &&
        previewWorkspaceIdRef.current === workspaceId
        ? resolved
        : new Map<string, string>();
    },
    [connectionClient, connectionScopeKey, terminalFileResolutionCache],
  );

  // init xterm once the container element is available
  useEffect(() => {
    if (!container) return;
    let terminalEffectDisposed = false;
    const term = new Terminal({
      cursorBlink: true,
      disableStdin: composerOpenRef.current,
      fontFamily: FONT_FAMILY,
      ...terminalDensity(uiScaleRef.current),
      theme: terminalThemeRef.current,
      allowProposedApi: true,
      linkHandler: {
        activate(event, text) {
          event.preventDefault();
          if (!terminalLinkModifierMatches(event)) return;
          const url = sanitizeTerminalHttpUrl(text);
          if (url) window.open(url, "_blank", "noopener,noreferrer");
        },
      },
      scrollbar: { showScrollbar: false },
      scrollback: 2000,
    });
    const fit = new FitAddon();
    const clipboardProvider = createTerminalClipboardProvider({
      onWriteStart() {
        if (terminalEffectDisposed || !connectionClient.isCurrent()) return;
        if (store.get().notice?.actionClipboardText !== undefined) {
          store.clearNotice();
        }
      },
      onWriteError(error, text) {
        if (terminalEffectDisposed || !connectionClient.isCurrent()) return;
        store.notify({
          kind: "error",
          message: "Browser blocked terminal copy",
          detail: text
            ? `${error.message}. Use Copy to approve this clipboard write.`
            : error.message,
          ...(text ? { actionLabel: "Copy", actionClipboardText: text } : {}),
          autoDismissMs: 60_000,
        });
      },
    });
    const clipboard = new ClipboardAddon(undefined, clipboardProvider);
    term.loadAddon(clipboard);
    term.loadAddon(new UnicodeGraphemesAddon());
    term.loadAddon(fit);
    term.open(container);
    if (isApplePlatform()) {
      term.element?.classList.add("xterm-apple-row-spacing-fix");
    }
    try {
      fit.fit();
    } catch {
      // ResizeObserver will retry after the terminal becomes measurable.
    }
    termRef.current = term;
    setTermInstance(term);
    fitRef.current = fit;
    const linkProvider = registerTerminalLinkProvider(
      term,
      openPathInInspector,
      resolveTerminalFilePaths,
      () => endpointPresentationRef.current?.displayedFrame != null,
    );

    const imeFallback = new TerminalImeFallbackTracker();
    const imeKeyEvent = new TerminalImeKeyEventTracker();
    const imeTextareaFallback = new TerminalImeTextareaFallbackTracker();
    const imeCommitGuard = new TerminalImeCommitGuard();
    const readTerminalTextareaSnapshot = (): TerminalPasteTextareaSnapshot => {
      const textarea = term.textarea;
      const value = textarea?.value ?? "";
      const selectionStart = textarea?.selectionStart ?? value.length;
      return {
        value,
        selectionStart,
        selectionEnd: textarea?.selectionEnd ?? selectionStart,
      };
    };
    let imeTextareaTimer: number | null = null;
    let terminalCompositionActive = false;
    let compositionSettleTimer: number | null = null;
    let compositionStartTextareaValue = "";
    let nativePasteFallbackTimer: number | null = null;
    let pasteTextareaClearTimer: number | null = null;
    let pasteTextareaBeforeInput: TerminalPasteTextareaSnapshot | null = null;
    let pastePaneIdBeforeInput: string | null = null;
    let lastTerminalTextareaSnapshot = readTerminalTextareaSnapshot();
    let replayingSelection = false;
    term.onData((data) => {
      // Replaying a delayed local selection must never synthesize pane input.
      if (composerOpenRef.current || replayingSelection) return;
      if (historySelection.active) {
        historySelection.reset();
        term.clearSelection();
        endpointPresentation.cancelSelection();
      }
      const unsuppressedData = imeTextareaFallback.recordXtermData(data);
      if (!unsuppressedData) return;
      const dataAt = performance.now();
      if (!imeCommitGuard.filterXtermData(unsuppressedData, dataAt)) {
        return;
      }
      const shouldSend = imeFallback.recordXtermData(unsuppressedData, dataAt);
      if (!shouldSend) return;
      const terminalId = desiredTerminalRef.current;
      if (!terminalId) return;
      imeKeyEvent.recordXtermData(unsuppressedData);
      const bytes = new TextEncoder().encode(unsuppressedData);
      sendBytes(connectionClient, bytes, terminalId).catch(() => {});
    });

    const endpointPresentation: TerminalEndpointPresentation =
      new TerminalEndpointPresentation(
        () => term.hasSelection() || historySelection.active,
        (text, parsed) => term.write(colorHttpLinks(text), parsed),
        () => ({ cols: term.cols, rows: term.rows }),
        {
          accepts: (frame) => historySelection.accepts(frame),
          presented: (frame) => historySelection.presented(frame),
          reset: () => historySelection.reset(),
        },
      );
    const historySelection: TerminalHistorySelection =
      new TerminalHistorySelection(term, {
        frame: () => endpointPresentation.displayedFrame,
        scroll: (direction, lines) =>
          connectionClient.call("terminal.scroll", {
            terminal_id: desiredTerminalRef.current,
            direction,
            lines,
            source: "history",
          }),
        changed: (message) =>
          store.notify({ kind: "info", message, autoDismissMs: 8000 }),
      });
    endpointPresentationRef.current = endpointPresentation;
    const selectionChange = term.onSelectionChange(() => {
      if (
        !endpointPresentation.selectionDrag &&
        !endpointPresentation.writePending &&
        !term.hasSelection()
      )
        historySelection.reset();
      endpointPresentation.flush();
    });
    const selectionResize = term.onResize(() => {
      historySelection.reset();
      if (endpointPresentation.selectionDrag) onSelectionBlur();
      term.clearSelection();
      endpointPresentation.cancelSelection();
    });
    const off = bridge.onTerminal((t) => {
      // A mount owns exactly one connection generation. Drop frames from an
      // inactive connection or a prior terminal attach before touching xterm.
      if (
        !terminalPushMatches(
          terminalIdentity,
          connectionClient,
          desiredTerminalRef.current,
          t,
        )
      ) {
        return;
      }
      const text = b64toText(t.bytes);
      if (text === null) return;
      attachWatchdogRef.current?.markFrame();
      attachTimeoutCountRef.current = 0;
      setTerminalLoading(false);
      setTerminalAttachError("");
      if (typeof t.mouse_reporting === "boolean") {
        term.options.macOptionClickForcesSelection = true;
        endpointPresentation.update(
          text,
          t.mouse_reporting,
          {
            cols: t.width,
            rows: t.height,
          },
          t.history,
        );
      } else {
        term.write(colorHttpLinks(text));
      }
      focusTerminalSoon();
    });
    const offClipboard = bridge.onTerminalClipboard((clipboard) => {
      if (
        !terminalPushMatches(
          terminalIdentity,
          connectionClient,
          desiredTerminalRef.current,
          clipboard,
        )
      ) {
        return;
      }
      const text = decodeTerminalClipboard(clipboard.data);
      if (text !== null && connectionClient.isCurrent()) {
        clipboardProvider.writeText(SYSTEM_CLIPBOARD, text);
      }
    });
    const offClosed = bridge.onTerminalClosed((closed) => {
      if (
        !terminalPushMatches(
          terminalIdentity,
          connectionClient,
          desiredTerminalRef.current,
          closed,
        )
      ) {
        return;
      }
      store.setTerminalEndpoint(connectionClient, closed.terminal_id, null);
      // Herdr closes the direct attach when another client takes the
      // terminal over (or its stream dies). Re-attach, but bound takeover
      // wars between two clients so they cannot evict each other forever.
      endpointPresentation.reset();
      attachedRef.current = null;
      attachingRef.current = null;
      const now = Date.now();
      attachEvictionsRef.current = attachEvictionsRef.current.filter(
        (at) => now - at < TERMINAL_EVICTION_WINDOW_MS,
      );
      attachEvictionsRef.current.push(now);
      if (attachEvictionsRef.current.length > TERMINAL_EVICTION_MAX_RETRIES) {
        attachWatchdogRef.current?.cancel();
        setTerminalLoading(false);
        setTerminalAttachError(
          typeof closed.reason === "string" &&
            closed.reason.includes("taken over")
            ? "Terminal stream was taken over by another Roamgate client"
            : "Terminal stream closed by the server",
        );
        return;
      }
      setAttachRetry((value) => value + 1);
    });
    let disposedByConnectionLease = false;
    const unregisterConnectionDisposer = registerTerminalConnectionDisposer(
      terminalIdentity,
      (sendRemoteDetach) => {
        disposedByConnectionLease = true;
        const terminalId = attachedRef.current ?? desiredTerminalRef.current;
        if (sendRemoteDetach && terminalId && connectionClient.isCurrent()) {
          void connectionClient
            .call("terminal.detach", { terminal_id: terminalId })
            .catch(() => null);
        }
      },
    );

    const resizeSync = new TerminalResizeSync((size) => {
      const terminalId = attachedRef.current;
      if (!terminalId) return false;
      const relaySize = relayViewportFor(size);
      connectionClient
        .call("terminal.resize", {
          terminal_id: terminalId,
          cols: size.cols,
          rows: size.rows,
          relay_active: relaySize !== null,
          ...(relaySize
            ? { relay_cols: relaySize.cols, relay_rows: relaySize.rows }
            : {}),
        })
        .catch(() => {
          if (
            connectionClient.isCurrent() &&
            attachedRef.current === terminalId
          ) {
            resizeSync.markFailed(size);
          }
        });
      return true;
    });
    resizeSyncRef.current = resizeSync;

    const applyDensity = () => {
      term.options = terminalDensity(uiScaleRef.current);
      const size = fitVisibleTerminal();
      if (size) resizeSync.sendNow(size);
    };
    window.addEventListener(LAYOUT_CHANGE_EVENT, applyDensity);

    const ro = new ResizeObserver(() => {
      const size = fitVisibleTerminal();
      if (!size) return;
      resizeSync.schedule(size);
    });
    ro.observe(container);

    const sendText = (text: string) => {
      if (composerOpenRef.current) return;
      const terminalId = desiredTerminalRef.current;
      if (!terminalId) return;
      const bytes = new TextEncoder().encode(text);
      sendBytes(connectionClient, bytes, terminalId).catch(() => {});
    };
    const pasteText = async (
      text: string,
      destinationPaneId: string | null = paneIdRef.current ?? null,
    ) => {
      if (!text || composerOpenRef.current) return;
      imeCommitGuard.beginIndependentInput();
      if (destinationPaneId) {
        const request = terminalPasteRequest(destinationPaneId, text);
        await connectionClient.call(request.method, request.params);
        return;
      }
      const activeTerm = termRef.current;
      if (activeTerm) {
        activeTerm.paste(text);
        return;
      }
      sendText(text);
    };
    const sendMissingImeText = (
      text: string,
      eventTime: number,
      observedAt: number,
    ) => {
      if (imeCommitGuard.consumeSuppressedDuplicate(text, observedAt)) return;
      const shouldSend = imeFallback.recordInput(text, eventTime, observedAt);
      if (!shouldSend) return;
      sendText(text);
    };
    const cancelImeTextareaFallback = () => {
      if (imeTextareaTimer !== null) {
        window.clearTimeout(imeTextareaTimer);
        imeTextareaTimer = null;
      }
      imeTextareaFallback.cancel();
      imeCommitGuard.completeRecoveryCycle();
    };
    const cancelCompositionSettle = () => {
      if (compositionSettleTimer === null) return;
      window.clearTimeout(compositionSettleTimer);
      compositionSettleTimer = null;
    };
    const cancelNativePasteFallback = () => {
      if (nativePasteFallbackTimer === null) return;
      window.clearTimeout(nativePasteFallbackTimer);
      nativePasteFallbackTimer = null;
    };
    const cancelPasteTextareaClear = () => {
      if (pasteTextareaClearTimer === null) return;
      window.clearTimeout(pasteTextareaClearTimer);
      pasteTextareaClearTimer = null;
    };
    const { run: runPasteOperation, dispose: disposePasteOperations } =
      createTerminalPasteRunner(
        () => connectionClient.isCurrent(),
        setPasteLoading,
      );
    const pasteImage = async (blob: Blob, destinationPaneId: string | null) => {
      const file =
        blob instanceof File
          ? blob
          : new File([blob], "clipboard-image.png", {
              type: blob.type || "image/png",
            });
      const path = await uploadTerminalImage(connectionClient, file);
      await pasteText(path, destinationPaneId);
    };
    let clipboardPasteInFlight = false;
    const pasteFromBrowserClipboard = async () => {
      if (composerOpenRef.current || clipboardPasteInFlight) return;
      clipboardPasteInFlight = true;
      const destinationPaneId = paneIdRef.current ?? null;
      try {
        await runPasteOperation(async () => {
          if (!navigator.clipboard) {
            throw new Error("browser clipboard API is unavailable");
          }
          if (navigator.clipboard.read) {
            const items = await withTimeout(
              navigator.clipboard.read(),
              CLIPBOARD_READ_TIMEOUT_MS,
              "Clipboard read timed out",
            );
            for (const item of items) {
              const imageType = item.types.find((type) =>
                type.startsWith("image/"),
              );
              if (imageType) {
                const blob = await withTimeout(
                  item.getType(imageType),
                  CLIPBOARD_READ_TIMEOUT_MS,
                  "Clipboard image read timed out",
                );
                await pasteImage(blob, destinationPaneId);
                return;
              }
            }
            for (const item of items) {
              if (item.types.includes("text/plain")) {
                const blob = await withTimeout(
                  item.getType("text/plain"),
                  CLIPBOARD_READ_TIMEOUT_MS,
                  "Clipboard text read timed out",
                );
                const text = await withTimeout(
                  blob.text(),
                  CLIPBOARD_READ_TIMEOUT_MS,
                  "Clipboard text read timed out",
                );
                await pasteText(text, destinationPaneId);
                return;
              }
            }
            return;
          }
          const text = await withTimeout(
            navigator.clipboard.readText(),
            CLIPBOARD_READ_TIMEOUT_MS,
            "Clipboard text read timed out",
          );
          await pasteText(text, destinationPaneId);
        });
      } finally {
        clipboardPasteInFlight = false;
      }
    };
    const applePlatform = isApplePlatform();
    const appleTouchPlatform = applePlatform && navigator.maxTouchPoints > 0;
    const shouldRecoverCommittedImeInput = (input: InputEvent) =>
      applePlatform &&
      !terminalCompositionActive &&
      isTerminalImeCommittedInputType(input.inputType);

    term.attachCustomKeyEventHandler((e) => {
      if (composerOpenRef.current) {
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
      // xterm's capture listener runs before our textarea keydown listener.
      // Its custom handler is the boundary before any synchronous onData.
      if (e.type === "keydown") {
        imeCommitGuard.beginIndependentInput();
        if (applePlatform) imeKeyEvent.begin();
      }
      if (e.type === "keydown" && e.keyCode !== 229) {
        imeTextareaFallback.cancelPending();
      }
      const sequence = terminalShortcutSequence(
        e,
        getShortcutSnapshot().preset.bindings,
      );
      if (sequence) {
        e.preventDefault();
        e.stopPropagation();
        sendText(sequence);
        return false;
      }
      if (e.type === "keydown" && shortcutMatches(e, "terminal.copy")) {
        e.preventDefault();
        e.stopPropagation();
        const text = trimCopiedLinePadding(term.getSelection());
        if (text) {
          void copyTextFromUserGesture(text).catch((error) => {
            setUploadError(`Copy failed: ${(error as Error).message}`);
          });
        }
        return false;
      }
      if (e.type === "keydown" && shortcutMatches(e, "terminal.paste")) {
        // Native paste events carry clipboard payloads even on insecure LAN URLs.
        // Keep the platform's native gesture; custom combinations use the API.
        const nativePaste =
          !e.altKey &&
          !e.shiftKey &&
          (e.key.toLowerCase() === "v" || e.code === "KeyV") &&
          (applePlatform ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);
        if (nativePaste) return false;
        e.preventDefault();
        e.stopPropagation();
        pasteFromBrowserClipboard().catch((err) => {
          setUploadError(`Paste failed: ${(err as Error).message}`);
        });
        return false;
      }
      if (e.type === "keydown") {
        for (const [id, direction, amount] of [
          ["terminal.pageUp", "up", "full"],
          ["terminal.pageDown", "down", "full"],
          ["terminal.halfPageUp", "up", "half"],
          ["terminal.halfPageDown", "down", "half"],
        ] as const) {
          if (!shortcutMatches(e, id)) continue;
          e.preventDefault();
          e.stopPropagation();
          scrollPage(direction, amount);
          return false;
        }
      }

      return true;
    });

    const flushTextareaImeFallback = (
      event: Event,
      final = false,
    ): "pending" | "unhandled" | "handled" => {
      const result = imeTextareaFallback.flush(
        term.textarea?.value ?? "",
        final,
      );
      if (result.status === "handled" && result.text) {
        const observedAt = performance.now();
        const eventAt = terminalImeEventTime(event, observedAt);
        sendMissingImeText(result.text, eventAt, observedAt);
      }
      if (result.status === "handled") {
        imeCommitGuard.completeRecoveryCycle();
      }
      return result.status;
    };
    const scheduleImeTextareaFinal = (event: Event) => {
      if (imeTextareaTimer !== null) window.clearTimeout(imeTextareaTimer);
      imeTextareaTimer = window.setTimeout(() => {
        imeTextareaTimer = null;
        flushTextareaImeFallback(event, true);
        imeTextareaFallback.complete();
        imeCommitGuard.completeRecoveryCycle();
      }, 0);
    };
    const onTerminalKeyDown = (event: KeyboardEvent) => {
      lastTerminalTextareaSnapshot = readTerminalTextareaSnapshot();
      if (
        !applePlatform ||
        event.keyCode !== 229 ||
        terminalCompositionActive
      ) {
        return;
      }
      // Do not trust event.isComposing here. Third-party iOS keyboards can set
      // it without dispatching a real composition lifecycle.
      imeTextareaFallback.begin(lastTerminalTextareaSnapshot.value);
    };
    const onTerminalKeyUp = (event: KeyboardEvent) => {
      imeKeyEvent.end();
      if (!applePlatform || !imeTextareaFallback.hasPending()) return;

      // A keydown reported as 229 can have a keyup reported as 0 or as the
      // concrete key code. Flush the pending cycle regardless of keyup code.
      // If the value is not visible yet, keep it for one final task, matching
      // xterm's upstream fallback.
      flushTextareaImeFallback(event);
      scheduleImeTextareaFinal(event);
    };
    const onTerminalCompositionStart = () => {
      imeCommitGuard.beginIndependentInput();
      imeKeyEvent.end();
      cancelCompositionSettle();
      terminalCompositionActive = true;
      cancelNativePasteFallback();
      cancelPasteTextareaClear();
      pasteTextareaBeforeInput = null;
      pastePaneIdBeforeInput = null;
      lastTerminalTextareaSnapshot = readTerminalTextareaSnapshot();
      compositionStartTextareaValue = lastTerminalTextareaSnapshot.value;
      cancelImeTextareaFallback();
    };
    const onTerminalCompositionEnd = () => {
      lastTerminalTextareaSnapshot = readTerminalTextareaSnapshot();
      // Only arm the guard when the composition actually committed text. A
      // canceled composition leaves no delta, so a stray emission right
      // after Escape can never be captured as a commit.
      imeCommitGuard.endComposition(
        performance.now(),
        terminalImeTextareaDelta(
          compositionStartTextareaValue,
          lastTerminalTextareaSnapshot.value,
        ),
      );
      cancelImeTextareaFallback();
      cancelCompositionSettle();
      // This listener runs after xterm's compositionend listener. Keep fallback
      // disabled until xterm's queued composition finalization has completed.
      compositionSettleTimer = window.setTimeout(() => {
        compositionSettleTimer = null;
        terminalCompositionActive = false;
      }, 0);
    };
    const onTerminalBlur = () => {
      imeCommitGuard.beginIndependentInput();
      imeKeyEvent.end();
      cancelCompositionSettle();
      terminalCompositionActive = false;
      cancelNativePasteFallback();
      cancelPasteTextareaClear();
      pasteTextareaBeforeInput = null;
      pastePaneIdBeforeInput = null;
      lastTerminalTextareaSnapshot = readTerminalTextareaSnapshot();
      cancelImeTextareaFallback();
    };
    const onTerminalBeforeInput = (e: Event) => {
      // A new native mutation cannot recover the preceding input's duplicate.
      // Do not disarm commit capture: OS replay can also have beforeinput.
      imeCommitGuard.completeRecoveryCycle();
      const input = e as InputEvent;
      if (input.inputType === "insertFromPaste" && !input.isComposing) {
        imeCommitGuard.beginIndependentInput();
        if (!pasteTextareaBeforeInput) {
          pasteTextareaBeforeInput = readTerminalTextareaSnapshot();
          pastePaneIdBeforeInput = paneIdRef.current ?? null;
        }
        return;
      }
      if (shouldRecoverCommittedImeInput(input)) {
        // Some third-party keyboards emit beforeinput/input without a preceding
        // keydown, or emit input before keydown 229. Capture the pre-mutation
        // value here so the input/keyup path can recover arbitrary committed
        // text rather than punctuation only.
        imeTextareaFallback.begin(readTerminalTextareaSnapshot().value);
        scheduleImeTextareaFinal(input);
        return;
      }

      const fallbackText = terminalCompositionActive
        ? null
        : terminalImeFallbackText(input);
      if (!fallbackText || !input.cancelable) return;
      const observedAt = performance.now();
      const eventAt = terminalImeEventTime(input, observedAt);

      // xterm reads IME textarea mutations from a timer. Sending the committed
      // punctuation before that mutation keeps rapid input ordered and avoids
      // relying on the bridge round trip before the next key is processed.
      input.preventDefault();
      input.stopPropagation();
      sendMissingImeText(fallbackText, eventAt, observedAt);
    };
    const handleTerminalTextInput = (e: Event) => {
      const input = e as InputEvent;
      const xtermHandledCurrentInput = imeKeyEvent.consumeInput(input);
      const textareaSnapshot = readTerminalTextareaSnapshot();
      const textareaBeforeInput = lastTerminalTextareaSnapshot;
      const hadPasteSnapshot = pasteTextareaBeforeInput !== null;
      const beforePaste = pasteTextareaBeforeInput ?? textareaBeforeInput;
      const destinationPaneId = hadPasteSnapshot
        ? pastePaneIdBeforeInput
        : (paneIdRef.current ?? null);
      const pastedText = terminalPasteInputText(
        input,
        beforePaste,
        textareaSnapshot.value,
      );
      if (pastedText !== null) {
        cancelNativePasteFallback();
        cancelPasteTextareaClear();
        cancelImeTextareaFallback();
        pasteTextareaBeforeInput = null;
        pastePaneIdBeforeInput = null;
        const textarea = term.textarea;
        if (textarea) {
          // Restore xterm's keydown baseline until its queued 229 timer runs.
          // Clearing immediately makes xterm emit a spurious DEL.
          textarea.value = beforePaste.value;
          textarea.setSelectionRange(
            beforePaste.selectionStart,
            beforePaste.selectionEnd,
          );
          lastTerminalTextareaSnapshot = beforePaste;
          pasteTextareaClearTimer = window.setTimeout(() => {
            pasteTextareaClearTimer = null;
            if (
              term.textarea === textarea &&
              textarea.value === beforePaste.value
            ) {
              textarea.value = "";
              lastTerminalTextareaSnapshot = {
                value: "",
                selectionStart: 0,
                selectionEnd: 0,
              };
            }
          }, 0);
        }
        input.stopPropagation();
        void runPasteOperation(() =>
          pasteText(pastedText, destinationPaneId),
        ).catch((error) => {
          setUploadError(`Text paste failed: ${(error as Error).message}`);
        });
        return;
      }

      lastTerminalTextareaSnapshot = textareaSnapshot;
      if (input.inputType === "insertFromPaste") {
        input.stopPropagation();
        if (nativePasteFallbackTimer === null) {
          pasteTextareaBeforeInput = null;
          pastePaneIdBeforeInput = null;
        }
        return;
      }
      cancelNativePasteFallback();
      cancelPasteTextareaClear();
      pasteTextareaBeforeInput = null;
      pastePaneIdBeforeInput = null;

      if (xtermHandledCurrentInput) {
        // Safari still mutates the helper textarea after xterm handles some
        // printable keys in keypress. Do not replay that same committed text.
        imeTextareaFallback.cancelPending();
        return;
      }

      if (shouldRecoverCommittedImeInput(input)) {
        // beforeinput is not guaranteed on every WebKit keyboard. The previous
        // observed textarea value is the best safe append-only baseline when it
        // is absent; begin() preserves an earlier keydown/beforeinput baseline.
        imeTextareaFallback.begin(textareaBeforeInput.value);
        const flushStatus = flushTextareaImeFallback(input);
        scheduleImeTextareaFinal(input);
        if (flushStatus === "handled") return;
      }

      const fallbackText = terminalCompositionActive
        ? null
        : terminalImeFallbackText(input);
      if (!fallbackText) return;
      const observedAt = performance.now();
      const eventAt = terminalImeEventTime(input, observedAt);
      sendMissingImeText(fallbackText, eventAt, observedAt);
    };
    const onTerminalTextInput = (e: Event) => {
      try {
        handleTerminalTextInput(e);
      } finally {
        // Without beforeinput, xterm has already emitted before this listener.
        // Keep its tombstone through recovery, but never into the next input.
        if (!imeTextareaFallback.hasPending()) {
          imeCommitGuard.completeRecoveryCycle();
        }
      }
    };
    term.textarea?.addEventListener("keydown", onTerminalKeyDown, {
      capture: true,
    });
    term.textarea?.addEventListener("keyup", onTerminalKeyUp, {
      capture: true,
    });
    term.textarea?.addEventListener(
      "compositionstart",
      onTerminalCompositionStart,
      { capture: true },
    );
    term.textarea?.addEventListener("compositionend", onTerminalCompositionEnd);
    term.textarea?.addEventListener("blur", onTerminalBlur, {
      capture: true,
    });
    term.textarea?.addEventListener("beforeinput", onTerminalBeforeInput, {
      capture: true,
    });
    term.textarea?.addEventListener("input", onTerminalTextInput, {
      capture: true,
    });

    const onPaste = async (e: ClipboardEvent) => {
      if (!isActivePaneRef.current) return;
      const items = Array.from(e.clipboardData?.items ?? []);
      const img = items.find((it) => it.type.startsWith("image/"))?.getAsFile();
      const text = img ? "" : (e.clipboardData?.getData("text/plain") ?? "");
      const active = document.activeElement;
      const target = e.target;
      const isTerminalPaste =
        target === document ||
        container.contains(target as Node | null) ||
        (active ? container.contains(active) : false);
      if (!isTerminalPaste && isEditableElement(target)) return;
      imeCommitGuard.beginIndependentInput();
      const destinationPaneId = paneIdRef.current ?? null;
      if (!img && appleTouchPlatform && isTerminalPaste) {
        cancelImeTextareaFallback();
        cancelNativePasteFallback();
        cancelPasteTextareaClear();
        const beforePaste = readTerminalTextareaSnapshot();
        pasteTextareaBeforeInput = beforePaste;
        pastePaneIdBeforeInput = destinationPaneId;
        lastTerminalTextareaSnapshot = beforePaste;

        // Keep WebKit's native insertion so insertFromPaste can expose the full
        // text, but stop xterm's target listener from consuming truncated
        // ClipboardEvent data and clearing the textarea first.
        e.stopPropagation();
        if (text) {
          nativePasteFallbackTimer = window.setTimeout(() => {
            nativePasteFallbackTimer = null;
            if (pasteTextareaBeforeInput !== beforePaste) return;
            pasteTextareaBeforeInput = null;
            pastePaneIdBeforeInput = null;
            void runPasteOperation(() =>
              pasteText(text, destinationPaneId),
            ).catch((error) => {
              setUploadError(`Text paste failed: ${(error as Error).message}`);
            });
          }, 0);
        }
        return;
      }
      if (!img && !text) return;
      cancelImeTextareaFallback();
      cancelNativePasteFallback();
      cancelPasteTextareaClear();
      pasteTextareaBeforeInput = null;
      pastePaneIdBeforeInput = null;
      e.preventDefault();
      e.stopPropagation();
      try {
        await runPasteOperation(() =>
          img
            ? pasteImage(img, destinationPaneId)
            : pasteText(text, destinationPaneId),
        );
      } catch (err) {
        setUploadError(
          `${img ? "Image upload" : "Text paste"} failed: ${(err as Error).message}`,
        );
      }
    };
    container.addEventListener("paste", onPaste);
    document.addEventListener("paste", onPaste, { capture: true });

    const onCopy = (e: ClipboardEvent) => {
      if (
        (!term.hasSelection() && !historySelection.active) ||
        !e.clipboardData
      )
        return;
      const selectedText = historySelection.text ?? term.getSelection();
      if (!selectedText) return;
      e.preventDefault();
      e.stopPropagation();
      e.clipboardData.setData(
        "text/plain",
        trimCopiedLinePadding(selectedText),
      );
    };
    container.addEventListener("copy", onCopy, { capture: true });

    const onClick = (e: MouseEvent) => {
      if (
        !terminalMouseUsesSelection(
          endpointPresentation.mouseReporting,
          e,
          applePlatform,
        )
      )
        return;
      if (!isSafariBrowser() || term.hasSelection()) return;
      term.clearSelection();
      container.ownerDocument.dispatchEvent(
        new MouseEvent("mouseup", {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 0,
          buttons: 0,
          clientX: e.clientX,
          clientY: e.clientY,
          screenX: e.screenX,
          screenY: e.screenY,
        }),
      );
    };
    container.addEventListener("click", onClick);

    // xterm only disarms its document-level drag listeners on mouseup. When
    // the release is lost (released outside the window, or the browser drops
    // the mouseup after the mousedown target was re-rendered mid-gesture),
    // every later move keeps growing the selection without a button pressed.
    // Detect the lost release on the first button-less move and force it.
    const selectionDragGuard = new TerminalSelectionDragGuard();
    let deferredMove: MouseEvent | null = null;
    let deferredUp: MouseEvent | null = null;
    const replayMouse = (target: EventTarget, event: MouseEvent) => {
      // The reporting mode may have changed while parsing. Preserve the
      // original modifiers and add only xterm's local selection escape.
      const forceSelection = term.modes.mouseTrackingMode !== "none";
      target.dispatchEvent(
        new MouseEvent(event.type, {
          bubbles: true,
          cancelable: true,
          view: window,
          button: event.button,
          buttons: event.buttons,
          detail: event.detail,
          clientX: event.clientX,
          clientY: event.clientY,
          screenX: event.screenX,
          screenY: event.screenY,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey || (forceSelection && applePlatform),
          shiftKey: event.shiftKey || (forceSelection && !applePlatform),
        }),
      );
    };
    let reviewSelectionDrag = false;
    const onTerminalMouseDown = (e: MouseEvent) => {
      if (replayingSelection) return;
      if (
        terminalPointerShouldFocusInput(
          shouldAvoidVirtualKeyboard(),
          e.button,
          composerOpenRef.current,
        )
      ) {
        // Selection replay can defer xterm's own mousedown handler until after
        // the browser's user-activation window. Focus during the physical tap
        // so mobile browsers can open the virtual keyboard.
        term.focus();
      }
      if (
        !terminalMouseUsesSelection(
          endpointPresentation.mouseReporting,
          e,
          applePlatform,
        )
      )
        return;
      selectionDragGuard.mouseDown(e.button);
      if (e.button !== 0) return;
      reviewSelectionDrag = true;
      setReviewSelection(null);
      historySelection.reset();
      if (
        endpointPresentation.mouseReporting === undefined &&
        !endpointPresentation.writePending
      ) {
        endpointPresentation.selectionDrag = true;
        return;
      }
      const terminalId = desiredTerminalRef.current;
      deferredMove = deferredUp = null;
      if (
        !endpointPresentation.beginSelection(() => {
          if (
            terminalEffectDisposed ||
            !connectionClient.isCurrent() ||
            terminalId !== desiredTerminalRef.current ||
            !(e.target instanceof Node) ||
            !e.target.isConnected
          )
            return;
          replayingSelection = true;
          try {
            replayMouse(e.target, e);
            if (deferredMove)
              replayMouse(container.ownerDocument, deferredMove);
            if (deferredUp) replayMouse(container.ownerDocument, deferredUp);
          } finally {
            replayingSelection = false;
            deferredMove = deferredUp = null;
          }
        })
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    const onDeferredMouseMove = (e: MouseEvent) => {
      if (
        !endpointPresentation.selectionPending &&
        historySelection.move(
          e,
          endpointPresentation.selectionDrag && !(e.altKey && !applePlatform),
        )
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (!endpointPresentation.selectionPending || deferredUp) return;
      if (e.buttons === 0) {
        // A lost release finalizes at the last held-button move, not this hover.
        deferredUp = new MouseEvent("mouseup", e);
        selectionDragGuard.mouseUp();
      } else {
        deferredMove = e;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onDocumentMouseUp = (e: MouseEvent) => {
      if (historySelection.releasingNative) return;
      historySelection.finish();
      if (endpointPresentation.selectionPending) {
        if (deferredUp) return; // the first release froze this gesture
        deferredUp = e;
        selectionDragGuard.mouseUp();
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      const offerReview = reviewSelectionDrag && e.button === 0;
      reviewSelectionDrag = false;
      selectionDragGuard.mouseUp();
      endpointPresentation.selectionDrag = false;
      queueMicrotask(() => {
        if (
          offerReview &&
          !terminalEffectDisposed &&
          connectionClient.isCurrent()
        ) {
          const quote = historySelection.text ?? term.getSelection();
          const source = store
            .get()
            .panes.find((candidate) => candidate.pane_id === paneIdRef.current);
          if (source && quote.trim() && quote.length <= MAX_QUOTE_LENGTH) {
            setReviewSelection({
              x: Math.max(8, Math.min(e.clientX, window.innerWidth - 140)),
              y: Math.max(8, Math.min(e.clientY + 8, window.innerHeight - 48)),
              quote,
              title: terminalAnnotationTitle(source),
              paneId: source.pane_id,
              workspaceId: source.workspace_id,
              tabId: source.tab_id,
              terminalId: source.terminal_id,
              composing: false,
            });
          }
        }
        if (!terminalEffectDisposed) endpointPresentation.flush();
      });
    };
    const onNativeMouseDown = (e: MouseEvent) => {
      // A new physical gesture anywhere owns document listeners now. Cancel
      // this deferred replay before a sibling terminal can start an app drag.
      // Synthetic selection replay must not cancel another pane's intent.
      if (!e.isTrusted) return;
      const target = e.target instanceof Element ? e.target : null;
      if (
        !target?.closest(
          ".terminal-annotation-action, .annotation-composer-popover",
        )
      )
        setReviewSelection(null);
      if (historySelection.active) {
        historySelection.finish();
        selectionDragGuard.reset();
        endpointPresentation.selectionDrag = false;
      }
      if (!endpointPresentation.selectionPending) return;
      deferredMove = deferredUp = null;
      selectionDragGuard.reset();
      endpointPresentation.cancelSelection();
    };
    const onSelectionBlur = () => {
      historySelection.finish();
      if (endpointPresentation.selectionPending) {
        deferredMove = deferredUp = null;
        selectionDragGuard.reset();
        endpointPresentation.cancelSelection();
        return;
      }
      if (
        endpointPresentation.mouseReporting === undefined ||
        !endpointPresentation.selectionDrag
      )
        return;
      // End xterm's document listeners too; merely resetting our guard would
      // leave a lost native release extending the selection on later moves.
      container.ownerDocument.dispatchEvent(
        new MouseEvent("mouseup", {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 0,
          buttons: 0,
        }),
      );
    };
    const onDocumentMouseMove = (e: MouseEvent) => {
      if (!selectionDragGuard.mouseMoveNeedsRelease(e.buttons)) return;
      container.ownerDocument.dispatchEvent(
        new MouseEvent("mouseup", {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 0,
          buttons: 0,
          clientX: e.clientX,
          clientY: e.clientY,
          screenX: e.screenX,
          screenY: e.screenY,
        }),
      );
    };
    container.addEventListener("mousedown", onTerminalMouseDown, {
      capture: true,
    });
    window.addEventListener("blur", onSelectionBlur);
    document.addEventListener("mousedown", onNativeMouseDown, {
      capture: true,
    });
    document.addEventListener("mouseup", onDocumentMouseUp, { capture: true });
    document.addEventListener("mousemove", onDeferredMouseMove, {
      capture: true,
    });
    document.addEventListener("mousemove", onDocumentMouseMove);

    const onWheel = (e: WheelEvent) => {
      const selectionScroll = terminalWheelScroll(
        e.deltaY,
        e.deltaMode,
        term.rows,
      );
      if (
        selectionScroll &&
        historySelection.wheel(selectionScroll.direction, selectionScroll.lines)
      ) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (endpointPresentation.mouseReporting !== undefined) {
        if (
          term.hasSelection() ||
          endpointPresentation.selectionDrag ||
          composerOpenRef.current
        ) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        // Let xterm produce pane-local SGR coordinates and modifiers only on
        // endpoint streams. Legacy AttachScroll routing stays unchanged.
        if (
          endpointPresentation.mouseReporting &&
          term.modes.mouseTrackingMode !== "none"
        )
          return;
      }
      const scroll = terminalWheelScroll(e.deltaY, e.deltaMode, term.rows);
      const terminalId = desiredTerminalRef.current;
      if (
        !scroll ||
        !terminalId ||
        store.terminalScrollReason(
          terminalId,
          endpointPresentation.mouseReporting,
        )
      )
        return;
      connectionClient
        .call("terminal.scroll", {
          terminal_id: terminalId,
          ...scroll,
          ...terminalCellAt(term, e),
        })
        .catch(() => {});
      e.preventDefault();
      e.stopPropagation();
    };
    container.addEventListener("wheel", onWheel, {
      capture: true,
      passive: false,
    });

    let touchStartX: number | null = null;
    let touchStartY: number | null = null;
    let touchLastY: number | null = null;
    let touchMoved = false;
    let touchRemainder = 0;
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        touchMoved = true;
        return;
      }
      const touch = e.touches[0];
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      touchLastY = touch.clientY;
      touchMoved = false;
      touchRemainder = 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1 || touchLastY === null) return;
      const touch = e.touches[0];
      if (
        touchStartX !== null &&
        touchStartY !== null &&
        Math.hypot(touch.clientX - touchStartX, touch.clientY - touchStartY) >
          TERMINAL_TOUCH_TAP_SLOP_PX
      ) {
        touchMoved = true;
      }
      if (
        endpointPresentation.mouseReporting !== undefined &&
        (term.hasSelection() ||
          endpointPresentation.selectionDrag ||
          composerOpenRef.current)
      ) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const deltaY = touchLastY - touch.clientY;
      touchLastY = touch.clientY;
      touchRemainder += deltaY;

      const lines = Math.trunc(touchRemainder / 24);
      if (lines !== 0) {
        touchRemainder -= lines * 24;
        const terminalId = desiredTerminalRef.current;
        if (
          terminalId &&
          !store.terminalScrollReason(
            terminalId,
            endpointPresentation.mouseReporting,
          )
        ) {
          connectionClient
            .call("terminal.scroll", {
              terminal_id: terminalId,
              direction: lines < 0 ? "up" : "down",
              lines: Math.min(term.rows, Math.abs(lines)),
              source: "wheel",
              ...terminalCellAtPoint(term, touch.clientX, touch.clientY),
            })
            .catch(() => {});
        }
      }

      e.preventDefault();
      e.stopPropagation();
    };
    const onTouchEnd = () => {
      const focusInput = terminalTouchShouldFocusInput(
        touchStartX !== null && touchStartY !== null,
        touchMoved,
        composerOpenRef.current,
      );
      touchStartX = null;
      touchStartY = null;
      touchLastY = null;
      touchMoved = false;
      touchRemainder = 0;
      // Mobile Safari and installed PWAs do not reliably synthesize mousedown.
      // Focus from the trusted touchend while user activation is still valid.
      if (focusInput) term.focus();
    };
    const onTouchCancel = () => {
      touchStartX = null;
      touchStartY = null;
      touchLastY = null;
      touchMoved = false;
      touchRemainder = 0;
    };
    const onDocumentPointerDown = (e: PointerEvent) => {
      const targetInsideTerminal =
        e.target instanceof Node && container.contains(e.target);
      if (
        !terminalPointerShouldBlurInput(
          shouldAvoidVirtualKeyboard(),
          isEditableElement(e.target),
          targetInsideTerminal,
        )
      )
        return;
      term.textarea?.blur();
    };
    container.addEventListener("touchstart", onTouchStart, {
      capture: true,
      passive: true,
    });
    container.addEventListener("touchmove", onTouchMove, {
      capture: true,
      passive: false,
    });
    container.addEventListener("touchend", onTouchEnd, { capture: true });
    container.addEventListener("touchcancel", onTouchCancel, { capture: true });
    document.addEventListener("pointerdown", onDocumentPointerDown, {
      capture: true,
    });

    return () => {
      terminalEffectDisposed = true;
      off();
      selectionChange.dispose();
      selectionResize.dispose();
      endpointPresentation.dispose();
      endpointPresentationRef.current = null;
      offClipboard();
      offClosed();
      unregisterConnectionDisposer();
      window.removeEventListener(LAYOUT_CHANGE_EVENT, applyDensity);
      ro.disconnect();
      resizeSync.dispose();
      resizeSyncRef.current = null;
      attachWatchdogRef.current?.cancel();
      cancelImeTextareaFallback();
      cancelCompositionSettle();
      cancelNativePasteFallback();
      cancelPasteTextareaClear();
      disposePasteOperations();
      term.textarea?.removeEventListener("keydown", onTerminalKeyDown, {
        capture: true,
      });
      term.textarea?.removeEventListener("keyup", onTerminalKeyUp, {
        capture: true,
      });
      term.textarea?.removeEventListener(
        "compositionstart",
        onTerminalCompositionStart,
        { capture: true },
      );
      term.textarea?.removeEventListener(
        "compositionend",
        onTerminalCompositionEnd,
      );
      term.textarea?.removeEventListener("blur", onTerminalBlur, {
        capture: true,
      });
      term.textarea?.removeEventListener("input", onTerminalTextInput, {
        capture: true,
      });
      term.textarea?.removeEventListener("beforeinput", onTerminalBeforeInput, {
        capture: true,
      });
      container.removeEventListener("paste", onPaste);
      document.removeEventListener("paste", onPaste, { capture: true });
      container.removeEventListener("copy", onCopy, { capture: true });
      container.removeEventListener("click", onClick);
      container.removeEventListener("mousedown", onTerminalMouseDown, {
        capture: true,
      });
      window.removeEventListener("blur", onSelectionBlur);
      document.removeEventListener("mousedown", onNativeMouseDown, {
        capture: true,
      });
      document.removeEventListener("mouseup", onDocumentMouseUp, {
        capture: true,
      });
      document.removeEventListener("mousemove", onDeferredMouseMove, {
        capture: true,
      });
      document.removeEventListener("mousemove", onDocumentMouseMove);
      container.removeEventListener("wheel", onWheel, { capture: true });
      container.removeEventListener("touchstart", onTouchStart, {
        capture: true,
      });
      container.removeEventListener("touchmove", onTouchMove, {
        capture: true,
      });
      container.removeEventListener("touchend", onTouchEnd, { capture: true });
      container.removeEventListener("touchcancel", onTouchCancel, {
        capture: true,
      });
      document.removeEventListener("pointerdown", onDocumentPointerDown, {
        capture: true,
      });
      imeFallback.dispose();
      imeCommitGuard.dispose();
      linkProvider.dispose();
      const terminalId = attachedRef.current ?? desiredTerminalRef.current;
      if (
        terminalId &&
        !disposedByConnectionLease &&
        connectionClient.isCurrent()
      ) {
        void connectionClient
          .call("terminal.detach", { terminal_id: terminalId })
          .catch(() => null);
      }
      term.dispose();
      termRef.current = null;
      setTermInstance(null);
      fitRef.current = null;
      attachedRef.current = null;
      attachingRef.current = null;
      desiredTerminalRef.current = null;
      renderedTerminalRef.current = null;
    };
  }, [
    connectionClient,
    container,
    fitVisibleTerminal,
    focusTerminalSoon,
    openPathInInspector,
    relayViewportFor,
    resolveTerminalFilePaths,
    scrollPage,
    terminalIdentity,
  ]);

  // attach / re-attach when the rendered pane changes
  useEffect(() => {
    if (!connectionClient.isCurrent()) return;
    const term = termInstance;
    const paneTerminalId = pane?.terminal_id ?? null;
    if (
      desiredTerminalRef.current !== paneTerminalId ||
      s.status !== "connected"
    ) {
      endpointPresentationRef.current?.reset();
    }
    if (terminalAttachEpochRef.current !== s.terminalAttachEpoch) {
      endpointPresentationRef.current?.reset();
      terminalAttachEpochRef.current = s.terminalAttachEpoch;
      attachedRef.current = null;
      attachingRef.current = null;
      attachTimeoutCountRef.current = 0;
      attachTimeoutTerminalRef.current = null;
      attachWatchdogRef.current?.cancel();
    }
    if (!paneTerminalId) {
      desiredTerminalRef.current = null;
      attachWatchdogRef.current?.cancel();
      setTerminalLoading(false);
      setTerminalAttachError("");
      return;
    }
    desiredTerminalRef.current = paneTerminalId;
    if (s.status !== "connected") {
      attachedRef.current = null;
      attachingRef.current = null;
      attachWatchdogRef.current?.cancel();
      setTerminalLoading(false);
      setTerminalAttachError("");
      return;
    }
    if (!term) return;
    focusTerminalSoon();
    if (attachedRef.current === paneTerminalId) return;
    if (attachingRef.current === paneTerminalId) return;
    const terminalId = paneTerminalId;
    const staleTerminalIds = [attachedRef.current, attachingRef.current].filter(
      (id, index, ids): id is string =>
        !!id && id !== terminalId && ids.indexOf(id) === index,
    );
    for (const staleTerminalId of staleTerminalIds) {
      void connectionClient
        .call("terminal.detach", { terminal_id: staleTerminalId })
        .catch(() => null);
    }
    if (staleTerminalIds.length > 0) {
      attachedRef.current = null;
      attachingRef.current = null;
    }
    if (attachTimeoutTerminalRef.current !== terminalId) {
      attachTimeoutTerminalRef.current = terminalId;
      attachTimeoutCountRef.current = 0;
    }
    attachingRef.current = terminalId;
    setTerminalLoading(true);
    setTerminalAttachError("");
    const attachAttempt = attachWatchdogRef.current!.begin();
    const fitSize = fitVisibleTerminal();
    const cols = fitSize?.cols ?? term.cols;
    const rows = fitSize?.rows ?? term.rows;
    const relaySize = relayViewportFor({ cols, rows });
    const surfaceSize = terminalEndpointViewportSize(
      { cols, rows },
      paneLayoutRef.current?.tab_id === paneTabIdRef.current
        ? paneLayoutRef.current
        : null,
      paneIdRef.current,
    );
    // Keep the current buffer when re-attaching the same terminal (watchdog
    // retry, reconnect): the server repaints a full frame anyway, and keeping
    // the buffer avoids a blank flash plus losing local scrollback.
    if (renderedTerminalRef.current !== terminalId) {
      term.reset();
      renderedTerminalRef.current = terminalId;
    }
    resizeSyncRef.current?.markAttached({ cols, rows });
    store.setTerminalEndpoint(connectionClient, terminalId, null);
    const attachStartedAt = performance.now();
    connectionClient
      .call("terminal.attach", {
        terminal_id: terminalId,
        cols,
        rows,
        ...(surfaceSize
          ? { surface_cols: surfaceSize.cols, surface_rows: surfaceSize.rows }
          : {}),
        relay_active: relaySize !== null,
        ...(relaySize
          ? { relay_cols: relaySize.cols, relay_rows: relaySize.rows }
          : {}),
      })
      .then(
        (result) => {
          if (!connectionClient.isCurrent()) return;
          if (desiredTerminalRef.current === terminalId)
            store.setTerminalEndpoint(
              connectionClient,
              terminalId,
              result?.endpoint,
            );
          if (attachingRef.current === terminalId) attachingRef.current = null;
          if (desiredTerminalRef.current === terminalId) {
            attachedRef.current = terminalId;
            // Attaching a split focuses it in Herdr, even in the background.
            // Restore the current selection after each completed attach; use
            // current state so a late response cannot revive an old selection.
            const current = store.get();
            const selectedPaneId = activePaneIdForSnapshot(current);
            focusTerminalEndpoint(
              connectionClient,
              current.panes.find((p) => p.pane_id === selectedPaneId)
                ?.terminal_id,
            );
            focusTerminalSoon();
            // Resizes observed while the attach was in flight are dropped by
            // the sync's send guard; push the settled size now (deduped).
            const settledSize = fitVisibleTerminal();
            if (settledSize) resizeSyncRef.current?.sendNow(settledSize);
            const watchdogMs = terminalAttachWatchdogMs(
              performance.now() - attachStartedAt,
            );
            attachWatchdogRef.current?.arm(attachAttempt, watchdogMs, () => {
              if (
                !connectionClient.isCurrent() ||
                desiredTerminalRef.current !== terminalId
              ) {
                return;
              }
              attachTimeoutCountRef.current += 1;
              attachedRef.current = null;
              attachingRef.current = null;
              void connectionClient
                .call("terminal.detach", { terminal_id: terminalId })
                .catch(() => null);
              if (attachTimeoutCountRef.current > 2) {
                setTerminalLoading(false);
                // Repeated attaches produced no frames right after a
                // foreground resume: the session is wedged in a way in-place
                // recovery cannot fix (silently killed socket, wedged
                // stream). Reload once, rate-limited, replicating the
                // manual refresh that restores the terminal.
                const now = Date.now();
                if (
                  shouldReloadTerminalAfterResume({
                    now,
                    resumedAt: resumedAtRef.current,
                    lastReloadAt: readTerminalRecoveryReloadAt(),
                  })
                ) {
                  writeTerminalRecoveryReloadAt(now);
                  window.location.reload();
                  return;
                }
                setTerminalAttachError(
                  "Terminal stopped receiving frames. Reload the app to reconnect.",
                );
                return;
              }
              setAttachRetry((value) => value + 1);
            });
          }
        },
        (e) => {
          if (!connectionClient.isCurrent()) return;
          attachWatchdogRef.current?.cancel(attachAttempt);
          if (attachingRef.current === terminalId) attachingRef.current = null;
          if (desiredTerminalRef.current === terminalId) {
            attachedRef.current = null;
            setTerminalLoading(false);
            setTerminalAttachError(e instanceof Error ? e.message : String(e));
          }
          console.error("[term] attach failed", e);
        },
      );
  }, [
    container,
    fitVisibleTerminal,
    focusTerminalSoon,
    pane?.terminal_id,
    relayViewportFor,
    s.status,
    s.terminalAttachEpoch,
    attachRetry,
    connectionClient,
    termInstance,
  ]);

  useEffect(() => {
    uiScaleRef.current = uiScale;
    if (!termInstance) return;
    termInstance.options = terminalDensity(uiScale);
    const size = fitVisibleTerminal();
    if (size) resizeSyncRef.current?.sendNow(size);
  }, [uiScale, termInstance, fitVisibleTerminal]);

  useEffect(() => {
    terminalThemeRef.current = terminalTheme;
    if (termInstance) applyTerminalTheme(termInstance, terminalTheme);
  }, [terminalTheme, termInstance]);

  // Mobile browsers freeze the page while hidden: the socket can die
  // silently, rendering pauses, and composited content may come back blank.
  // On return, force a repaint and re-arm a stuck attach so the terminal
  // recovers without a full-page reload. A dead socket is handled by the
  // store-level probe, which flips the status and re-arms the attach epoch.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const recoverTerminal = (fromResume: boolean) => {
      if (document.visibilityState !== "visible") return;
      if (fromResume) {
        // Arm the last-resort reload only after a genuinely long suspension
        // (mobile lock screen, app backgrounding). Desktop tab switches
        // fire visibilitychange too; a measured short one keeps the cheap
        // recovery below but never arms an automatic reload.
        const now = Date.now();
        const hiddenAt = hiddenAtRef.current;
        hiddenAtRef.current = null;
        if (shouldArmTerminalRecoveryResume({ now, hiddenAt })) {
          resumedAtRef.current = now;
        }
      }
      attachTimeoutCountRef.current = 0;
      const term = termRef.current;
      if (term) {
        try {
          term.refresh(0, term.rows - 1);
        } catch {
          // The attach recovery below still applies.
        }
      }
      if (!desiredTerminalRef.current) return;
      if (store.get().status !== "connected") return;
      // A live attach keeps streaming on its own; only a terminal that lost
      // its attach (watchdog give-up, failed attach) needs a nudge.
      if (attachedRef.current || attachingRef.current) return;
      setAttachRetry((value) => value + 1);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        hiddenAtRef.current = Date.now();
        return;
      }
      recoverTerminal(true);
    };
    const onForegroundEvent = () => recoverTerminal(false);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", onForegroundEvent);
    window.addEventListener("focus", onForegroundEvent);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", onForegroundEvent);
      window.removeEventListener("focus", onForegroundEvent);
    };
  }, []);

  const submitTerminalComposer = async (text: string, submit: boolean) => {
    const targetPaneId = paneIdRef.current;
    if (!targetPaneId) throw new Error("No active pane");
    const request = terminalComposerRequest(targetPaneId, text, submit);
    await connectionClient.call(request.method, request.params);
  };
  const uploadComposerImage = (file: File) =>
    uploadTerminalImage(connectionClient, file);
  const notifyComposerError = (message: string) => {
    store.notify({
      kind: "error",
      message: "Terminal composer failed",
      detail: message,
    });
  };
  const mobileShortcutReason = (shortcut: MobileTerminalShortcut) =>
    mobileTerminalShortcutExecution(shortcut.action)?.type === "scroll" &&
    pane?.terminal_id
      ? store.terminalScrollReason(pane.terminal_id)
      : null;
  const runMobileShortcut = (shortcut: MobileTerminalShortcut) => {
    const execution = mobileTerminalShortcutExecution(shortcut.action);
    if (!execution) return;
    if (execution.type === "scroll") {
      scrollPage(execution.direction, execution.amount);
    } else {
      sendControl(execution.bytes);
    }
  };
  const hasMobileShortcuts = mobileShortcuts.some((row) =>
    row.some((shortcut) => shortcut !== null),
  );
  const hasMobileSideShortcuts = mobileSideShortcuts.some(
    (shortcut) => shortcut !== null,
  );
  const mobileShortcutColumns = Math.max(
    1,
    ...mobileShortcuts.map((row) => row.length),
  );

  if (!pane) {
    return (
      <>
        <div className="terminal-empty">
          <HerdrSetupCard
            key={connectionScopeKey}
            enabled={
              !s.connectionPaused &&
              s.activeConnectionId === s.defaultConnectionId
            }
          >
            {s.error ? (
              <div className="terminal-empty-stack" role="alert">
                <span>{s.error}</span>
                <button type="button" onClick={() => void store.refresh()}>
                  Retry
                </button>
              </div>
            ) : s.navigationLoading ? (
              <div
                className="terminal-loading"
                role="status"
                aria-live="polite"
              >
                <span className="terminal-loading-dot" />
                <span>Loading terminal</span>
              </div>
            ) : (
              <span className="muted">
                Select a workspace or agent to open its terminal.
              </span>
            )}
          </HerdrSetupCard>
        </div>
        <MessageDialog
          open={!!uploadError}
          title="Upload Failed"
          message={uploadError}
          onClose={() => setUploadError("")}
        />
      </>
    );
  }

  const composerDraftKey = terminalComposerDraftKey(
    s.activeConnectionId,
    s.connectionGeneration,
    pane.pane_id,
  );
  const composerDraftWarning = terminalComposerCloseWarning(
    terminalComposerDraftPaneIds(s.activeConnectionId, s.connectionGeneration, [
      pane.pane_id,
    ]).length,
  );

  return (
    <>
      {reviewSelection && !reviewSelection.composing
        ? createPortal(
            <button
              type="button"
              className="terminal-annotation-action"
              style={{ left: reviewSelection.x, top: reviewSelection.y }}
              onMouseDown={(event) => event.preventDefault()}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setReviewSelection(null);
                  termRef.current?.focus();
                }
              }}
              onClick={() =>
                setReviewSelection((current) =>
                  current ? { ...current, composing: true } : null,
                )
              }
            >
              Add comment
            </button>,
            document.body,
          )
        : null}
      <AnnotationComposerPopover
        draft={reviewSelection?.composing ? reviewSelection : null}
        onClose={() => setReviewSelection(null)}
        onSave={(comment) => {
          if (!reviewSelection || !connectionClient.isCurrent()) return;
          const source = store
            .get()
            .panes.find(
              (candidate) =>
                candidate.pane_id === reviewSelection.paneId &&
                candidate.workspace_id === reviewSelection.workspaceId &&
                candidate.tab_id === reviewSelection.tabId &&
                candidate.terminal_id === reviewSelection.terminalId,
            );
          if (!source) {
            setReviewSelection(null);
            return;
          }
          const annotation = createReviewAnnotation({
            source: "terminal",
            anchor: "quote",
            paneId: source.pane_id,
            title: reviewSelection.title,
            quote: reviewSelection.quote,
            comment,
          }) as TerminalReviewAnnotation;
          window.dispatchEvent(
            new CustomEvent<WorkspaceAnnotationRequest>(
              WORKSPACE_ANNOTATION_REQUEST_EVENT,
              {
                detail: {
                  connectionId: connectionClient.connectionId,
                  generation: connectionClient.generation,
                  workspaceId: source.workspace_id,
                  annotation,
                },
              },
            ),
          );
          setReviewSelection(null);
        }}
      />
      <div className="terminal-shell">
        <div className="terminal-main">
          <div ref={containerRef} className="terminal-view" />
          {showMobileKeys && hasMobileSideShortcuts ? (
            <div
              className="terminal-mobile-side-shortcuts"
              aria-label="Terminal side shortcuts"
            >
              {mobileSideShortcuts.map((shortcut, slotIndex) => {
                if (!shortcut) {
                  return (
                    <span
                      className="terminal-mobile-side-shortcut-spacer"
                      aria-hidden="true"
                      key={`mobile-side-shortcut-${slotIndex}`}
                    />
                  );
                }
                const option = mobileTerminalShortcutOption(shortcut.action);
                return (
                  <button
                    type="button"
                    disabled={!!mobileShortcutReason(shortcut)}
                    title={
                      mobileShortcutReason(shortcut) ??
                      option?.label ??
                      shortcut.label
                    }
                    aria-label={`Run ${option?.label ?? shortcut.label}`}
                    onPointerDown={preventShortcutFocus}
                    onClick={() => runMobileShortcut(shortcut)}
                    key={shortcut.id}
                  >
                    {shortcut.label}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        {showMobileKeys && hasMobileShortcuts ? (
          <div
            className={`terminal-mobile-keys ${
              mobileKeysOpen ? "is-open" : ""
            }`}
            aria-label="Terminal shortcuts"
          >
            <button
              type="button"
              className="terminal-mobile-keys-toggle"
              aria-label={
                mobileKeysOpen
                  ? "Hide terminal shortcuts"
                  : "Show terminal shortcuts"
              }
              aria-expanded={mobileKeysOpen}
              onPointerDown={preventShortcutFocus}
              onClick={() => setMobileKeysOpen((value) => !value)}
            >
              <Keyboard size={17} />
            </button>
            <div className="terminal-mobile-keys-panel">
              <div
                className="terminal-mobile-keys-grid"
                style={
                  {
                    "--mobile-shortcut-columns": mobileShortcutColumns,
                  } as CSSProperties
                }
              >
                {mobileShortcuts.map((row, rowIndex) => (
                  <div
                    className="terminal-mobile-keys-row"
                    key={`mobile-shortcut-row-${rowIndex}`}
                  >
                    {row.map((shortcut, slotIndex) => {
                      if (!shortcut) {
                        return (
                          <span
                            className="terminal-mobile-key-spacer"
                            aria-hidden="true"
                            key={`mobile-shortcut-${rowIndex}-${slotIndex}`}
                          />
                        );
                      }
                      const option = mobileTerminalShortcutOption(
                        shortcut.action,
                      );
                      return (
                        <button
                          type="button"
                          disabled={!!mobileShortcutReason(shortcut)}
                          title={
                            mobileShortcutReason(shortcut) ??
                            option?.label ??
                            shortcut.label
                          }
                          aria-label={`Send ${option?.label ?? shortcut.label}`}
                          onPointerDown={preventShortcutFocus}
                          onClick={() => runMobileShortcut(shortcut)}
                          key={shortcut.id}
                        >
                          {shortcut.label}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}
        {composerOpen ? (
          <TerminalComposer
            draftKey={composerDraftKey}
            shortcutRows={mobileShortcuts}
            onRunShortcut={runMobileShortcut}
            shortcutDisabledReason={mobileShortcutReason}
            onClose={() => setComposerOpen(false)}
            onSubmit={submitTerminalComposer}
            onUploadImage={uploadComposerImage}
            onError={notifyComposerError}
          />
        ) : null}
        <div className="terminal-pane-toolbar" aria-label="Pane actions">
          {s.endpointAvailability[pane.terminal_id] &&
          store.terminalScrollReason(pane.terminal_id) ? (
            <span
              className="muted"
              role="status"
              title={store.terminalScrollReason(pane.terminal_id) ?? undefined}
            >
              History unavailable: pane.scroll not advertised
            </span>
          ) : null}
          {!paneZoomed ? (
            <>
              <button
                type="button"
                className="terminal-pane-action"
                title="Split pane right"
                aria-label="Split pane right"
                onPointerDown={preventPaneActionFocus}
                onClick={() => store.splitPane(pane.pane_id, "right")}
              >
                <Columns2 size={14} />
              </button>
              <button
                type="button"
                className="terminal-pane-action"
                title="Split pane down"
                aria-label="Split pane down"
                onPointerDown={preventPaneActionFocus}
                onClick={() => store.splitPane(pane.pane_id, "down")}
              >
                <Rows2 size={14} />
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="terminal-pane-action"
            title={paneZoomed ? "Restore pane" : "Maximize pane"}
            aria-label={paneZoomed ? "Restore pane" : "Maximize pane"}
            onPointerDown={preventPaneActionFocus}
            onClick={() => store.zoomPane(pane.pane_id)}
          >
            {paneZoomed ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          {canClosePane ? (
            <button
              type="button"
              className="terminal-pane-action is-danger"
              title="Close pane"
              aria-label="Close pane"
              onPointerDown={preventPaneActionFocus}
              onClick={() => setClosePaneRequested(true)}
            >
              <X size={14} />
            </button>
          ) : null}
        </div>
        {s.connectionPaused ? (
          <div className="terminal-loading" role="status" aria-live="polite">
            <span className="terminal-loading-dot" />
            <span>Connection paused</span>
          </div>
        ) : terminalAttachError ? (
          <div
            className="terminal-loading is-error"
            role="alert"
            aria-live="assertive"
          >
            <span>{terminalAttachError}</span>
          </div>
        ) : terminalLoading || pasteLoading ? (
          <div className="terminal-loading" role="status" aria-live="polite">
            <span className="terminal-loading-dot" />
            <span>{pasteLoading ? "Pasting..." : "Loading terminal"}</span>
          </div>
        ) : null}
      </div>
      <ConfirmDialog
        open={closePaneRequested}
        title="Close Pane"
        message={`Close this terminal pane?${composerDraftWarning}`}
        confirmLabel="Close"
        danger
        onClose={() => setClosePaneRequested(false)}
        onConfirm={() => {
          clearTerminalComposerDrafts(
            s.activeConnectionId,
            s.connectionGeneration,
            [pane.pane_id],
          );
          store.closePane(pane.pane_id);
        }}
      />
      <MessageDialog
        open={!!uploadError}
        title="Upload Failed"
        message={uploadError}
        onClose={() => setUploadError("")}
      />
    </>
  );
}

import { useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { X } from "lucide-react";
import { bridge } from "../api";
import { store, useStoreSelector, type PopupInfo } from "../store";
import { useConnectionClient } from "../useConnectionClient";
import {
  normalizeUiScale,
  TERMINAL_FONT_FAMILY,
  terminalFontOptions,
} from "../appearance";
import { roamgateLocalStorage } from "../browserStorage";
import { isMobileLayout } from "../layoutPreferences";
import { terminalPushMatches } from "../terminalConnection";
import { terminalCellAt, terminalWheelScroll } from "../terminalScroll";

const RESIZE_DEBOUNCE_MS = 150;

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

/** Rough CSS sizing from Herdr's cells-or-percent popup size config. A cell
 * approximation, not the server's own resolved geometry: the popup's real
 * pixel size is negotiated as this component's own terminal.attach cols and
 * rows, same as any other pane. */
function cssSizeFrom(
  size: PopupInfo["width"],
  fallbackVw: number,
  cellUnit: string,
): string {
  if (!size) return `${fallbackVw}vw`;
  if (size.kind === "percent") return `${size.value}%`;
  return `calc(${size.value} * ${cellUnit})`;
}

/**
 * Floating overlay for Herdr's session-modal popup pane (e.g. a plugin's
 * "Herdr Float" toggle). Renders above the normal tiled layout, as a sibling
 * to it, so clicks on it never reach a pane's own focus-on-click handler.
 *
 * This intentionally does not share TerminalView's full feature set (mouse
 * drag-select, IME composition, clipboard image paste, endpoint mouse-report
 * presentation): the popup streams over Herdr's legacy direct-attach
 * protocol (see terminal-bridge.ts's ThinClient branch for popup terminals),
 * which does not carry those endpoint-only capabilities in the first place.
 */
export function PopupOverlay({ terminalTheme }: { terminalTheme: ITheme }) {
  const popup = useStoreSelector((s) => s.popup);
  const connectionClient = useConnectionClient();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const attachedTerminalIdRef = useRef<string | null>(null);
  // How many runs of the attach effect are live. React re-runs an effect
  // (mount, cleanup, mount) without anything having really gone away, and the
  // first run's attach can resolve after its own cleanup, by which point the
  // second run already owns the terminal. Detaching then closes the shared
  // stream out from under it and the overlay never receives a frame.
  const liveAttachmentsRef = useRef(0);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const closedAttemptsRef = useRef<number[]>([]);
  const [attachRetry, retryAttach] = useState(0);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = terminalTheme;
  }, [terminalTheme]);
  useEffect(() => {
    closedAttemptsRef.current = [];
  }, [popup?.terminal_id, connectionClient]);

  // Mount/attach xterm.js once a popup exists; detach and tear it down once
  // it's gone. A change in terminal_id (a new popup replacing a hidden one
  // is not expected today, since Herdr allows only one at a time, but is
  // handled the same way as a fresh mount for safety).
  useEffect(() => {
    const container = containerRef.current;
    if (!popup || !container) return;
    const terminalId = popup.terminal_id;
    const activeElement = document.activeElement;
    if (
      !previousFocusRef.current?.isConnected &&
      activeElement instanceof HTMLElement &&
      !activeElement.closest(".popup-overlay-backdrop")
    ) {
      previousFocusRef.current = activeElement;
    }
    // Same font stack and density as a normal pane: the popup is a terminal
    // like any other, and a prompt drawing Nerd Font glyphs must not fall back
    // to tofu just because it renders here.
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: TERMINAL_FONT_FAMILY,
      ...terminalFontOptions(
        isMobileLayout(),
        normalizeUiScale(roamgateLocalStorage.getItem("uiScale")),
      ),
      theme: terminalTheme,
      allowProposedApi: true,
      macOptionIsMeta: true,
      scrollback: 2000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    // Size the view to the container before anything else. xterm starts at its
    // default 80x24, and the only other fit runs behind a debounce that used
    // to bail out while the attach was still in flight, which left the
    // terminal short and showed the panel's own background as a dead band
    // under the last row.
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const client = connectionClient;
    const identity = {
      connectionId: client.connectionId,
      generation: client.generation,
    };
    liveAttachmentsRef.current += 1;
    const dims = fit.proposeDimensions();
    const cols = dims?.cols ?? term.cols;
    const rows = dims?.rows ?? term.rows;
    // Cleanup can run before the attach resolves (React re-running the effect,
    // or the popup closing mid-flight). Without this the viewer is never
    // detached: the server keeps a second attachment alive, both sizes fight
    // over the shared terminal, and the live overlay can miss the first frame.
    let detached = false;
    client
      .call("terminal.attach", {
        terminal_id: terminalId,
        cols,
        rows,
        relay_active: false,
      })
      .then(() => {
        if (!client.isCurrent()) return;
        if (detached) {
          if (liveAttachmentsRef.current === 0) {
            void client
              .call("terminal.detach", { terminal_id: terminalId })
              .catch(() => {});
          }
          return;
        }
        attachedTerminalIdRef.current = terminalId;
        fit.fit();
        const settled = fit.proposeDimensions();
        if (settled && (settled.cols !== cols || settled.rows !== rows)) {
          void client
            .call("terminal.resize", {
              terminal_id: terminalId,
              cols: settled.cols,
              rows: settled.rows,
              relay_active: false,
            })
            .catch(() => {});
        }
      })
      .catch(() => {
        if (!detached) term.writeln("Unable to attach popup terminal.");
      });

    const offTerminal = bridge.onTerminal((t) => {
      if (!terminalPushMatches(identity, client, terminalId, t)) return;
      const text = b64toText(t.bytes);
      if (text !== null) term.write(text);
    });
    const offClosed = bridge.onTerminalClosed((closed) => {
      if (!terminalPushMatches(identity, client, terminalId, closed)) return;
      attachedTerminalIdRef.current = null;
      const now = Date.now();
      closedAttemptsRef.current = closedAttemptsRef.current.filter(
        (at) => now - at < 60_000,
      );
      closedAttemptsRef.current.push(now);
      if (
        closed.reason === "terminal_configuration_changed" ||
        closedAttemptsRef.current.length <= 3
      ) {
        retryAttach((value) => value + 1);
      } else {
        term.writeln(
          "Popup terminal stream closed; reopen the popup to retry.",
        );
      }
    });

    const onData = term.onData((data) => {
      if (!client.isCurrent() || attachedTerminalIdRef.current !== terminalId)
        return;
      void client.call("terminal.input", {
        terminal_id: terminalId,
        data: bytesToB64(new TextEncoder().encode(data)),
      });
    });

    // Frames are rendered server-side and written straight into this view, so
    // xterm's own buffer holds only what is on screen: scrolling has to ask
    // Herdr for the history instead. This is the legacy AttachScroll route the
    // popup's direct attach already uses; the pane-level endpoint gate does not
    // apply, since a popup terminal never advertises endpoint methods.
    const onWheel = (e: WheelEvent) => {
      if (!client.isCurrent() || attachedTerminalIdRef.current !== terminalId)
        return;
      const scroll = terminalWheelScroll(e.deltaY, e.deltaMode, term.rows);
      if (!scroll) return;
      e.preventDefault();
      e.stopPropagation();
      void client
        .call("terminal.scroll", {
          terminal_id: terminalId,
          ...scroll,
          ...terminalCellAt(term, e),
        })
        .catch(() => {});
    };
    container.addEventListener("wheel", onWheel, {
      capture: true,
      passive: false,
    });

    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(() => {
        // Always refit locally: the view has to match the panel whether or not
        // the attach has landed yet. Only the server-side resize waits for it.
        fit.fit();
        if (attachedTerminalIdRef.current !== terminalId) return;
        const next = fit.proposeDimensions();
        if (!next) return;
        void client.call("terminal.resize", {
          terminal_id: terminalId,
          cols: next.cols,
          rows: next.rows,
          relay_active: false,
        });
      }, RESIZE_DEBOUNCE_MS);
    });
    resizeObserver.observe(container);
    term.focus();

    return () => {
      detached = true;
      liveAttachmentsRef.current = Math.max(0, liveAttachmentsRef.current - 1);
      offTerminal();
      offClosed();
      onData.dispose();
      container.removeEventListener("wheel", onWheel, { capture: true });
      resizeObserver.disconnect();
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      if (
        attachedTerminalIdRef.current === terminalId &&
        liveAttachmentsRef.current === 0
      ) {
        client
          .call("terminal.detach", { terminal_id: terminalId })
          .catch(() => {});
      }
      attachedTerminalIdRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      if (
        !store.get().popup &&
        client.isCurrent() &&
        previousFocusRef.current?.isConnected
      ) {
        previousFocusRef.current.focus();
        previousFocusRef.current = null;
      }
    };
    // Title/size render separately; the theme is updated without reattaching.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popup?.terminal_id, connectionClient, attachRetry]);

  if (!popup) return null;

  return (
    <div
      className="popup-overlay-backdrop"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.25)",
      }}
      onPointerDown={(e) => {
        // Click outside the popup body closes it; inside, let it through.
        if (e.target === e.currentTarget) void store.closePopup();
      }}
    >
      <div
        className="popup-overlay-body"
        style={{
          width: cssSizeFrom(popup.width, 85, "1ch"),
          height: cssSizeFrom(popup.height, 80, "1.4em"),
          maxWidth: "96vw",
          maxHeight: "92vh",
          display: "flex",
          flexDirection: "column",
          borderRadius: 8,
          overflow: "hidden",
          boxShadow: "0 12px 40px rgba(0, 0, 0, 0.45)",
          background: "#1e1e1e",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "4px 8px",
            fontSize: 12,
            color: "#ccc",
            background: "#2a2a2a",
          }}
        >
          <span>{popup.title}</span>
          <button
            type="button"
            aria-label="Close popup"
            onClick={() => void store.closePopup()}
            style={{
              background: "transparent",
              border: "none",
              color: "#ccc",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              padding: 2,
            }}
          >
            <X size={14} />
          </button>
        </div>
        <div ref={containerRef} style={{ flex: 1, minHeight: 0 }} />
      </div>
    </div>
  );
}

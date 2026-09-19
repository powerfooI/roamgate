import {
  EndpointCreationDeadline,
  parseEndpointCreationSource,
  type EndpointCreationSource,
} from "./endpoint-creation";
import type { ServerWebSocket } from "bun";
import {
  CONNECTION_CHANGED_DURING_REQUEST,
  serializeConnectionEnvelope,
} from "../connections/protocol";
import { type Logger, silentLogger } from "../utils/logger";
import { NO_TERMINAL_ATTACHED_MESSAGE } from "../utils/rpc-logging";
import { ThinClient } from "./thin-client";
import { roamgateEnv } from "../config/environment";
import { isTerminalHelloProtocol } from "./protocol-compat";
import { EndpointTerminalSession } from "./endpoint-terminal-session";
import { frameToAnsi } from "./frame-to-ansi";
import { isTerminalClipboardPayload } from "./terminal-clipboard";

type TerminalSession = {
  terminalId: string | null;
  cols: number;
  rows: number;
};

type SharedTerminalSession = {
  thin: ThinClient | EndpointTerminalSession;
  connecting: Promise<void> | null;
  firstFrame: Promise<boolean>;
  resolveFirstFrame: ((seen: boolean) => void) | null;
  terminalId: string;
  cols: number;
  rows: number;
  viewers: Set<ServerWebSocket<unknown>>;
  frames: number;
  bytes: number;
  firstFrameLogged: boolean;
  lastFrameLogAt: number;
  /** Last error Herdr reported on the stream, e.g. a takeover notice. */
  lastError: string | null;
};

type ClipboardTarget = {
  ws: ServerWebSocket<unknown>;
  terminalId: string;
  inputAt: number;
  session: SharedTerminalSession;
};

const CLIPBOARD_INPUT_WINDOW_MS = 30_000;
const CLIPBOARD_RELAY_READY_WAIT_MS = 500;
const TERMINAL_FIRST_FRAME_WAIT_MS = 20_000;
const STANDARD_BASE64_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function createTerminalBridge(args: {
  connectionId?: string;
  connectionGeneration?: number;
  logger?: Logger;
  formatError?: (error: unknown) => string;
  clientSocketPath: string;
  herdrProtocol: () => Promise<number>;
  /** Resolve a terminal id to its owning pane id (control-socket pane.list). */
  lookupPaneId?: (terminalId: string) => Promise<string | null>;
  surfaceCodecsEnabled?: () => Promise<boolean>;
  validateCreationSource?: (source: EndpointCreationSource) => Promise<void>;
  createEmptyWorkspace?: (
    params: Record<string, unknown>,
    isCurrent: () => boolean,
    deadline: EndpointCreationDeadline,
  ) => Promise<unknown>;
  safeSend: (
    ws: ServerWebSocket<unknown>,
    payload: string,
    context?: string,
    coalesceKey?: string,
  ) => boolean;
  // Discard a frame held under backpressure once it is the wrong size. Without
  // this, a resize leaves the old-sized frame queued and it paints a short
  // surface into the new pane.
  dropCoalesced?: (ws: ServerWebSocket<unknown>, coalesceKey: string) => void;
  clientLabel: (ws: ServerWebSocket<unknown>) => string;
  markRpcError: (
    ws: ServerWebSocket<unknown>,
    id: string | null | undefined,
    detail?: string,
  ) => void;
  confirmRelayResize?: (request: {
    cols: number;
    rows: number;
    paneId: string | null;
  }) => Promise<boolean>;
}) {
  const logger = args.logger ?? silentLogger;
  const terminals = new Map<ServerWebSocket<unknown>, TerminalSession>();
  const terminalViewers = new Map<
    ServerWebSocket<unknown>,
    Map<string, { cols: number; rows: number }>
  >();
  const sharedTerminals = new Map<string, SharedTerminalSession>();
  const attachmentTokens = new Map<
    ServerWebSocket<unknown>,
    Map<string, object>
  >();
  // Different panes have different endpoint lanes. Preserve each browser's
  // selection order across them, and discard superseded queued selections.
  const focusIntents = new Map<ServerWebSocket<unknown>, object>();
  const focusChains = new Map<ServerWebSocket<unknown>, Promise<void>>();
  let clipboardRelay: ThinClient | null = null;
  let clipboardRelayConnecting: Promise<void> | null = null;
  let clipboardTarget: ClipboardTarget | null = null;
  let clipboardRelaySize: { cols: number; rows: number } | null = null;
  let clipboardRelayRevision = 0;
  // Set when the server speaks protocol 22+ and the relay is known to be
  // undeliverable, so repeated checks neither reconnect nor re-log.
  let clipboardRelaySkipped = false;
  let lifecycleRevision = 0;
  let surfaceSettingsRevision = 0;
  let disposed = false;
  // Resolved once per bridge: the protocol is fixed for the server process,
  // and a restart recreates this bridge.
  let resolvedProtocol: number | null = null;
  async function bridgeProtocol(): Promise<number> {
    if (resolvedProtocol === null) {
      resolvedProtocol = await args.herdrProtocol();
    }
    return resolvedProtocol;
  }

  // Use the same verified backend decision for browser navigation and rendering.
  async function navigationMode(): Promise<"browser-local" | "shared"> {
    return isTerminalHelloProtocol(await bridgeProtocol()) &&
      args.lookupPaneId &&
      roamgateEnv("DISABLE_ENDPOINT") !== "1"
      ? "browser-local"
      : "shared";
  }

  const terminalCoalesceKey = (terminalId: string) =>
    `terminal:${JSON.stringify([
      args.connectionId ?? null,
      args.connectionGeneration ?? null,
      terminalId,
    ])}`;

  const serialize = (message: Record<string, unknown>) =>
    args.connectionId
      ? serializeConnectionEnvelope(
          args.connectionId,
          message,
          args.connectionGeneration,
        )
      : JSON.stringify(message);
  const formatError =
    args.formatError ??
    ((error: unknown) =>
      (error instanceof Error ? error.message : String(error))
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, "?")
        .trim()
        .slice(0, 300));

  function isCurrent(revision: number) {
    return !disposed && lifecycleRevision === revision;
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KiB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MiB`;
  }

  function forwardClipboard(data: string, terminalId?: string) {
    if (disposed) return;
    if (!isTerminalClipboardPayload(data)) {
      logger.warn("dropped invalid terminal clipboard payload", {
        connection: args.connectionId ?? "legacy-default",
      });
      return;
    }

    const now = Date.now();
    const recentTarget =
      clipboardTarget &&
      now - clipboardTarget.inputAt <= CLIPBOARD_INPUT_WINDOW_MS &&
      !clipboardTarget.session.thin.isClosed &&
      sharedTerminals.get(clipboardTarget.terminalId) ===
        clipboardTarget.session &&
      terminalViewers
        .get(clipboardTarget.ws)
        ?.has(clipboardTarget.terminalId) &&
      (!terminalId || clipboardTarget.terminalId === terminalId)
        ? clipboardTarget
        : null;
    if (!recentTarget) {
      logger.warn("dropped terminal clipboard without recent input", {
        connection: args.connectionId ?? "legacy-default",
        terminal: terminalId,
      });
      return;
    }
    const targetTerminalId = recentTarget.terminalId;
    const target = recentTarget.ws;

    const payload = serialize({
      terminal_clipboard: {
        terminal_id: targetTerminalId,
        data,
      },
    });
    logger.debug("terminal clipboard", {
      connection: args.connectionId ?? "legacy-default",
      terminal: targetTerminalId,
      payload: formatBytes(data.length),
      target: args.clientLabel(target),
    });
    args.safeSend(target, payload, "terminal-clipboard");
  }

  function closeClipboardRelay() {
    clipboardTarget = null;
    clipboardRelay?.close();
    clipboardRelay = null;
    clipboardRelayConnecting = null;
    clipboardRelaySize = null;
    clipboardRelayRevision += 1;
  }

  // The clipboard relay doubles as the server's foreground app client, whose
  // size drives the shared pane-runtime resize cascade for every background
  // tab. Keep it pinned to the active tab's projected full-layout viewport so
  // individual split panes cannot drag the shared geometry to their own size.
  function syncClipboardRelaySize(cols: number, rows: number) {
    if (!clipboardRelay || clipboardRelay.isClosed) return false;
    if (
      clipboardRelaySize?.cols === cols &&
      clipboardRelaySize?.rows === rows
    ) {
      return false;
    }
    clipboardRelaySize = { cols, rows };
    clipboardRelay.resize(cols, rows);
    return true;
  }

  async function resizeClipboardRelayAndConfirm(
    cols: number,
    rows: number,
    paneId: string | null,
  ) {
    if (!clipboardRelay || clipboardRelay.isClosed) return false;
    syncClipboardRelaySize(cols, rows);
    return args.confirmRelayResize
      ? args.confirmRelayResize({ cols, rows, paneId })
      : false;
  }

  function relaySizeFromParams(
    params: Record<string, unknown>,
    fallback: { cols: number; rows: number },
  ): { cols: number; rows: number } | null {
    // New clients explicitly mark inactive split panes so a single app relay
    // is sized only by the browser's active pane. Missing flags retain
    // compatibility with older embedded frontends.
    if (params.relay_active === false) return null;
    const cols = Number(params.relay_cols);
    const rows = Number(params.relay_rows);
    if (
      Number.isInteger(cols) &&
      Number.isInteger(rows) &&
      cols > 0 &&
      rows > 0 &&
      cols <= 65_535 &&
      rows <= 65_535
    ) {
      return { cols, rows };
    }
    return fallback;
  }

  function browserClientCountChanged(count: number) {
    if (disposed) return;
    // The relay outlives individual terminal attaches on purpose: reconnecting
    // it on every tab switch makes it flap the server's foreground client,
    // which reflows every pane runtime through the UI pane geometry (sidebar
    // and tab bar inset) and shows up as visible width jumps. Once no browser
    // is connected the relay has no consumer and can go away.
    if (count === 0) closeClipboardRelay();
  }

  function ensureClipboardRelay(cols: number, rows: number) {
    if (disposed) throw new Error("terminal bridge disposed");
    if (clipboardRelaySkipped) return Promise.resolve();
    if (clipboardRelay && !clipboardRelay.isClosed) {
      return clipboardRelayConnecting ?? Promise.resolve();
    }

    const connecting = (async () => {
      // Tagged Herdr 0.9.0 (protocol 22) routes client-local side effects such as
      // OSC 52 only to the foreground *shell* (endpoint-protocol) client;
      // direct terminal connections like this relay are never foreground and
      // can never receive ServerMessage::Clipboard there. Skip the relay and
      // use the endpoint session's clipboard events instead. Only the explicit
      // legacy fallback still lacks OSC 52; browser copy/paste is unaffected.
      const protocol = await args.herdrProtocol();
      if (disposed) return;
      if (isTerminalHelloProtocol(protocol)) {
        clipboardRelaySkipped = true;
        if (!args.lookupPaneId || roamgateEnv("DISABLE_ENDPOINT") === "1") {
          logger.warn(
            "terminal-program OSC 52 unavailable on the legacy fallback: Herdr protocol 22 routes clipboard only to endpoint shell clients; browser copy/paste is unaffected",
            { connection: args.connectionId ?? "legacy-default" },
          );
        }
        return;
      }

      const relay = new ThinClient(args.clientSocketPath, args.herdrProtocol);
      clipboardRelay = relay;
      clipboardRelaySize = { cols, rows };
      relay.on("clipboard", ({ data }) => {
        if (clipboardRelay === relay && !relay.isClosed) forwardClipboard(data);
      });
      relay.on("error", (error) =>
        logger.warn("clipboard relay error", {
          connection: args.connectionId ?? "legacy-default",
          error: formatError(error),
        }),
      );
      relay.on("close", () => {
        if (clipboardRelay !== relay) return;
        clipboardRelay = null;
        clipboardRelayConnecting = null;
        clipboardRelaySize = null;
      });

      // Herdr before protocol 22 routes client-local side effects such as
      // OSC 52 only to its foreground app client. Direct terminal attachments
      // intentionally cannot receive them, so keep one lightweight app
      // connection while terminals are being viewed and route its clipboard
      // messages back to the input owner.
      await relay
        .connect(cols, rows, { launchMode: "app", encoding: 1 })
        .then(() => {
          if (disposed) {
            relay.close();
            return;
          }
          logger.debug("clipboard relay connected", {
            connection: args.connectionId ?? "legacy-default",
          });
        })
        .catch((error) => {
          if (clipboardRelay === relay) {
            clipboardRelay = null;
            clipboardRelaySize = null;
          }
          if (!disposed && sharedTerminals.size > 0) {
            logger.warn("clipboard relay connection failed", {
              connection: args.connectionId ?? "legacy-default",
              error: formatError(error),
            });
          }
        });
    })().finally(() => {
      if (clipboardRelayConnecting === connecting) {
        clipboardRelayConnecting = null;
      }
    });
    clipboardRelayConnecting = connecting;
    return connecting;
  }

  async function waitForClipboardRelay(
    cols: number,
    rows: number,
    revision?: number,
  ) {
    const connecting = ensureClipboardRelay(cols, rows);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    await Promise.race([
      connecting,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, CLIPBOARD_RELAY_READY_WAIT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (disposed) return false;
    if (timedOut) {
      logger.debug("clipboard relay still connecting", {
        connection: args.connectionId ?? "legacy-default",
      });
      return false;
    }
    if (!clipboardRelay || clipboardRelay.isClosed) return false;
    if (revision !== undefined && revision !== clipboardRelayRevision) {
      return false;
    }
    // A concurrent active viewer may have requested a newer viewport while
    // this relay was connecting. Apply the latest requested size once ready.
    syncClipboardRelaySize(cols, rows);
    return true;
  }

  async function waitForTerminalFirstFrame(
    shared: SharedTerminalSession,
  ): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    const seen = await Promise.race([
      shared.firstFrame,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve(false);
        }, TERMINAL_FIRST_FRAME_WAIT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) {
      logger.warn("terminal first frame still pending", {
        connection: args.connectionId ?? "legacy-default",
        terminal: shared.terminalId,
        clipboard_relay: "deferred",
      });
    }
    return seen;
  }

  async function syncClipboardRelayAfterAttach(
    shared: SharedTerminalSession,
    size: { cols: number; rows: number },
    revision: number,
  ) {
    // The first direct terminal frame is the protocol-level evidence that
    // Herdr processed AttachTerminal and installed its resize lock. Only then
    // may the app-mode relay become foreground or resize the shared layout.
    if (!(await waitForTerminalFirstFrame(shared)) || disposed) return;
    // A newer tab switch/resize owns the relay now; never let this delayed
    // attach move it back to a stale tab's viewport.
    if (revision !== clipboardRelayRevision) return;
    if (clipboardRelay && !clipboardRelay.isClosed) {
      syncClipboardRelaySize(size.cols, size.rows);
      return;
    }
    await waitForClipboardRelay(size.cols, size.rows, revision);
  }

  function detachTerminalViewer(
    ws: ServerWebSocket<unknown>,
    terminalId?: string | null,
    expectedSession?: SharedTerminalSession | null,
  ) {
    const current = terminals.get(ws);
    const viewed = terminalViewers.get(ws);
    const terminalIds = terminalId
      ? [terminalId]
      : Array.from(
          viewed?.keys() ?? (current?.terminalId ? [current.terminalId] : []),
        );
    for (const id of terminalIds) {
      attachmentTokens.get(ws)?.delete(id);
      if (clipboardTarget?.ws === ws && clipboardTarget.terminalId === id) {
        clipboardTarget = null;
      }
      const shared = sharedTerminals.get(id);
      if (
        shared &&
        (expectedSession === undefined || shared === expectedSession)
      ) {
        shared.viewers.delete(ws);
        if (shared.viewers.size === 0) {
          shared.thin.close();
          if (sharedTerminals.get(id) === shared) sharedTerminals.delete(id);
        }
      }
      viewed?.delete(id);
    }
    if (!viewed || viewed.size === 0) {
      terminalViewers.delete(ws);
      attachmentTokens.delete(ws);
      terminals.delete(ws);
      if (clipboardTarget?.ws === ws) clipboardTarget = null;
      return;
    }
    if (current?.terminalId && !viewed.has(current.terminalId)) {
      terminals.set(ws, {
        terminalId: Array.from(viewed.keys())[viewed.size - 1] ?? null,
        cols: current.cols,
        rows: current.rows,
      });
    }
  }

  async function getSharedTerminal(
    terminalId: string,
    cols: number,
    rows: number,
    isAttachCurrent: () => boolean,
    surfaceSize?: { cols: number; rows: number },
  ): Promise<SharedTerminalSession> {
    if (disposed) throw new Error("terminal bridge disposed");
    const creationRevision = lifecycleRevision;
    // Resolve before checking the map so concurrent attaches for the same
    // terminal cannot double-create while the first resolution is in flight.
    const settingsRevision = surfaceSettingsRevision;
    const mode = await navigationMode();
    const surfaceCodecsEnabled =
      mode === "browser-local"
        ? await (args.surfaceCodecsEnabled?.() ?? true)
        : false;
    if (!isCurrent(creationRevision))
      throw new Error("terminal bridge disposed");
    if (!isAttachCurrent()) throw new Error("terminal attachment changed");
    if (settingsRevision !== surfaceSettingsRevision)
      return getSharedTerminal(
        terminalId,
        cols,
        rows,
        isAttachCurrent,
        surfaceSize,
      );
    const existing = sharedTerminals.get(terminalId);
    if (existing && !existing.thin.isClosed) return existing;
    if (existing) {
      existing.thin.close();
      sharedTerminals.delete(terminalId);
    }

    const thin =
      mode === "browser-local" && args.lookupPaneId
        ? new EndpointTerminalSession(
            args.clientSocketPath,
            terminalId,
            args.lookupPaneId,
            logger,
            undefined,
            surfaceCodecsEnabled,
          )
        : new ThinClient(args.clientSocketPath, args.herdrProtocol);
    let resolveFirstFrame!: (seen: boolean) => void;
    const firstFrame = new Promise<boolean>((resolve) => {
      resolveFirstFrame = resolve;
    });
    const shared: SharedTerminalSession = {
      thin,
      connecting: null,
      firstFrame,
      resolveFirstFrame,
      terminalId,
      cols,
      rows,
      viewers: new Set(),
      frames: 0,
      bytes: 0,
      firstFrameLogged: false,
      lastFrameLogAt: 0,
      lastError: null,
    };
    sharedTerminals.set(terminalId, shared);
    logger.debug("terminal stream connecting", {
      connection: args.connectionId ?? "legacy-default",
      terminal: terminalId,
      size: `${cols}x${rows}`,
      socket: args.clientSocketPath,
    });

    thin.on("terminal", (t) => {
      const resolve = shared.resolveFirstFrame;
      if (resolve) {
        shared.resolveFirstFrame = null;
        resolve(true);
      }
      if (!isCurrent(creationRevision)) return;
      shared.frames += 1;
      shared.bytes += t.bytes.length;
      const now = Date.now();
      if (!shared.firstFrameLogged || now - shared.lastFrameLogAt >= 30_000) {
        logger.debug("terminal frame", {
          connection: args.connectionId ?? "legacy-default",
          terminal: terminalId,
          size: `${t.width}x${t.height}`,
          full: t.full,
          frames: shared.frames,
          bytes: formatBytes(shared.bytes),
          viewers: shared.viewers.size,
        });
        shared.firstFrameLogged = true;
        shared.lastFrameLogAt = now;
      }
      const payloads = new Map<string, string>();
      for (const viewer of Array.from(shared.viewers)) {
        const viewport = terminalViewers.get(viewer)?.get(terminalId);
        if (!viewport) {
          shared.viewers.delete(viewer);
          continue;
        }
        const width = t.frame ? Math.min(t.width, viewport.cols) : t.width;
        const height = t.frame ? Math.min(t.height, viewport.rows) : t.height;
        const key = `${width}x${height}`;
        let payload = payloads.get(key);
        if (!payload) {
          const bytes =
            t.frame && (width !== t.width || height !== t.height)
              ? frameToAnsi(t.frame, viewport)
              : t.bytes;
          payload = serialize({
            terminal: {
              terminal_id: terminalId,
              width,
              height,
              full: t.full,
              ...(t.linkFrame ? { link_frame: t.linkFrame } : {}),
              ...(typeof t.mouseReporting === "boolean"
                ? { mouse_reporting: t.mouseReporting }
                : {}),
              ...(t.history &&
              width === t.history.cols &&
              height === t.history.rows
                ? { history: t.history }
                : {}),
              bytes: Buffer.from(bytes).toString("base64"),
            },
          });
          payloads.set(key, payload);
        }
        // Only endpoint streams always repaint the full surface. Holding even
        // a full legacy frame lets later incremental frames overtake their base.
        args.safeSend(
          viewer,
          payload,
          "terminal-frame",
          thin instanceof EndpointTerminalSession && t.full
            ? terminalCoalesceKey(terminalId)
            : undefined,
        );
      }
    });
    // Bind to the receiving session, NOT the producing PTY: Herdr 0.9.0 sends
    // clipboard to its foreground shell without source attribution. The global
    // recent input owner must still match this session; never broadcast.
    thin.on("clipboard", ({ data }) => {
      if (
        isCurrent(creationRevision) &&
        !thin.isClosed &&
        sharedTerminals.get(terminalId) === shared
      ) {
        forwardClipboard(data, terminalId);
      }
    });
    thin.on("welcome", (w) => {
      logger.debug("terminal stream welcome", {
        connection: args.connectionId ?? "legacy-default",
        terminal: terminalId,
        version: w.version,
        encoding: w.encoding,
        error: w.error ? formatError(w.error) : undefined,
      });
    });
    thin.on("error", (error) => {
      shared.lastError = formatError(error);
      logger.warn("terminal stream error", {
        connection: args.connectionId ?? "legacy-default",
        terminal: formatError(terminalId),
        error: formatError(error),
      });
    });
    thin.on("close", () => {
      if (clipboardTarget?.session === shared) clipboardTarget = null;
      const resolve = shared.resolveFirstFrame;
      if (resolve) {
        shared.resolveFirstFrame = null;
        resolve(false);
      }
      logger.debug("terminal stream closed", {
        connection: args.connectionId ?? "legacy-default",
        terminal: terminalId,
        frames: shared.frames,
        bytes: formatBytes(shared.bytes),
      });
      if (sharedTerminals.get(terminalId)?.thin === thin) {
        sharedTerminals.delete(terminalId);
      }
      // Herdr closes a direct attach whose terminal another client takes
      // over, and the stream can also die with the server. Viewers only see
      // silence otherwise, so tell them to re-attach instead of leaving a
      // blank terminal behind.
      if (isCurrent(creationRevision) && shared.viewers.size > 0) {
        logger.warn("terminal stream closed with live viewers", {
          connection: args.connectionId ?? "legacy-default",
          terminal: terminalId,
          viewers: shared.viewers.size,
        });
        const closedPayload = serialize({
          terminal_closed: {
            terminal_id: terminalId,
            reason: shared.lastError ?? "stream_closed",
          },
        });
        for (const viewer of Array.from(shared.viewers)) {
          args.safeSend(viewer, closedPayload, "terminal-closed");
        }
      }
    });
    const terminalReady = (
      thin instanceof ThinClient
        ? thin
            .connect(cols, rows, { launchMode: "terminal-attach", encoding: 1 })
            .then(() => {
              if (!isCurrent(creationRevision)) {
                thin.close();
                throw new Error("terminal bridge disposed");
              }
              thin.attach(terminalId, true);
            })
        : thin.connect(cols, rows, surfaceSize)
    ).then(() => {
      if (!isCurrent(creationRevision)) {
        thin.close();
        throw new Error("terminal bridge disposed");
      }
    });
    shared.connecting = terminalReady
      .then(() => undefined)
      .catch((e) => {
        if (sharedTerminals.get(terminalId)?.thin === thin) {
          sharedTerminals.delete(terminalId);
        }
        throw e;
      })
      .finally(() => {
        if (sharedTerminals.get(terminalId)?.thin === thin) {
          const current = sharedTerminals.get(terminalId);
          if (current) current.connecting = null;
        }
      });
    return shared;
  }

  async function waitForOwnedTerminal(
    ws: ServerWebSocket<unknown>,
    terminalId: string,
    shared: SharedTerminalSession,
    requestIsCurrent: () => boolean,
  ): Promise<() => void> {
    const token = attachmentTokens.get(ws)?.get(terminalId);
    const revision = lifecycleRevision;
    const validate = () => {
      if (
        !requestIsCurrent() ||
        !isCurrent(revision) ||
        !token ||
        attachmentTokens.get(ws)?.get(terminalId) !== token ||
        !terminalViewers.get(ws)?.has(terminalId) ||
        sharedTerminals.get(terminalId) !== shared ||
        shared.thin.isClosed
      ) {
        throw new Error(
          "Source terminal attachment changed; retry after it reconnects.",
        );
      }
    };
    validate();
    if (shared.connecting) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          shared.connecting,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    "Source terminal is still connecting; retry when ready.",
                  ),
                ),
              20_000,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    validate();
    return validate;
  }

  async function createFromTerminal(
    ws: ServerWebSocket<unknown>,
    method: "tab.create" | "workspace.create",
    params: Record<string, unknown>,
    requestIsCurrent: () => boolean,
  ) {
    const deadline = new EndpointCreationDeadline();
    return deadline.wait(
      (async () => {
        if ((await navigationMode()) !== "browser-local")
          throw new Error("Client-scoped creation requires Herdr endpoints.");
        deadline.assertBeforeDispatch();
        if (method === "workspace.create" && params.browser_source === null) {
          if (!args.createEmptyWorkspace)
            throw new Error("Empty-session creation is unavailable.");
          return args.createEmptyWorkspace(
            params,
            () => !disposed && requestIsCurrent(),
            deadline,
          );
        }
        const source = parseEndpointCreationSource(params.browser_source);
        if (
          method === "tab.create" &&
          params.workspace_id !== source.workspace_id
        ) {
          throw new Error(
            "Creation source does not belong to the requested workspace.",
          );
        }
        const shared = sharedTerminals.get(source.terminal_id);
        if (!shared || !(shared.thin instanceof EndpointTerminalSession)) {
          throw new Error(
            "Open the source terminal tab and wait for it to connect before creating.",
          );
        }
        const validateAttachment = await waitForOwnedTerminal(
          ws,
          source.terminal_id,
          shared,
          requestIsCurrent,
        );
        const creationParams = { ...params };
        delete creationParams.browser_source;
        const result = await shared.thin.create(
          method,
          {
            ...creationParams,
            ...(method === "workspace.create"
              ? { source_workspace_id: source.workspace_id }
              : {}),
            focus: false,
          },
          source.pane_id,
          async () => {
            validateAttachment();
            if (!args.validateCreationSource)
              throw new Error("Creation source validation is unavailable.");
            await args.validateCreationSource(source);
            validateAttachment();
          },
          deadline,
        );
        return result;
      })(),
    );
  }

  async function handleTerminalRpc(
    ws: ServerWebSocket<unknown>,
    id: string,
    method: string,
    params: Record<string, unknown>,
    requestIsCurrent: () => boolean = () => true,
  ) {
    const fail = (message: string) => {
      const effectiveMessage = requestIsCurrent()
        ? message
        : CONNECTION_CHANGED_DURING_REQUEST;
      args.markRpcError(ws, id, effectiveMessage);
      return args.safeSend(
        ws,
        serialize({ id, error: { message: effectiveMessage } }),
        `${method}-error`,
      );
    };
    const reply = (result: unknown) =>
      requestIsCurrent()
        ? args.safeSend(ws, serialize({ id, result }), method)
        : fail(CONNECTION_CHANGED_DURING_REQUEST);
    try {
      if (!requestIsCurrent()) return fail(CONNECTION_CHANGED_DURING_REQUEST);
      if (disposed) return fail("terminal bridge disposed");
      const operationRevision = lifecycleRevision;
      if (method === "terminal.attach") {
        const terminalId = String(params.terminal_id ?? "");
        const cols = Number(params.cols ?? 100);
        const rows = Number(params.rows ?? 30);
        if (!terminalId) return fail("terminal_id required");
        let surfaceSize: { cols: number; rows: number } | undefined;
        if (
          params.surface_cols !== undefined ||
          params.surface_rows !== undefined
        ) {
          const surfaceCols = params.surface_cols;
          const surfaceRows = params.surface_rows;
          if (
            typeof surfaceCols !== "number" ||
            typeof surfaceRows !== "number" ||
            !Number.isInteger(surfaceCols) ||
            !Number.isInteger(surfaceRows) ||
            surfaceCols < 1 ||
            surfaceCols > 65_535 ||
            surfaceRows < 1 ||
            surfaceRows > 65_535
          )
            return fail(
              "surface_cols and surface_rows must be integers between 1 and 65535",
            );
          surfaceSize = { cols: surfaceCols, rows: surfaceRows };
        }
        const relaySize = relaySizeFromParams(params, { cols, rows });
        const relayRevision = relaySize ? ++clipboardRelayRevision : null;

        const existingShared = sharedTerminals.get(terminalId);
        const sharedMode =
          existingShared && !existingShared.thin.isClosed ? "reused" : "new";
        const viewed = terminalViewers.get(ws) ?? new Map();
        const refreshReusedTerminal =
          sharedMode === "reused" &&
          !existingShared?.connecting &&
          !viewed.has(terminalId) &&
          existingShared?.cols === cols &&
          existingShared.rows === rows;
        terminals.set(ws, { terminalId, cols, rows });
        viewed.set(terminalId, { cols, rows });
        terminalViewers.set(ws, viewed);
        const tokens = attachmentTokens.get(ws) ?? new Map<string, object>();
        const token = {};
        tokens.set(terminalId, token);
        attachmentTokens.set(ws, tokens);
        const ownsAttempt = () =>
          attachmentTokens.get(ws)?.get(terminalId) === token;
        const attemptIsCurrent = () =>
          ownsAttempt() && requestIsCurrent() && isCurrent(operationRevision);
        let shared: SharedTerminalSession | null = null;
        try {
          shared = await getSharedTerminal(
            terminalId,
            cols,
            rows,
            attemptIsCurrent,
            surfaceSize,
          );
          if (attemptIsCurrent()) shared.viewers.add(ws);
          await shared.connecting;
          const validate = () => {
            if (!isCurrent(operationRevision))
              throw new Error("terminal bridge disposed");
            if (
              !attemptIsCurrent() ||
              sharedTerminals.get(terminalId) !== shared ||
              shared.thin.isClosed
            )
              throw new Error("terminal attachment changed");
          };
          validate();
          if (
            shared.cols !== cols ||
            shared.rows !== rows ||
            refreshReusedTerminal
          ) {
            // A reused idle stream still needs a complete frame for a new viewer.
            shared.thin.resize(cols, rows);
            shared.cols = cols;
            shared.rows = rows;
            // This resize changes the surface for EVERY viewer, so any frame
            // held under backpressure is now the wrong size for all of them.
            for (const viewer of shared.viewers)
              args.dropCoalesced?.(viewer, terminalCoalesceKey(terminalId));
            logger.debug(
              refreshReusedTerminal ? "terminal refreshed" : "terminal resized",
              {
                connection: args.connectionId ?? "legacy-default",
                client: args.clientLabel(ws),
                terminal: terminalId,
                size: `${cols}x${rows}`,
              },
            );
          }
          if (relaySize && relayRevision !== null) {
            await syncClipboardRelayAfterAttach(
              shared,
              relaySize,
              relayRevision,
            );
          }
          validate();
          logger.debug("terminal attached", {
            connection: args.connectionId ?? "legacy-default",
            client: args.clientLabel(ws),
            terminal: terminalId,
            viewers: shared.viewers.size,
            size: `${cols}x${rows}`,
            shared: sharedMode,
          });
          return reply({
            ok: true,
            ...(shared.thin instanceof EndpointTerminalSession
              ? { endpoint: shared.thin.negotiation }
              : {}),
          });
        } catch (e) {
          // A superseded attach must not detach its replacement's viewer.
          if (ownsAttempt()) detachTerminalViewer(ws, terminalId, shared);
          throw e;
        }
      }

      if (method === "terminal.relay_resize") {
        const cols = Number(params.cols);
        const rows = Number(params.rows);
        if (
          !Number.isInteger(cols) ||
          !Number.isInteger(rows) ||
          cols <= 0 ||
          rows <= 0 ||
          cols > 65_535 ||
          rows > 65_535
        ) {
          return fail("valid relay cols and rows required");
        }
        const paneId =
          typeof params.pane_id === "string" && params.pane_id
            ? params.pane_id
            : null;
        clipboardRelayRevision += 1;
        const confirmed = await resizeClipboardRelayAndConfirm(
          cols,
          rows,
          paneId,
        );
        if (!isCurrent(operationRevision)) {
          return fail("terminal bridge disposed");
        }
        return reply({ ok: true, confirmed });
      }

      const session = terminals.get(ws);
      const requestedTerminalId =
        typeof params.terminal_id === "string" && params.terminal_id
          ? params.terminal_id
          : session?.terminalId;
      const ownsRequestedTerminal = requestedTerminalId
        ? terminalViewers.get(ws)?.has(requestedTerminalId) === true
        : false;
      const shared =
        requestedTerminalId && ownsRequestedTerminal
          ? sharedTerminals.get(requestedTerminalId)
          : null;
      const thin = shared?.thin;
      if (method === "terminal.detach") {
        detachTerminalViewer(ws, requestedTerminalId ?? null);
        logger.debug("terminal detached", {
          connection: args.connectionId ?? "legacy-default",
          client: args.clientLabel(ws),
          terminal: requestedTerminalId ?? "none",
          viewers:
            requestedTerminalId && sharedTerminals.has(requestedTerminalId)
              ? sharedTerminals.get(requestedTerminalId)?.viewers.size
              : 0,
        });
        return reply({ ok: true });
      }
      if (method === "terminal.focus") {
        if (!thin || thin.isClosed || !shared || !requestedTerminalId) {
          return fail(NO_TERMINAL_ATTACHED_MESSAGE);
        }
        // Legacy streams already have their own per-terminal cursor.
        if (!(thin instanceof EndpointTerminalSession))
          return reply({ ok: true });
        const intent = {};
        const token = attachmentTokens.get(ws)?.get(requestedTerminalId);
        focusIntents.set(ws, intent);
        const run = async () => {
          if (focusIntents.get(ws) !== intent) return;
          const validateAttachment = await waitForOwnedTerminal(
            ws,
            requestedTerminalId,
            shared,
            () =>
              requestIsCurrent() &&
              attachmentTokens.get(ws)?.get(requestedTerminalId) === token,
          );
          await thin.focus(() => {
            validateAttachment();
            return focusIntents.get(ws) === intent;
          });
        };
        const previous = focusChains.get(ws) ?? Promise.resolve();
        const task = previous.then(run, run);
        focusChains.set(ws, task);
        try {
          await task;
        } finally {
          if (focusChains.get(ws) === task) focusChains.delete(ws);
          if (focusIntents.get(ws) === intent) focusIntents.delete(ws);
        }
        return reply({ ok: true });
      }
      if (method === "terminal.link.resolve") {
        if (
          !(thin instanceof EndpointTerminalSession) ||
          !shared ||
          !requestedTerminalId
        )
          return fail(NO_TERMINAL_ATTACHED_MESSAGE);
        const { frame, row, col } = params;
        const viewport = terminalViewers.get(ws)?.get(requestedTerminalId);
        if (
          typeof frame !== "string" ||
          typeof row !== "number" ||
          typeof col !== "number" ||
          !Number.isInteger(row) ||
          !Number.isInteger(col) ||
          row < 0 ||
          col < 0 ||
          !viewport ||
          row >= viewport.rows ||
          col >= viewport.cols
        )
          return fail("Valid terminal link frame and cell required");
        const validate = await waitForOwnedTerminal(
          ws,
          requestedTerminalId,
          shared,
          requestIsCurrent,
        );
        const result = await thin.resolveLink(frame, row, col);
        validate();
        return reply({
          ...result,
          regions: result.regions
            .filter((r) => r.row < viewport.rows && r.start_col < viewport.cols)
            .map((r) => ({
              ...r,
              end_col: Math.min(r.end_col, viewport.cols - 1),
            })),
        });
      }
      if (method === "terminal.input") {
        if (!thin || thin.isClosed || !shared || !requestedTerminalId) {
          return fail(NO_TERMINAL_ATTACHED_MESSAGE);
        }
        const b64 = String(params.data ?? "");
        if (!b64 || !STANDARD_BASE64_RE.test(b64)) {
          return fail("invalid terminal input");
        }
        const input = Buffer.from(b64, "base64");
        if (input.length === 0) return fail("terminal input required");
        const validateAttachment = await waitForOwnedTerminal(
          ws,
          requestedTerminalId,
          shared,
          requestIsCurrent,
        );
        // Even a ready terminal yields above; recheck at the side-effect boundary.
        validateAttachment();
        clipboardTarget = {
          ws,
          terminalId: requestedTerminalId,
          inputAt: Date.now(),
          session: shared,
        };
        thin.input(input);
        return reply({ ok: true });
      }
      if (method === "terminal.resize") {
        if (!thin || !shared) return fail(NO_TERMINAL_ATTACHED_MESSAGE);
        const cols = Number(params.cols ?? 100);
        const rows = Number(params.rows ?? 30);
        const relaySize = relaySizeFromParams(params, { cols, rows });
        thin.resize(cols, rows);
        terminalViewers.get(ws)!.set(requestedTerminalId!, { cols, rows });
        shared.cols = cols;
        shared.rows = rows;
        // Anything held for this terminal was rendered for the previous size.
        args.dropCoalesced?.(ws, terminalCoalesceKey(requestedTerminalId!));
        if (relaySize) {
          clipboardRelayRevision += 1;
          syncClipboardRelaySize(relaySize.cols, relaySize.rows);
        }
        logger.debug("terminal resized", {
          connection: args.connectionId ?? "legacy-default",
          client: args.clientLabel(ws),
          terminal: requestedTerminalId ?? "none",
          size: `${cols}x${rows}`,
        });
        return reply({ ok: true });
      }
      if (method === "terminal.scroll") {
        if (!thin) return fail(NO_TERMINAL_ATTACHED_MESSAGE);
        const direction = params.direction === "up" ? "up" : "down";
        const lines = Number(params.lines ?? 3);
        const column =
          typeof params.column === "number" ? Number(params.column) : null;
        const row = typeof params.row === "number" ? Number(params.row) : null;
        if (
          params.source === "page-key" &&
          thin instanceof EndpointTerminalSession
        ) {
          // Version gate: EndpointTerminalSession requires the endpoint to
          // speak shell.input.semantic.v1 at handshake (Herdr >= 0.9.0),
          // which routes PageUp/PageDown by PTY modes. Older endpoints never
          // reach this branch; they keep the legacy scroll routing below.
          if (!shared || !requestedTerminalId)
            return fail(NO_TERMINAL_ATTACHED_MESSAGE);
          const validateAttachment = await waitForOwnedTerminal(
            ws,
            requestedTerminalId,
            shared,
            requestIsCurrent,
          );
          validateAttachment();
          // Herdr chooses application input versus shell scrollback from the
          // actual PTY modes. pane.scroll always means history and bypasses nano.
          thin.input(Buffer.from(direction === "up" ? "\x1b[5~" : "\x1b[6~"));
          return reply({ ok: true });
        }
        // Explicit half-page shortcuts use pane.scroll on endpoints, while
        // legacy AttachScroll keeps its original Wheel source and line count.
        const source =
          params.source === "page-key" ||
          (params.source === "history" &&
            thin instanceof EndpointTerminalSession)
            ? "page-key"
            : "wheel";
        thin.scroll(direction, lines, column, row, source);
        return reply({ ok: true });
      }
      return fail(`unknown terminal method: ${method}`);
    } catch (e) {
      return fail((e as Error).message);
    }
  }

  function cleanupWs(ws: ServerWebSocket<unknown>) {
    focusIntents.delete(ws);
    focusChains.delete(ws);
    detachTerminalViewer(ws);
  }

  function viewedTerminals(ws: ServerWebSocket<unknown>): string[] {
    return Array.from(terminalViewers.get(ws)?.keys() ?? []);
  }

  function endpointAvailability() {
    return Object.fromEntries(
      Array.from(sharedTerminals, ([id, session]) => [
        id,
        session.thin instanceof EndpointTerminalSession
          ? session.thin.negotiation
          : null,
      ]),
    );
  }

  function statusTerminals() {
    return Array.from(sharedTerminals.values()).map((session) => ({
      terminal_id: session.terminalId,
      viewers: session.viewers.size,
    }));
  }

  function refreshSurfaceCodecs() {
    if (disposed) return;
    surfaceSettingsRevision += 1;
    for (const shared of sharedTerminals.values()) {
      if (!(shared.thin instanceof EndpointTerminalSession)) continue;
      shared.lastError = "terminal_configuration_changed";
      shared.thin.close();
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    lifecycleRevision += 1;
    closeClipboardRelay();
    for (const shared of sharedTerminals.values()) shared.thin.close();
    sharedTerminals.clear();
    terminalViewers.clear();
    attachmentTokens.clear();
    focusIntents.clear();
    focusChains.clear();
    terminals.clear();
  }

  return {
    createFromTerminal,
    navigationMode,
    endpointAvailability,
    handleTerminalRpc,
    cleanupWs,
    viewedTerminals,
    statusTerminals,
    browserClientCountChanged,
    refreshSurfaceCodecs,
    dispose,
  };
}

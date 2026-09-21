import {
  validateRemoteSocketPath,
  validateSshDestination,
} from "./sshProfileValidation";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export type ConnectionLifecycleState =
  | "disconnected"
  | "connecting"
  | "ready"
  | "reconnecting"
  | "stopping"
  | "error";

export interface ConnectionSummary {
  id: string;
  label: string;
  source: string;
  is_default: boolean;
  state: ConnectionLifecycleState;
  generation: number;
  error?: { message: string };
  /** Present in profile-aware catalogs; optional during legacy bridge.status transition. */
  type?: "local" | "ssh";
  read_only?: boolean;
  auto_connect?: boolean;
  control_socket_path?: string;
  client_socket_path?: string;
  ssh_destination?: string;
  remote_control_socket_path?: string;
  remote_client_socket_path?: string;
}

const CONNECTION_LIFECYCLE_STATES = new Set<ConnectionLifecycleState>([
  "disconnected",
  "connecting",
  "ready",
  "reconnecting",
  "stopping",
  "error",
]);

/** Parse the public catalog boundary without trusting arbitrary WebSocket JSON. */
export function parseConnectionSummary(
  value: unknown,
): ConnectionSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== "string" ||
    item.id.length === 0 ||
    typeof item.label !== "string" ||
    typeof item.source !== "string" ||
    typeof item.is_default !== "boolean" ||
    typeof item.state !== "string" ||
    !CONNECTION_LIFECYCLE_STATES.has(item.state as ConnectionLifecycleState) ||
    typeof item.generation !== "number" ||
    !Number.isSafeInteger(item.generation) ||
    item.generation < 0
  ) {
    return null;
  }
  if (item.type !== undefined && item.type !== "local" && item.type !== "ssh") {
    return null;
  }
  if (item.type === "local") {
    if (
      typeof item.read_only !== "boolean" ||
      typeof item.auto_connect !== "boolean" ||
      typeof item.control_socket_path !== "string" ||
      !item.control_socket_path ||
      typeof item.client_socket_path !== "string" ||
      !item.client_socket_path ||
      item.ssh_destination !== undefined ||
      item.remote_control_socket_path !== undefined ||
      item.remote_client_socket_path !== undefined
    ) {
      return null;
    }
  }
  if (item.type === "ssh") {
    if (
      typeof item.read_only !== "boolean" ||
      typeof item.auto_connect !== "boolean" ||
      item.control_socket_path !== undefined ||
      item.client_socket_path !== undefined
    ) {
      return null;
    }
    try {
      const destination = validateSshDestination(item.ssh_destination);
      const controlPath = validateRemoteSocketPath(
        item.remote_control_socket_path,
        "Remote control socket",
      );
      const clientPath = validateRemoteSocketPath(
        item.remote_client_socket_path,
        "Remote render socket",
      );
      if (
        (controlPath && clientPath && controlPath === clientPath) ||
        !destination
      )
        return null;
    } catch {
      return null;
    }
  }
  const error =
    item.error &&
    typeof item.error === "object" &&
    !Array.isArray(item.error) &&
    typeof (item.error as { message?: unknown }).message === "string"
      ? { message: (item.error as { message: string }).message }
      : undefined;
  return {
    id: item.id,
    label: item.label,
    source: item.source,
    is_default: item.is_default,
    state: item.state as ConnectionLifecycleState,
    generation: item.generation,
    ...(error ? { error } : {}),
    ...(item.type === "local" || item.type === "ssh"
      ? { type: item.type }
      : {}),
    ...(typeof item.read_only === "boolean"
      ? { read_only: item.read_only }
      : {}),
    ...(typeof item.auto_connect === "boolean"
      ? { auto_connect: item.auto_connect }
      : {}),
    ...(typeof item.control_socket_path === "string"
      ? { control_socket_path: item.control_socket_path }
      : {}),
    ...(typeof item.client_socket_path === "string"
      ? { client_socket_path: item.client_socket_path }
      : {}),
    ...(typeof item.ssh_destination === "string"
      ? { ssh_destination: item.ssh_destination }
      : {}),
    ...(typeof item.remote_control_socket_path === "string"
      ? { remote_control_socket_path: item.remote_control_socket_path }
      : {}),
    ...(typeof item.remote_client_socket_path === "string"
      ? { remote_client_socket_path: item.remote_client_socket_path }
      : {}),
  };
}

export interface BridgeHello {
  hello: true;
  socket?: string;
  bridge_protocol_version: number;
  default_connection_id: string;
  capabilities: {
    connection_id?: boolean;
    connection_scoped_http?: boolean;
    connection_runtime_generation?: boolean;
    [key: string]: unknown;
  };
}

export interface HerdrEventMsg {
  connection_id: string;
  connection_generation?: number;
  event: string;
  /** Some Herdr events (e.g. pane.agent_status_changed) omit data.type. */
  data: { type?: string; [k: string]: unknown };
}

export interface TerminalPush {
  connection_id: string;
  connection_generation?: number;
  terminal_id: string;
  width: number;
  height: number;
  full: boolean;
  /** Present only for endpoint full pane repaints; absent on legacy streams. */
  mouse_reporting?: boolean;
  /** Opaque identity from this terminal socket's advertised read-only resolver. */
  link_frame?: string;
  /** Absolute rows of a complete endpoint pane viewport. */
  history?: import("./terminalHistorySelection").TerminalHistoryViewport;
  /** base64-encoded ANSI bytes */
  bytes: string;
}

export interface TerminalClipboardPush {
  connection_id: string;
  connection_generation?: number;
  terminal_id: string;
  /** Standard base64 text emitted by Herdr's Clipboard server message. */
  data: string;
}

export interface PopupStatePush {
  connection_id: string;
  connection_generation?: number;
  popup: {
    terminal_id: string;
    title: string;
    width: { kind: "cells" | "percent"; value: number } | null;
    height: { kind: "cells" | "percent"; value: number } | null;
  } | null;
}

function isValidPopupSize(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const size = value as Record<string, unknown>;
  return (
    (size.kind === "cells" || size.kind === "percent") &&
    typeof size.value === "number"
  );
}

function isValidPopupPayload(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const popup = value as Record<string, unknown>;
  return (
    typeof popup.terminal_id === "string" &&
    popup.terminal_id.length > 0 &&
    typeof popup.title === "string" &&
    isValidPopupSize(popup.width) &&
    isValidPopupSize(popup.height)
  );
}

export interface TerminalClosedPush {
  connection_id: string;
  connection_generation?: number;
  terminal_id: string;
  reason?: string;
}

export interface BridgeControlMsg {
  type: "pause_connection";
  reason?: string;
}

type Pending = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  connectionId: string | null;
  clientGeneration: number;
  serverRuntimeGeneration: number | null;
};

export interface ConnectionClient {
  readonly connectionId: string;
  readonly generation: number;
  readonly serverRuntimeGeneration: number | null;
  call(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number | null,
  ): Promise<any>;
  isCurrent(): boolean;
  acceptsServerGeneration(value: unknown): boolean;
}

const LEGACY_DEFAULT_CONNECTION_ID = "legacy-default";
const RPC_TIMEOUT_MS = 30000;
const CONNECT_TIMEOUT_MS = 8000;
const HEARTBEAT_INTERVAL_MS = 10000;
const HEARTBEAT_TIMEOUT_MS = 6000;
const MAX_WS_BUFFERED_BYTES = 4 * 1024 * 1024;

export function isBridgeGlobalMethod(method: string): boolean {
  return method.startsWith("bridge.") || method.startsWith("connections.");
}

export async function logoutBrowserSession(): Promise<void> {
  const response = await fetch("/api/logout", {
    method: "POST",
    credentials: "same-origin",
    headers: { "x-roamgate-logout": "1" },
  });
  if (!response.ok) throw new Error("Could not log out. Please try again.");
  location.replace("/login");
}

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

function scopedPayload<T extends object>(
  connectionId: unknown,
  connectionGeneration: unknown,
  payload: T,
  requireGeneration: boolean,
): (T & { connection_id: string; connection_generation?: number }) | null {
  if (typeof connectionId !== "string" || connectionId.length === 0) {
    return null;
  }
  const validGeneration =
    typeof connectionGeneration === "number" &&
    Number.isSafeInteger(connectionGeneration) &&
    connectionGeneration >= 0;
  if (requireGeneration && !validGeneration) return null;
  return {
    ...payload,
    connection_id: connectionId,
    ...(validGeneration ? { connection_generation: connectionGeneration } : {}),
  };
}

function isBridgeHello(value: unknown): value is BridgeHello {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (
    message.hello !== true ||
    !Number.isSafeInteger(message.bridge_protocol_version) ||
    typeof message.default_connection_id !== "string" ||
    message.default_connection_id.length === 0 ||
    !message.capabilities ||
    typeof message.capabilities !== "object" ||
    Array.isArray(message.capabilities)
  ) {
    return false;
  }
  for (const field of [
    "connection_id",
    "connection_generation",
    "id",
    "result",
    "error",
    "event",
    "control",
    "terminal",
    "terminal_clipboard",
  ]) {
    if (Object.prototype.hasOwnProperty.call(message, field)) return false;
  }
  const capabilities = message.capabilities as Record<string, unknown>;
  for (const capability of [
    "connection_id",
    "connection_scoped_http",
    "connection_runtime_generation",
  ]) {
    const value = capabilities[capability];
    if (value !== undefined && typeof value !== "boolean") return false;
  }
  return true;
}

/**
 * Client for the local herdr-gui bridge (WebSocket).
 *
 * Downstream RPC: { id, method, params, connection_id }
 * Global RPC:     { id, method, params }
 * Scoped replies and pushes carry a top-level connection_id.
 */
export class Bridge {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<string, Pending>();
  private eventHandlers = new Set<(e: HerdrEventMsg) => void>();
  private terminalHandlers = new Set<(t: TerminalPush) => void>();
  private terminalClipboardHandlers = new Set<
    (clipboard: TerminalClipboardPush) => void
  >();
  private terminalClosedHandlers = new Set<
    (closed: TerminalClosedPush) => void
  >();
  private popupHandlers = new Set<(popup: PopupStatePush) => void>();
  private statusHandlers = new Set<(s: ConnectionStatus) => void>();
  private controlHandlers = new Set<(c: BridgeControlMsg) => void>();
  private helloHandlers = new Set<(hello: BridgeHello) => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatInFlight = false;
  private reconnectEnabled = true;
  private _status: ConnectionStatus = "disconnected";
  private _activeConnectionId = LEGACY_DEFAULT_CONNECTION_ID;
  private _clientGeneration = 0;
  private _hello: BridgeHello | null = null;
  private helloAcceptedForSocket = false;
  private readonly runtimeGenerations = new Map<string, number>();

  constructor(
    private readonly connectTimeoutMs = CONNECT_TIMEOUT_MS,
    private readonly reconnectDelayMs = 1500,
  ) {}

  get status() {
    return this._status;
  }

  get activeConnectionId() {
    return this._activeConnectionId;
  }

  get clientGeneration() {
    return this._clientGeneration;
  }

  get hello() {
    return this._hello;
  }

  setConnectionRuntimeGenerations(
    connections: Array<Pick<ConnectionSummary, "id" | "generation">>,
  ): void {
    this.runtimeGenerations.clear();
    for (const connection of connections) {
      this.runtimeGenerations.set(connection.id, connection.generation);
    }
  }

  private pushGenerationMatches(
    connectionId: unknown,
    connectionGeneration: unknown,
  ): boolean {
    if (!this.helloAcceptedForSocket) return false;
    if (this._hello?.capabilities?.connection_runtime_generation !== true) {
      return true;
    }
    return (
      typeof connectionId === "string" &&
      this.runtimeGenerations.get(connectionId) === connectionGeneration
    );
  }

  /**
   * Advance the browser-side routing lease. Scoped requests from the previous
   * lease are rejected so their replies cannot publish into the new session.
   */
  setActiveConnection(connectionId: string): number {
    if (!connectionId) throw new Error("invalid connection_id");
    if (connectionId === this._activeConnectionId)
      return this._clientGeneration;
    this._activeConnectionId = connectionId;
    return this.advanceActiveConnectionGeneration();
  }

  /** Invalidate scoped clients after same-ID runtime replacement/reconnect. */
  advanceActiveConnectionGeneration(): number {
    this._clientGeneration += 1;
    this.rejectPending(
      "connection changed during request",
      (pending) => pending.connectionId !== null,
    );
    return this._clientGeneration;
  }

  connection(
    connectionId = this._activeConnectionId,
    serverRuntimeGeneration: number | null = null,
  ): ConnectionClient {
    const generation = this._clientGeneration;
    const requiresRuntimeGeneration = () =>
      this._hello?.capabilities?.connection_runtime_generation === true;
    const acceptsServerGeneration = (value: unknown) =>
      !requiresRuntimeGeneration() ||
      (serverRuntimeGeneration !== null && value === serverRuntimeGeneration);
    return {
      connectionId,
      generation,
      serverRuntimeGeneration,
      call: (method, params = {}, timeoutMs = RPC_TIMEOUT_MS) => {
        if (!this.helloAcceptedForSocket) {
          return Promise.reject(new Error("bridge hello is unavailable"));
        }
        if (
          generation !== this._clientGeneration ||
          connectionId !== this._activeConnectionId
        ) {
          return Promise.reject(new Error("connection changed during request"));
        }
        if (
          requiresRuntimeGeneration() &&
          (serverRuntimeGeneration === null ||
            this.runtimeGenerations.get(connectionId) !==
              serverRuntimeGeneration)
        ) {
          return Promise.reject(
            new Error("connection runtime generation is unavailable"),
          );
        }
        return this.callScoped(
          connectionId,
          generation,
          serverRuntimeGeneration,
          method,
          params,
          timeoutMs,
        );
      },
      isCurrent: () =>
        this.helloAcceptedForSocket &&
        generation === this._clientGeneration &&
        connectionId === this._activeConnectionId &&
        (!requiresRuntimeGeneration() ||
          (serverRuntimeGeneration !== null &&
            this.runtimeGenerations.get(connectionId) ===
              serverRuntimeGeneration)),
      acceptsServerGeneration,
    };
  }

  private setStatus(s: ConnectionStatus) {
    if (this._status === s) return;
    this._status = s;
    this.statusHandlers.forEach((h) => h(s));
  }

  connect() {
    this.reconnectEnabled = true;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.setStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      this.handleDisconnect(null, "bridge connection could not be opened");
      return;
    }
    this.ws = ws;
    this.helloAcceptedForSocket = false;
    this.connectTimer = setTimeout(() => {
      if (this.ws !== ws || this.helloAcceptedForSocket) return;
      this.forceReconnect(
        ws.readyState === WebSocket.CONNECTING
          ? "bridge connection timed out"
          : "bridge hello timed out",
      );
    }, this.connectTimeoutMs);

    ws.onopen = () => {
      // A TCP/WebSocket open is not a usable bridge connection. Keep the
      // connecting state and deadline until a valid, unscoped hello arrives.
      if (this.ws !== ws) return;
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.onMessage(ev.data);
    };
    ws.onerror = () => {
      // onclose will handle reconnect.
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      if (event?.code === 4001) {
        this.disconnect("logged out");
        // Clear the shared cookie in every tab before navigating. A close frame
        // can arrive before the initiating tab receives its logout response.
        void logoutBrowserSession().catch(() => location.replace("/login"));
        return;
      }
      this.handleDisconnect(ws, "bridge disconnected");
    };
  }

  disconnect(reason = "bridge connection paused") {
    this.reconnectEnabled = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    this._hello = null;
    this.helloAcceptedForSocket = false;
    this.clearConnectTimer();
    this.stopHeartbeat();
    this.advanceActiveConnectionGeneration();
    this.rejectPending(reason);
    if (ws) {
      try {
        ws.close(1000, reason.slice(0, 120));
      } catch {
        // Ignore close errors; the socket is already considered inactive.
      }
    }
    this.setStatus("disconnected");
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.runHeartbeatProbe();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private runHeartbeatProbe() {
    if (this.heartbeatInFlight) return;
    this.heartbeatInFlight = true;
    this.call("bridge.ping", {}, HEARTBEAT_TIMEOUT_MS).then(
      () => {
        this.heartbeatInFlight = false;
      },
      () => {
        this.heartbeatInFlight = false;
        // A rejected ping can also arrive because the socket was already
        // torn down (rejectPending during handleDisconnect). Only a live
        // connection may be force-reconnected; otherwise the extra
        // handleDisconnect would advance the client generation a second
        // time without a status transition, silently desyncing every
        // generation-scoped client captured at the first transition.
        if (this._status === "connected") {
          this.forceReconnect("bridge heartbeat timed out");
        }
      },
    );
  }

  /**
   * Probes a seemingly connected socket right away. Mobile operating systems
   * can kill the WebSocket while the page is frozen without ever delivering
   * a close event, so on a foreground resume the next scheduled heartbeat
   * tick would be the first time a dead connection is noticed.
   */
  probeConnectionNow() {
    if (this._status !== "connected") return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // The close event never fired (the OS froze the page first), so drop
      // the stale socket instead of waiting for the heartbeat interval.
      this.forceReconnect("bridge socket is no longer open");
      return;
    }
    this.runHeartbeatProbe();
  }

  private stopHeartbeat() {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.heartbeatInFlight = false;
  }

  private clearConnectTimer() {
    if (!this.connectTimer) return;
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private rejectPending(
    message: string,
    predicate: (pending: Pending) => boolean = () => true,
  ) {
    for (const [id, pending] of this.pending) {
      if (!predicate(pending)) continue;
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.reject(new Error(message));
      this.pending.delete(id);
    }
  }

  private handleDisconnect(ws: WebSocket | null, reason: string) {
    if (ws && this.ws !== ws) return;
    // Defense in depth: once fully torn down, handleDisconnect is
    // idempotent. Stale close events are filtered by the socket-identity
    // check above and the heartbeat probe only force-reconnects a live
    // connection, but no current or future forceReconnect path may advance
    // the client generation twice without a status transition: listeners
    // captured the first advance and would never learn the second.
    if (!ws && this.ws === null && this._status === "disconnected") return;
    this.ws = null;
    this._hello = null;
    this.helloAcceptedForSocket = false;
    this.clearConnectTimer();
    this.stopHeartbeat();
    this.advanceActiveConnectionGeneration();
    this.setStatus("disconnected");
    this.rejectPending(reason);
    if (this.reconnectEnabled && !this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, this.reconnectDelayMs);
    }
  }

  private forceReconnect(reason: string) {
    const ws = this.ws;
    if (ws) {
      try {
        ws.close(4000, reason.slice(0, 120));
      } catch {
        // Some browsers throw if the close reason is not accepted.
      }
    }
    this.handleDisconnect(ws, reason);
  }

  private onMessage(raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    // pi-lens-ignore: no-unsafe-dictionary-any
    const msg = parsed as Record<string, any>;
    const owns = (field: string) =>
      Object.prototype.hasOwnProperty.call(msg, field);
    const hasHello = owns("hello");
    const hasReply = owns("id") || owns("result") || owns("error");
    const hasEvent = owns("event");
    const hasTerminal = owns("terminal");
    const hasClipboard = owns("terminal_clipboard");
    const hasTerminalClosed = owns("terminal_closed");
    const hasPopup = owns("popup");
    const hasControl = owns("control");
    const kindCount = [
      hasHello,
      hasReply,
      hasEvent,
      hasTerminal,
      hasClipboard,
      hasTerminalClosed,
      hasPopup,
      hasControl,
    ].filter(Boolean).length;
    if (kindCount !== 1) return;

    if (hasHello) {
      if (this.helloAcceptedForSocket || !isBridgeHello(msg)) return;
      this.helloAcceptedForSocket = true;
      this._hello = msg;
      this.clearConnectTimer();
      if (this._activeConnectionId === LEGACY_DEFAULT_CONNECTION_ID) {
        this.setActiveConnection(msg.default_connection_id);
      }
      this.helloHandlers.forEach((handler) => handler(msg));
      this.setStatus("connected");
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.startHeartbeat();
      return;
    }

    if (!this.helloAcceptedForSocket) return;

    if (hasReply) {
      const hasResult = owns("result");
      const hasError = owns("error");
      if (
        typeof msg.id !== "string" ||
        !this.pending.has(msg.id) ||
        hasResult === hasError
      ) {
        return;
      }
      const pending = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (pending.timer !== null) clearTimeout(pending.timer);
      const requiresRuntimeGeneration =
        this._hello?.capabilities?.connection_runtime_generation === true;
      if (
        pending.connectionId === null &&
        (owns("connection_id") || owns("connection_generation"))
      ) {
        pending.reject(
          new Error("global response contains connection identity"),
        );
      } else if (
        pending.connectionId !== null &&
        msg.connection_id !== pending.connectionId
      ) {
        pending.reject(new Error("response connection_id mismatch"));
      } else if (
        pending.connectionId !== null &&
        requiresRuntimeGeneration &&
        msg.connection_generation !== pending.serverRuntimeGeneration
      ) {
        pending.reject(new Error("response connection_generation mismatch"));
      } else if (
        pending.connectionId !== null &&
        pending.clientGeneration !== this._clientGeneration
      ) {
        pending.reject(new Error("connection changed during request"));
      } else if (
        hasError &&
        (!msg.error ||
          typeof msg.error !== "object" ||
          typeof msg.error.message !== "string")
      ) {
        pending.reject(new Error("invalid error response"));
      } else if (hasError) {
        pending.reject(new Error(msg.error.message));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (hasEvent) {
      if (
        typeof msg.event !== "string" ||
        !msg.data ||
        typeof msg.data !== "object" ||
        Array.isArray(msg.data) ||
        !this.pushGenerationMatches(
          msg.connection_id,
          msg.connection_generation,
        )
      ) {
        return;
      }
      const event = scopedPayload(
        msg.connection_id,
        msg.connection_generation,
        { event: msg.event, data: msg.data },
        this._hello?.capabilities?.connection_runtime_generation === true,
      );
      if (event) this.eventHandlers.forEach((handler) => handler(event));
      return;
    }

    if (hasTerminal) {
      if (
        !msg.terminal ||
        typeof msg.terminal !== "object" ||
        typeof msg.terminal.terminal_id !== "string" ||
        msg.terminal.terminal_id.length === 0 ||
        typeof msg.terminal.width !== "number" ||
        !Number.isSafeInteger(msg.terminal.width) ||
        msg.terminal.width < 0 ||
        typeof msg.terminal.height !== "number" ||
        !Number.isSafeInteger(msg.terminal.height) ||
        msg.terminal.height < 0 ||
        typeof msg.terminal.full !== "boolean" ||
        typeof msg.terminal.bytes !== "string" ||
        !this.pushGenerationMatches(
          msg.connection_id,
          msg.connection_generation,
        )
      ) {
        return;
      }
      const terminal = scopedPayload(
        msg.connection_id,
        msg.connection_generation,
        msg.terminal,
        this._hello?.capabilities?.connection_runtime_generation === true,
      );
      if (terminal) {
        this.terminalHandlers.forEach((handler) => handler(terminal));
      }
      return;
    }

    if (hasClipboard) {
      if (
        !msg.terminal_clipboard ||
        typeof msg.terminal_clipboard !== "object" ||
        typeof msg.terminal_clipboard.terminal_id !== "string" ||
        msg.terminal_clipboard.terminal_id.length === 0 ||
        typeof msg.terminal_clipboard.data !== "string" ||
        !this.pushGenerationMatches(
          msg.connection_id,
          msg.connection_generation,
        )
      ) {
        return;
      }
      const clipboard = scopedPayload(
        msg.connection_id,
        msg.connection_generation,
        msg.terminal_clipboard,
        this._hello?.capabilities?.connection_runtime_generation === true,
      );
      if (clipboard) {
        this.terminalClipboardHandlers.forEach((handler) => handler(clipboard));
      }
      return;
    }

    if (hasTerminalClosed) {
      if (
        !msg.terminal_closed ||
        typeof msg.terminal_closed !== "object" ||
        typeof msg.terminal_closed.terminal_id !== "string" ||
        msg.terminal_closed.terminal_id.length === 0 ||
        !this.pushGenerationMatches(
          msg.connection_id,
          msg.connection_generation,
        )
      ) {
        return;
      }
      const closed = scopedPayload(
        msg.connection_id,
        msg.connection_generation,
        msg.terminal_closed,
        this._hello?.capabilities?.connection_runtime_generation === true,
      );
      if (closed) {
        this.terminalClosedHandlers.forEach((handler) => handler(closed));
      }
      return;
    }

    if (hasPopup) {
      if (
        !isValidPopupPayload(msg.popup) ||
        !this.pushGenerationMatches(
          msg.connection_id,
          msg.connection_generation,
        )
      ) {
        return;
      }
      const popup = scopedPayload(
        msg.connection_id,
        msg.connection_generation,
        { popup: msg.popup },
        this._hello?.capabilities?.connection_runtime_generation === true,
      );
      if (popup) this.popupHandlers.forEach((handler) => handler(popup));
      return;
    }

    if (
      msg.control &&
      typeof msg.control === "object" &&
      typeof msg.control.type === "string"
    ) {
      this.controlHandlers.forEach((handler) =>
        handler(msg.control as BridgeControlMsg),
      );
    }
  }

  private sendCall(
    connectionId: string | null,
    clientGeneration: number,
    serverRuntimeGeneration: number | null,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number | null,
  ): Promise<any> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("not connected to bridge"));
    }
    if (ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
      this.forceReconnect("bridge send buffer is full");
      return Promise.reject(new Error("bridge send buffer is full"));
    }
    const id = `c${++this.seq}_${Date.now().toString(36)}`;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              if (this.pending.delete(id)) {
                reject(new Error(`timeout: ${method}`));
              }
            }, timeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        connectionId,
        clientGeneration,
        serverRuntimeGeneration,
      });
      try {
        ws.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(connectionId === null
              ? {}
              : {
                  connection_id: connectionId,
                  ...(serverRuntimeGeneration === null
                    ? {}
                    : { connection_generation: serverRuntimeGeneration }),
                }),
          }),
        );
      } catch (error) {
        if (timer !== null) clearTimeout(timer);
        this.pending.delete(id);
        this.forceReconnect("bridge send failed");
        reject(error as Error);
      }
    });
  }

  private callScoped(
    connectionId: string,
    generation: number,
    serverRuntimeGeneration: number | null,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number | null,
  ): Promise<any> {
    if (isBridgeGlobalMethod(method)) {
      return Promise.reject(
        new Error(`global RPC cannot use a connection client: ${method}`),
      );
    }
    return this.sendCall(
      connectionId,
      generation,
      serverRuntimeGeneration,
      method,
      params,
      timeoutMs,
    );
  }

  /**
   * Compatibility entry point. Global methods remain global; every downstream
   * method is explicitly scoped to the current browser routing lease.
   */
  call(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number | null = RPC_TIMEOUT_MS,
  ): Promise<any> {
    if (isBridgeGlobalMethod(method)) {
      return this.sendCall(
        null,
        this._clientGeneration,
        null,
        method,
        params,
        timeoutMs,
      );
    }
    if (!this.helloAcceptedForSocket) {
      return Promise.reject(new Error("bridge hello is unavailable"));
    }
    const serverRuntimeGeneration =
      this._hello?.capabilities?.connection_runtime_generation === true
        ? (this.runtimeGenerations.get(this._activeConnectionId) ?? null)
        : null;
    if (
      this._hello?.capabilities?.connection_runtime_generation === true &&
      serverRuntimeGeneration === null
    ) {
      return Promise.reject(
        new Error("connection runtime generation is unavailable"),
      );
    }
    return this.callScoped(
      this._activeConnectionId,
      this._clientGeneration,
      serverRuntimeGeneration,
      method,
      params,
      timeoutMs,
    );
  }

  onHello(cb: (hello: BridgeHello) => void): () => void {
    this.helloHandlers.add(cb);
    if (this._hello) cb(this._hello);
    return () => this.helloHandlers.delete(cb);
  }

  onEvent(cb: (event: HerdrEventMsg) => void): () => void {
    this.eventHandlers.add(cb);
    return () => this.eventHandlers.delete(cb);
  }

  onTerminal(cb: (terminal: TerminalPush) => void): () => void {
    this.terminalHandlers.add(cb);
    return () => this.terminalHandlers.delete(cb);
  }

  onTerminalClipboard(
    cb: (clipboard: TerminalClipboardPush) => void,
  ): () => void {
    this.terminalClipboardHandlers.add(cb);
    return () => this.terminalClipboardHandlers.delete(cb);
  }

  onPopup(cb: (popup: PopupStatePush) => void): () => void {
    this.popupHandlers.add(cb);
    return () => this.popupHandlers.delete(cb);
  }

  onTerminalClosed(cb: (closed: TerminalClosedPush) => void): () => void {
    this.terminalClosedHandlers.add(cb);
    return () => this.terminalClosedHandlers.delete(cb);
  }

  onStatus(cb: (status: ConnectionStatus) => void): () => void {
    this.statusHandlers.add(cb);
    cb(this._status);
    return () => this.statusHandlers.delete(cb);
  }

  onControl(cb: (control: BridgeControlMsg) => void): () => void {
    this.controlHandlers.add(cb);
    return () => this.controlHandlers.delete(cb);
  }
}

export const bridge = new Bridge();

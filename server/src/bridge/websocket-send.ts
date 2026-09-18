import { serverLogger } from "../utils/logger";

export const WS_BACKPRESSURE_LIMIT_BYTES = 8 * 1024 * 1024;
export const WS_COALESCE_LIMIT_BYTES = 1024 * 1024;

const websocketLogger = serverLogger.child("websocket");

// Terminal frames are self-contained repaints, so a frame still waiting to be
// written carries nothing the next frame will not carry as well. Once a viewer
// falls behind, keep only the newest frame per terminal and send it when the
// socket drains. Queueing every repaint instead is what walks the buffer up to
// WS_BACKPRESSURE_LIMIT_BYTES and disconnects a viewer that is merely slow.
const heldPayloads = new WeakMap<WebSocketSendTarget, Map<string, string>>();

interface WebSocketSendTarget {
  close(code?: number, reason?: string): void;
  getBufferedAmount(): number;
  send(payload: string): number;
}

interface WebSocketSendOptions {
  cleanup: () => void;
  // Set for payloads that fully replace an earlier one with the same key, so a
  // backlogged socket can drop the earlier one instead of queueing both.
  coalesceKey?: string;
  context?: string;
  warn?: (message: string) => void;
}

interface WebSocketSendContext {
  cleanup: () => void;
  context: string;
  warn: (message: string) => void;
}

interface WebSocketCloseOptions {
  code?: number;
  context: string;
  reason?: string;
  warn: (message: string) => void;
}

export class WebSocketCleanupTracker<Socket extends object, Snapshot> {
  private readonly snapshots = new WeakMap<Socket, Snapshot>();

  constructor(private readonly performCleanup: (socket: Socket) => Snapshot) {}

  cleanup(socket: Socket): Snapshot {
    if (this.snapshots.has(socket)) {
      return this.snapshots.get(socket) as Snapshot;
    }
    const snapshot = this.performCleanup(socket);
    this.snapshots.set(socket, snapshot);
    return snapshot;
  }

  complete(socket: Socket): Snapshot {
    const snapshot = this.cleanup(socket);
    this.snapshots.delete(socket);
    return snapshot;
  }
}

function closeWebSocket(
  ws: Pick<WebSocketSendTarget, "close">,
  { code, context, reason, warn }: WebSocketCloseOptions,
): void {
  try {
    if (code === undefined) ws.close();
    else ws.close(code, reason);
  } catch (error) {
    warn(
      `[bridge] websocket close failed during ${context}: ${(error as Error).message}`,
    );
  }
}

function closeSlowWebSocket(
  ws: WebSocketSendTarget,
  { cleanup, context, warn }: WebSocketSendContext,
): boolean {
  const bufferedAmount = ws.getBufferedAmount();
  if (
    !Number.isFinite(bufferedAmount) ||
    bufferedAmount <= WS_BACKPRESSURE_LIMIT_BYTES
  ) {
    return false;
  }

  warn(
    `[bridge] closing slow websocket during ${context}: ${bufferedAmount}B buffered`,
  );
  cleanup();
  closeWebSocket(ws, {
    code: 1013,
    context,
    reason: "client too slow",
    warn,
  });
  return true;
}

export function sendWebSocketMessage(
  ws: WebSocketSendTarget,
  payload: string,
  {
    cleanup,
    coalesceKey,
    context = "message",
    warn = (message) =>
      websocketLogger.warn("send failed", {
        detail: message.replace(/^\[bridge\] /, ""),
      }),
  }: WebSocketSendOptions,
): boolean {
  const sendContext = { cleanup, context, warn };
  if (coalesceKey !== undefined) {
    const held = heldPayloads.get(ws);
    if (ws.getBufferedAmount() > WS_COALESCE_LIMIT_BYTES) {
      if (held) held.set(coalesceKey, payload);
      else heldPayloads.set(ws, new Map([[coalesceKey, payload]]));
      return true;
    }
    held?.delete(coalesceKey);
  }
  try {
    if (closeSlowWebSocket(ws, sendContext)) return false;

    const result = ws.send(payload);
    if (result === 0) {
      cleanup();
      warn(`[bridge] websocket send dropped during ${context}`);
      closeWebSocket(ws, { context, warn });
      return false;
    }
    if (result === -1 && closeSlowWebSocket(ws, sendContext)) return false;
    return true;
  } catch (error) {
    cleanup();
    warn(
      `[bridge] websocket send failed during ${context}: ${(error as Error).message}`,
    );
    closeWebSocket(ws, { context, warn });
    return false;
  }
}

// Drop a held payload that has gone stale. A frame is sized for the surface it
// was rendered against, so once that surface resizes the held frame paints a
// partial screen: short by the rows and columns the surface gained. A resize
// makes the terminal emit a fresh frame anyway, so dropping the held one loses
// nothing and is the only way to avoid painting the stale size.
export function dropCoalescedMessage(
  ws: WebSocketSendTarget,
  coalesceKey: string,
): void {
  heldPayloads.get(ws)?.delete(coalesceKey);
}

// Send the frames held back while the socket was behind. Call this when the
// socket drains. Each held payload is the newest repaint for its terminal, so
// one send per key restores the viewer to the current surface.
export function flushCoalescedMessages(
  ws: WebSocketSendTarget,
  {
    cleanup,
    context = "terminal-frame",
    warn,
  }: Omit<WebSocketSendOptions, "coalesceKey">,
): void {
  const held = heldPayloads.get(ws);
  if (!held?.size) return;
  const entries = Array.from(held);
  held.clear();
  for (const [coalesceKey, payload] of entries) {
    const sent = sendWebSocketMessage(ws, payload, {
      cleanup,
      coalesceKey,
      context,
      warn,
    });
    // A failed send has already closed the socket; stop rather than retry.
    if (!sent) return;
  }
}

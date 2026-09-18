import { describe, expect, test } from "bun:test";
import {
  dropCoalescedMessage,
  flushCoalescedMessages,
  sendWebSocketMessage,
  WS_BACKPRESSURE_LIMIT_BYTES,
  WS_COALESCE_LIMIT_BYTES,
  WebSocketCleanupTracker,
} from "./websocket-send";

function createWebSocket({
  bufferedAmount = 0,
  bufferedAmounts,
  sendResult = 1,
  sendError,
}: {
  bufferedAmount?: number;
  bufferedAmounts?: number[];
  sendResult?: number;
  sendError?: Error;
} = {}) {
  const sent: string[] = [];
  const closes: Array<[number | undefined, string | undefined]> = [];
  const closeArgumentCounts: number[] = [];
  const queuedAmounts = [...(bufferedAmounts ?? [bufferedAmount])];
  let lastBufferedAmount = bufferedAmount;
  return {
    closeArgumentCounts,
    closes,
    sent,
    ws: {
      close(code?: number, reason?: string) {
        closeArgumentCounts.push(arguments.length);
        closes.push([code, reason]);
      },
      getBufferedAmount() {
        lastBufferedAmount = queuedAmounts.shift() ?? lastBufferedAmount;
        return lastBufferedAmount;
      },
      send(payload: string) {
        sent.push(payload);
        if (sendError) throw sendError;
        return sendResult;
      },
    },
  };
}

function sendWithObservability(
  ws: ReturnType<typeof createWebSocket>["ws"],
  context = "terminal frame",
) {
  let cleanupCount = 0;
  const warnings: string[] = [];
  const result = sendWebSocketMessage(ws, "payload", {
    cleanup: () => {
      cleanupCount += 1;
    },
    context,
    warn: (message) => warnings.push(message),
  });
  return { cleanupCount, result, warnings };
}

describe("browser WebSocket cleanup", () => {
  test("preserves the first cleanup snapshot until close handling completes", () => {
    const socket = {};
    let cleanupCount = 0;
    const cleanup = new WebSocketCleanupTracker((socketToCleanup) => {
      expect(socketToCleanup).toBe(socket);
      cleanupCount += 1;
      return { client: "c1", viewedTerminals: ["term_1"] };
    });

    const firstSnapshot = cleanup.cleanup(socket);
    expect(cleanup.cleanup(socket)).toBe(firstSnapshot);
    expect(cleanup.complete(socket)).toBe(firstSnapshot);
    expect(cleanupCount).toBe(1);

    expect(cleanup.cleanup(socket)).not.toBe(firstSnapshot);
    expect(cleanupCount).toBe(2);
  });
});

describe("browser WebSocket sending", () => {
  test("keeps the connection open when Bun queues a message under backpressure", () => {
    for (const sendResult of [-1, 7]) {
      const { closes, sent, ws } = createWebSocket({ sendResult });
      const outcome = sendWithObservability(ws);

      expect(outcome).toEqual({ cleanupCount: 0, result: true, warnings: [] });
      expect(sent).toEqual(["payload"]);
      expect(closes).toEqual([]);
    }
  });

  test("closes a slow connection when a queued send crosses the buffer limit", () => {
    const bufferedAmount = WS_BACKPRESSURE_LIMIT_BYTES + 1;
    const { closes, sent, ws } = createWebSocket({
      bufferedAmounts: [0, bufferedAmount],
      sendResult: -1,
    });
    const outcome = sendWithObservability(ws);

    expect(outcome).toEqual({
      cleanupCount: 1,
      result: false,
      warnings: [
        `[bridge] closing slow websocket during terminal frame: ${bufferedAmount}B buffered`,
      ],
    });
    expect(sent).toEqual(["payload"]);
    expect(closes).toEqual([[1013, "client too slow"]]);
  });

  test("cleans up when Bun drops a message because of a connection issue", () => {
    const { closeArgumentCounts, closes, sent, ws } = createWebSocket({
      sendResult: 0,
    });
    const outcome = sendWithObservability(ws, "workspace event");

    expect(outcome).toEqual({
      cleanupCount: 1,
      result: false,
      warnings: ["[bridge] websocket send dropped during workspace event"],
    });
    expect(sent).toEqual(["payload"]);
    expect(closes).toEqual([[undefined, undefined]]);
    expect(closeArgumentCounts).toEqual([0]);
  });

  test("uses Bun's buffered amount API to close a persistently slow client", () => {
    const bufferedAmount = WS_BACKPRESSURE_LIMIT_BYTES + 1;
    const { closes, sent, ws } = createWebSocket({ bufferedAmount });
    const outcome = sendWithObservability(ws);

    expect(outcome).toEqual({
      cleanupCount: 1,
      result: false,
      warnings: [
        `[bridge] closing slow websocket during terminal frame: ${bufferedAmount}B buffered`,
      ],
    });
    expect(sent).toEqual([]);
    expect(closes).toEqual([[1013, "client too slow"]]);
  });

  test("logs and cleans up when sending throws", () => {
    const { closes, sent, ws } = createWebSocket({
      sendError: new Error("socket closed"),
    });
    const outcome = sendWithObservability(ws);

    expect(outcome).toEqual({
      cleanupCount: 1,
      result: false,
      warnings: [
        "[bridge] websocket send failed during terminal frame: socket closed",
      ],
    });
    expect(sent).toEqual(["payload"]);
    expect(closes).toEqual([[undefined, undefined]]);
  });
});

describe("terminal frame coalescing under backpressure", () => {
  function sendFrame(
    ws: ReturnType<typeof createWebSocket>["ws"],
    payload: string,
    coalesceKey: string,
  ) {
    return sendWebSocketMessage(ws, payload, {
      cleanup: () => {},
      coalesceKey,
      context: "terminal-frame",
      warn: () => {},
    });
  }

  test("holds a frame back instead of queueing it once the socket is behind", () => {
    const { closes, sent, ws } = createWebSocket({
      bufferedAmount: WS_COALESCE_LIMIT_BYTES + 1,
    });
    expect(sendFrame(ws, "frame-1", "terminal:t1")).toBe(true);
    // Nothing is queued on the socket, and the viewer is not disconnected.
    expect(sent).toEqual([]);
    expect(closes).toEqual([]);
  });

  test("keeps only the newest held frame per key", () => {
    const { sent, ws } = createWebSocket({
      bufferedAmounts: [
        WS_COALESCE_LIMIT_BYTES + 1,
        WS_COALESCE_LIMIT_BYTES + 1,
        0,
      ],
    });
    sendFrame(ws, "frame-1", "terminal:t1");
    sendFrame(ws, "frame-2", "terminal:t1");
    flushCoalescedMessages(ws, { cleanup: () => {}, warn: () => {} });
    // frame-1 is worthless: frame-2 is a complete repaint of the same surface.
    expect(sent).toEqual(["frame-2"]);
  });

  test("keeps held frames for different terminals apart", () => {
    const { sent, ws } = createWebSocket({
      bufferedAmounts: [
        WS_COALESCE_LIMIT_BYTES + 1,
        WS_COALESCE_LIMIT_BYTES + 1,
        0,
        0,
      ],
    });
    sendFrame(ws, "frame-a", "terminal:t1");
    sendFrame(ws, "frame-b", "terminal:t2");
    flushCoalescedMessages(ws, { cleanup: () => {}, warn: () => {} });
    expect(sent.sort()).toEqual(["frame-a", "frame-b"]);
  });

  test("sends immediately while the socket keeps up", () => {
    const { closes, sent, ws } = createWebSocket({ bufferedAmount: 0 });
    expect(sendFrame(ws, "frame-1", "terminal:t1")).toBe(true);
    expect(sent).toEqual(["frame-1"]);
    expect(closes).toEqual([]);
  });

  test("leaves messages without a coalesce key alone", () => {
    const { sent, ws } = createWebSocket({
      bufferedAmount: WS_COALESCE_LIMIT_BYTES + 1,
    });
    const result = sendWebSocketMessage(ws, "rpc-reply", {
      cleanup: () => {},
      context: "file-list",
      warn: () => {},
    });
    // An RPC reply is not a repaint; dropping it would lose the answer.
    expect(result).toBe(true);
    expect(sent).toEqual(["rpc-reply"]);
  });
});

describe("dropping a held frame when it goes stale", () => {
  function backloggedSocket() {
    const sent: string[] = [];
    return {
      sent,
      ws: {
        close: () => {},
        getBufferedAmount: () => WS_COALESCE_LIMIT_BYTES + 1,
        send: (payload: string) => {
          sent.push(payload);
          return payload.length;
        },
      },
    };
  }

  test("a dropped payload is never sent on drain", () => {
    const { ws, sent } = backloggedSocket();
    const opts = { cleanup: () => {}, warn: () => {} };
    sendWebSocketMessage(ws, "stale-100x30", {
      ...opts,
      coalesceKey: "terminal:t1",
    });
    dropCoalescedMessage(ws, "terminal:t1");
    flushCoalescedMessages(ws, opts);
    expect(sent).toEqual([]);
  });

  test("dropping one terminal leaves another terminal's held frame alone", () => {
    const sent: string[] = [];
    let buffered = WS_COALESCE_LIMIT_BYTES + 1;
    const ws = {
      close: () => {},
      getBufferedAmount: () => buffered,
      send: (payload: string) => {
        sent.push(payload);
        return payload.length;
      },
    };
    const opts = { cleanup: () => {}, warn: () => {} };
    sendWebSocketMessage(ws, "t1-frame", {
      ...opts,
      coalesceKey: "terminal:t1",
    });
    sendWebSocketMessage(ws, "t2-frame", {
      ...opts,
      coalesceKey: "terminal:t2",
    });
    dropCoalescedMessage(ws, "terminal:t1");
    // The socket caught up, which is when the drain handler flushes.
    buffered = 0;
    flushCoalescedMessages(ws, opts);
    expect(sent).toEqual(["t2-frame"]);
  });
});

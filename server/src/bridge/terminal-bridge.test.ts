import { afterEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import * as net from "node:net";
import { EventEmitter, once } from "node:events";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { BinReader, BinWriter, encodeFrame } from "./bincode";
import { createTerminalBridge } from "./terminal-bridge";
import { silentLogger } from "../utils/logger";
import {
  flushCoalescedMessages,
  sendWebSocketMessage,
  WS_COALESCE_LIMIT_BYTES,
} from "./websocket-send";

test("explicit half-page history retains legacy Wheel source and line count", async () => {
  const sources: number[] = [];
  const socketPath = await startThinServer({
    onScroll: (reader) => {
      sources.push(reader.variant());
      expect(reader.variant()).toBe(0); // Up
      expect(reader.varint()).toBe(14);
      expect(reader.bool()).toBe(false); // no column
      expect(reader.bool()).toBe(false); // no row
    },
  });
  const ws = {} as ServerWebSocket<unknown>;
  const bridge = createTerminalBridge({
    clientSocketPath: socketPath,
    herdrProtocol: async () => 17,
    safeSend: () => true,
    clientLabel: () => "test",
    markRpcError: () => {},
  });
  try {
    await bridge.handleTerminalRpc(ws, "attach", "terminal.attach", {
      terminal_id: "legacy",
      cols: 80,
      rows: 30,
      relay_active: false,
    });
    bridge.refreshSurfaceCodecs();
    expect(bridge.statusTerminals()).toHaveLength(1);
    await bridge.handleTerminalRpc(ws, "scroll", "terminal.scroll", {
      terminal_id: "legacy",
      direction: "up",
      lines: 14,
      source: "history",
    });
    await Bun.sleep(40);
    expect(sources).toEqual([0]);
  } finally {
    bridge.dispose();
  }
});

const servers: net.Server[] = [];
const serverConnections = new Set<net.Socket>();

afterEach(async () => {
  for (const connection of serverConnections) connection.destroy();
  serverConnections.clear();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

function terminalFrame(width = 100, height = 30, protocol = 17, full = true) {
  const writer = new BinWriter();
  writer.variant(protocol === 22 ? 1 : 2);
  writer.varint(1);
  writer.varint(width);
  writer.varint(height);
  writer.bool(full);
  writer.bytes(Buffer.from("frame"));
  return encodeFrame(writer.toBuffer());
}

function clipboardFrame(data: string) {
  const writer = new BinWriter();
  writer.variant(6);
  writer.string(data);
  return encodeFrame(writer.toBuffer());
}

async function startThinServer(
  options: {
    protocol?: number;
    clipboardData?: string;
    clipboardDelayMs?: number;
    appWelcomeDelayMs?: number;
    appWelcomeError?: string;
    skipAppWelcome?: boolean;
    directClipboardOnResize?: string;
    directFrameDelayMs?: number;
    skipDirectFrame?: boolean;
    onDirectAttach?: (socket: net.Socket) => void;
    onScroll?: (reader: BinReader) => void;
    frameFull?: boolean;
    tracker?: {
      appConnects: number;
      appCloses: number;
      appSizes: string[];
      events: string[];
    };
  } = {},
) {
  const socketPath = path.join(
    tmpdir(),
    `herdr-gui-terminal-bridge-${process.pid}-${crypto.randomUUID()}.sock`,
  );
  let appSocket: net.Socket | null = null;
  const server = net.createServer((socket) => {
    serverConnections.add(socket);
    let input = Buffer.alloc(0);
    let isAppSocket = false;
    let socketCols = 100;
    let socketRows = 30;
    socket.on("close", () => {
      serverConnections.delete(socket);
      if (appSocket === socket) appSocket = null;
      if (isAppSocket && options.tracker) options.tracker.appCloses += 1;
    });
    socket.on("data", (chunk) => {
      input = Buffer.concat([
        input,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      ]);
      while (input.length >= 4) {
        const length = input.readUInt32LE(0);
        if (input.length < length + 4) return;
        const reader = new BinReader(input.subarray(4, length + 4));
        input = input.subarray(length + 4);
        const variant = reader.variant();
        if (variant === 0) {
          const protocol = reader.varint();
          const helloCols = reader.varint();
          const helloRows = reader.varint();
          reader.varint(); // cell width
          reader.varint(); // cell height
          let launchMode = 2;
          if (protocol === 22) {
            expect(reader.bool()).toBe(false); // pixel_mouse
          } else {
            reader.varint(); // encoding
            reader.varint(); // keybindings
            launchMode = reader.varint();
          }
          expect(reader.remaining).toBe(0);
          socketCols = helloCols;
          socketRows = helloRows;
          if (launchMode === 0 && options.tracker) {
            isAppSocket = true;
            options.tracker.appConnects += 1;
            options.tracker.appSizes.push(`${helloCols}x${helloRows}`);
            options.tracker.events.push("appHello");
          }
          const writer = new BinWriter();
          writer.variant(0);
          writer.varint(protocol);
          writer.varint(1);
          writer.option<string>(
            launchMode === 0 ? options.appWelcomeError : undefined,
            (value) => writer.string(value),
          );
          const sendWelcome = () => {
            if (socket.destroyed) return;
            if (launchMode === 0 && options.skipAppWelcome) return;
            if (launchMode === 0) appSocket = socket;
            socket.write(encodeFrame(writer.toBuffer()));
            if (launchMode === 0) {
              socket.write(
                terminalFrame(
                  socketCols,
                  socketRows,
                  options.protocol,
                  options.frameFull ?? true,
                ),
              );
            }
          };
          if (launchMode === 0 && (options.appWelcomeDelayMs ?? 0) > 0) {
            setTimeout(sendWelcome, options.appWelcomeDelayMs);
          } else {
            sendWelcome();
          }
        } else if (variant === 1) {
          if (!isAppSocket) options.tracker?.events.push("input");
          if (options.clipboardData) {
            const frame = clipboardFrame(options.clipboardData);
            const sendClipboard = () => appSocket?.write(frame);
            if (options.clipboardDelayMs)
              setTimeout(sendClipboard, options.clipboardDelayMs);
            else sendClipboard();
          }
        } else if (variant === 3 || variant === 5) {
          if (variant === 3) {
            const resizeCols = reader.varint();
            const resizeRows = reader.varint();
            socketCols = resizeCols;
            socketRows = resizeRows;
            if (isAppSocket && options.tracker) {
              options.tracker.appSizes.push(`${resizeCols}x${resizeRows}`);
            } else if (options.tracker) {
              options.tracker.events.push("resize");
            }
          } else {
            options.tracker?.events.push("attach");
            options.tracker?.events.push("terminalFrame");
            options.onDirectAttach?.(socket);
          }
          const sendTerminalFrame = () => {
            if (!socket.destroyed) {
              socket.write(
                terminalFrame(
                  socketCols,
                  socketRows,
                  options.protocol,
                  options.frameFull ?? true,
                ),
              );
            }
          };
          if (variant !== 5 || !options.skipDirectFrame) {
            if (variant === 5 && (options.directFrameDelayMs ?? 0) > 0) {
              setTimeout(sendTerminalFrame, options.directFrameDelayMs);
            } else {
              sendTerminalFrame();
            }
          }
          if (variant === 3 && options.directClipboardOnResize) {
            socket.write(clipboardFrame(options.directClipboardOnResize));
          }
        } else if (variant === 6) {
          options.tracker?.events.push("scroll");
          options.onScroll?.(reader);
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return socketPath;
}

async function waitForTerminalFrame(messages: string[]) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const frame = messages
      .map((message) => JSON.parse(message))
      .find((message) => message.terminal);
    if (frame) return frame.terminal;
    await Bun.sleep(2);
  }
  throw new Error("timed out waiting for terminal frame");
}

async function waitForCondition(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(2);
  }
  throw new Error(message);
}

describe("terminal bridge sharing", () => {
  for (const protocol of [20, 22]) {
    test(`protocol ${protocol} ${protocol === 22 ? "skips OSC52 relay" : "retains legacy relay"} while sharing terminal rendering`, async () => {
      const tracker = {
        appConnects: 0,
        appCloses: 0,
        appSizes: [] as string[],
        events: [] as string[],
      };
      const socketPath = await startThinServer({ protocol, tracker });
      const browser = {} as ServerWebSocket<unknown>;
      const messages: string[] = [];
      const warnings: string[] = [];
      const bridge = createTerminalBridge({
        clientSocketPath: socketPath,
        logger: { ...silentLogger, warn: (message) => warnings.push(message) },
        herdrProtocol: async () => protocol,
        safeSend: (_ws, payload) => {
          messages.push(payload);
          return true;
        },
        clientLabel: () => "test",
        markRpcError: () => undefined,
      });
      try {
        await bridge.handleTerminalRpc(browser, "attach", "terminal.attach", {
          terminal_id: "term_1",
          cols: 100,
          rows: 30,
        });
        await waitForTerminalFrame(messages);
        expect(
          tracker.events.filter((event) => event === "attach"),
        ).toHaveLength(1);
        expect(tracker.appConnects).toBe(protocol === 22 ? 0 : 1);
        expect(
          warnings.filter((message) =>
            message.includes("OSC 52 unavailable on the legacy fallback"),
          ),
        ).toHaveLength(protocol === 22 ? 1 : 0);
        const viewer = {} as ServerWebSocket<unknown>;
        await bridge.handleTerminalRpc(viewer, "second", "terminal.attach", {
          terminal_id: "term_1",
          cols: 100,
          rows: 30,
        });
        expect(
          tracker.events.filter((event) => event === "attach"),
        ).toHaveLength(1);
        expect(tracker.appConnects).toBe(protocol === 22 ? 0 : 1);
      } finally {
        bridge.dispose();
      }
    });
  }

  test("refreshes a reused terminal for a newly attached browser", async () => {
    const socketPath = await startThinServer();
    const firstBrowser = {} as ServerWebSocket<unknown>;
    const secondBrowser = {} as ServerWebSocket<unknown>;
    const messages = new Map<ServerWebSocket<unknown>, string[]>([
      [firstBrowser, []],
      [secondBrowser, []],
    ]);
    const bridge = createTerminalBridge({
      clientSocketPath: socketPath,
      herdrProtocol: async () => 17,
      safeSend: (ws, payload) => {
        messages.get(ws)?.push(payload);
        return true;
      },
      clientLabel: (ws) => (ws === firstBrowser ? "first" : "second"),
      markRpcError: () => undefined,
    });

    await bridge.handleTerminalRpc(
      firstBrowser,
      "first-attach",
      "terminal.attach",
      {
        terminal_id: "term_1",
        cols: 100,
        rows: 30,
      },
    );
    await waitForTerminalFrame(messages.get(firstBrowser)!);

    await bridge.handleTerminalRpc(
      secondBrowser,
      "second-attach",
      "terminal.attach",
      {
        terminal_id: "term_1",
        cols: 100,
        rows: 30,
      },
    );
    const reusedFrame = await waitForTerminalFrame(
      messages.get(secondBrowser)!,
    );

    expect(reusedFrame).toMatchObject({
      terminal_id: "term_1",
      full: true,
      width: 100,
      height: 30,
    });

    const frameCount = messages
      .get(secondBrowser)!
      .map((message) => JSON.parse(message))
      .filter((message) => message.terminal).length;
    await bridge.handleTerminalRpc(
      secondBrowser,
      "duplicate-attach",
      "terminal.attach",
      {
        terminal_id: "term_1",
        cols: 100,
        rows: 30,
      },
    );
    await Bun.sleep(5);
    expect(
      messages
        .get(secondBrowser)!
        .map((message) => JSON.parse(message))
        .filter((message) => message.terminal),
    ).toHaveLength(frameCount);

    bridge.cleanupWs(firstBrowser);
    bridge.cleanupWs(secondBrowser);
  });

  test("notifies viewers to re-attach when Herdr closes the terminal stream", async () => {
    const direct: { socket: net.Socket | null } = { socket: null };
    const socketPath = await startThinServer({
      onDirectAttach: (socket) => {
        direct.socket = socket;
      },
    });
    const browser = {} as ServerWebSocket<unknown>;
    const messages: string[] = [];
    const bridge = createTerminalBridge({
      clientSocketPath: socketPath,
      herdrProtocol: async () => 17,
      safeSend: (ws, payload) => {
        messages.push(payload);
        return true;
      },
      clientLabel: () => "browser",
      markRpcError: () => undefined,
    });

    await bridge.handleTerminalRpc(browser, "attach", "terminal.attach", {
      terminal_id: "term_1",
      cols: 100,
      rows: 30,
    });
    await waitForTerminalFrame(messages);

    // Herdr closes the direct attach when another client takes the terminal
    // over; the viewer must be told so its UI can re-attach.
    expect(direct.socket).not.toBeNull();
    (direct.socket as net.Socket).destroy();
    await waitForCondition(
      () =>
        messages
          .map((message) => JSON.parse(message))
          .some((message) => message.terminal_closed?.terminal_id === "term_1"),
      "timed out waiting for terminal_closed",
    );
    const closed = messages
      .map((message) => JSON.parse(message))
      .find((message) => message.terminal_closed);
    expect(closed.terminal_closed).toMatchObject({
      terminal_id: "term_1",
      reason: "stream_closed",
    });

    // A re-attach after the close must build a fresh stream.
    messages.length = 0;
    await bridge.handleTerminalRpc(browser, "reattach", "terminal.attach", {
      terminal_id: "term_1",
      cols: 100,
      rows: 30,
    });
    const frame = await waitForTerminalFrame(messages);
    expect(frame).toMatchObject({ terminal_id: "term_1", full: true });

    bridge.cleanupWs(browser);
  });

  test.each([0, 20])(
    "routes Herdr clipboard messages from the app relay to the input owner (reply delay %sms)",
    async (clipboardDelayMs) => {
      const clipboardData = "cmVtb3RlIGNvcHk=";
      const socketPath = await startThinServer({
        clipboardData,
        clipboardDelayMs,
        appWelcomeDelayMs: 30,
      });
      const browser = {} as ServerWebSocket<unknown>;
      const observer = {} as ServerWebSocket<unknown>;
      const messages = new Map<ServerWebSocket<unknown>, string[]>([
        [browser, []],
        [observer, []],
      ]);
      const bridge = createTerminalBridge({
        clientSocketPath: socketPath,
        herdrProtocol: async () => 17,
        safeSend: (ws, payload) => {
          messages.get(ws)?.push(payload);
          return true;
        },
        clientLabel: (ws) => (ws === browser ? "browser" : "observer"),
        markRpcError: () => undefined,
      });

      await bridge.handleTerminalRpc(browser, "attach", "terminal.attach", {
        terminal_id: "term_1",
        cols: 100,
        rows: 30,
      });
      await bridge.handleTerminalRpc(observer, "observe", "terminal.attach", {
        terminal_id: "term_1",
        cols: 100,
        rows: 30,
      });
      await bridge.handleTerminalRpc(browser, "input", "terminal.input", {
        terminal_id: "term_1",
        data: Buffer.from("copy").toString("base64"),
      });
      await waitForCondition(
        () =>
          messages
            .get(browser)!
            .some((message) => JSON.parse(message).terminal_clipboard),
        "timed out waiting for the input owner's clipboard message",
      );

      expect(
        messages
          .get(browser)!
          .map((message) => JSON.parse(message))
          .find((message) => message.terminal_clipboard)?.terminal_clipboard,
      ).toEqual({ terminal_id: "term_1", data: clipboardData });
      expect(
        messages
          .get(observer)!
          .some((message) => JSON.parse(message).terminal_clipboard),
      ).toBe(false);

      messages.get(browser)!.length = 0;
      messages.get(observer)!.length = 0;
      await bridge.handleTerminalRpc(observer, "input-2", "terminal.input", {
        terminal_id: "term_1",
        data: Buffer.from("copy again").toString("base64"),
      });
      await waitForCondition(
        () =>
          messages
            .get(observer)!
            .some((message) => JSON.parse(message).terminal_clipboard),
        "timed out waiting for the new input owner's clipboard message",
      );
      expect(
        messages
          .get(observer)!
          .map((message) => JSON.parse(message))
          .find((message) => message.terminal_clipboard)?.terminal_clipboard,
      ).toEqual({ terminal_id: "term_1", data: clipboardData });
      expect(
        messages
          .get(browser)!
          .some((message) => JSON.parse(message).terminal_clipboard),
      ).toBe(false);
      bridge.cleanupWs(browser);
      bridge.cleanupWs(observer);
    },
  );

  test("isolates duplicate terminal ids, operations, frames, and clipboard by connection", async () => {
    const alphaTracker = {
      appConnects: 0,
      appCloses: 0,
      appSizes: [] as string[],
      events: [] as string[],
    };
    const betaTracker = {
      appConnects: 0,
      appCloses: 0,
      appSizes: [] as string[],
      events: [] as string[],
    };
    const [alphaSocket, betaSocket] = await Promise.all([
      startThinServer({
        tracker: alphaTracker,
        clipboardData: "YWxwaGE=",
      }),
      startThinServer({
        tracker: betaTracker,
        clipboardData: "YmV0YQ==",
      }),
    ]);
    const browser = {} as ServerWebSocket<unknown>;
    const alphaMessages: string[] = [];
    const betaMessages: string[] = [];
    const alphaBridge = createTerminalBridge({
      connectionId: "alpha",
      connectionGeneration: 11,
      clientSocketPath: alphaSocket,
      herdrProtocol: async () => 17,
      safeSend: (_ws, payload) => {
        alphaMessages.push(payload);
        return true;
      },
      clientLabel: () => "browser",
      markRpcError: () => undefined,
    });
    const betaBridge = createTerminalBridge({
      connectionId: "beta",
      connectionGeneration: 12,
      clientSocketPath: betaSocket,
      herdrProtocol: async () => 17,
      safeSend: (_ws, payload) => {
        betaMessages.push(payload);
        return true;
      },
      clientLabel: () => "browser",
      markRpcError: () => undefined,
    });

    await Promise.all([
      alphaBridge.handleTerminalRpc(
        browser,
        "alpha-attach",
        "terminal.attach",
        {
          terminal_id: "same-terminal",
          cols: 100,
          rows: 30,
        },
      ),
      betaBridge.handleTerminalRpc(browser, "beta-attach", "terminal.attach", {
        terminal_id: "same-terminal",
        cols: 100,
        rows: 30,
      }),
    ]);
    await Promise.all([
      waitForTerminalFrame(alphaMessages),
      waitForTerminalFrame(betaMessages),
    ]);

    expect(
      alphaMessages.every((message) => {
        const parsed = JSON.parse(message);
        return (
          parsed.connection_id === "alpha" &&
          parsed.connection_generation === 11
        );
      }),
    ).toBe(true);
    expect(
      betaMessages.every((message) => {
        const parsed = JSON.parse(message);
        return (
          parsed.connection_id === "beta" && parsed.connection_generation === 12
        );
      }),
    ).toBe(true);

    await alphaBridge.handleTerminalRpc(
      browser,
      "alpha-input",
      "terminal.input",
      {
        terminal_id: "same-terminal",
        data: Buffer.from("copy").toString("base64"),
      },
    );
    await alphaBridge.handleTerminalRpc(
      browser,
      "alpha-scroll",
      "terminal.scroll",
      {
        terminal_id: "same-terminal",
        direction: "up",
        lines: 10,
        source: "page-key",
      },
    );
    await betaBridge.handleTerminalRpc(
      browser,
      "beta-resize",
      "terminal.resize",
      {
        terminal_id: "same-terminal",
        cols: 120,
        rows: 40,
      },
    );

    await waitForCondition(
      () =>
        alphaTracker.events.includes("input") &&
        alphaTracker.events.includes("scroll") &&
        betaTracker.events.includes("resize") &&
        alphaMessages.some((message) => JSON.parse(message).terminal_clipboard),
      "timed out waiting for isolated terminal operations",
    );
    expect(alphaTracker.events).toContain("input");
    expect(alphaTracker.events).toContain("scroll");
    expect(alphaTracker.events).not.toContain("resize");
    expect(betaTracker.events).toContain("resize");
    expect(betaTracker.events).not.toContain("input");
    expect(betaTracker.events).not.toContain("scroll");
    expect(
      alphaMessages
        .map((message) => JSON.parse(message))
        .find((message) => message.terminal_clipboard),
    ).toMatchObject({
      connection_id: "alpha",
      connection_generation: 11,
      terminal_clipboard: {
        terminal_id: "same-terminal",
        data: "YWxwaGE=",
      },
    });
    expect(
      betaMessages.some((message) => JSON.parse(message).terminal_clipboard),
    ).toBe(false);

    alphaBridge.dispose();
    betaBridge.dispose();
  });

  test("does not broadcast clipboard events without a matching input owner", async () => {
    const socketPath = await startThinServer({
      directClipboardOnResize: "bm8gb3duZXI=",
    });
    const firstBrowser = {} as ServerWebSocket<unknown>;
    const secondBrowser = {} as ServerWebSocket<unknown>;
    const messages = new Map<ServerWebSocket<unknown>, string[]>([
      [firstBrowser, []],
      [secondBrowser, []],
    ]);
    const bridge = createTerminalBridge({
      clientSocketPath: socketPath,
      herdrProtocol: async () => 17,
      safeSend: (ws, payload) => {
        messages.get(ws)?.push(payload);
        return true;
      },
      clientLabel: () => "browser",
      markRpcError: () => undefined,
    });

    await bridge.handleTerminalRpc(
      firstBrowser,
      "attach-1",
      "terminal.attach",
      {
        terminal_id: "term_1",
        cols: 100,
        rows: 30,
      },
    );
    await bridge.handleTerminalRpc(
      secondBrowser,
      "attach-2",
      "terminal.attach",
      {
        terminal_id: "term_1",
        cols: 100,
        rows: 30,
      },
    );
    await Bun.sleep(5);

    for (const sent of messages.values()) {
      expect(
        sent.some((message) => JSON.parse(message).terminal_clipboard),
      ).toBe(false);
    }
    bridge.cleanupWs(firstBrowser);
    bridge.cleanupWs(secondBrowser);
  });

  test("keeps terminal attach usable when the optional relay is rejected", async () => {
    const socketPath = await startThinServer({
      appWelcomeError: "app clients disabled",
    });
    const browser = {} as ServerWebSocket<unknown>;
    const messages: string[] = [];
    const bridge = createTerminalBridge({
      clientSocketPath: socketPath,
      herdrProtocol: async () => 17,
      safeSend: (_ws, payload) => {
        messages.push(payload);
        return true;
      },
      clientLabel: () => "browser",
      markRpcError: () => undefined,
    });

    await bridge.handleTerminalRpc(browser, "attach", "terminal.attach", {
      terminal_id: "term_1",
      cols: 100,
      rows: 30,
    });

    expect(
      messages
        .map((message) => JSON.parse(message))
        .find((message) => message.id === "attach")?.result,
    ).toEqual({ ok: true });
    bridge.cleanupWs(browser);
  });

  test("does not leave terminal attach waiting on a stalled relay", async () => {
    const socketPath = await startThinServer({ skipAppWelcome: true });
    const browser = {} as ServerWebSocket<unknown>;
    const messages: string[] = [];
    const bridge = createTerminalBridge({
      clientSocketPath: socketPath,
      herdrProtocol: async () => 17,
      safeSend: (_ws, payload) => {
        messages.push(payload);
        return true;
      },
      clientLabel: () => "browser",
      markRpcError: () => undefined,
    });

    const startedAt = performance.now();
    await bridge.handleTerminalRpc(browser, "attach", "terminal.attach", {
      terminal_id: "term_1",
      cols: 100,
      rows: 30,
    });

    expect(performance.now() - startedAt).toBeLessThan(1_500);
    expect(
      messages
        .map((message) => JSON.parse(message))
        .find((message) => message.id === "attach")?.result,
    ).toEqual({ ok: true });
    bridge.cleanupWs(browser);
  });

  test("keeps the clipboard relay alive across terminal detaches", async () => {
    const tracker = {
      appConnects: 0,
      appCloses: 0,
      appSizes: [] as string[],
      events: [] as string[],
    };
    const socketPath = await startThinServer({ tracker });
    const browser = {} as ServerWebSocket<unknown>;
    const bridge = createTerminalBridge({
      clientSocketPath: socketPath,
      herdrProtocol: async () => 17,
      safeSend: () => true,
      clientLabel: () => "browser",
      markRpcError: () => undefined,
    });

    await bridge.handleTerminalRpc(browser, "attach-1", "terminal.attach", {
      terminal_id: "term_1",
      cols: 100,
      rows: 30,
    });
    expect(tracker.appConnects).toBe(1);
    // The first terminal frame proves that Herdr processed AttachTerminal and
    // installed its resize lock before the app relay becomes foreground.
    expect(tracker.events.indexOf("terminalFrame")).toBeGreaterThanOrEqual(0);
    expect(tracker.events.indexOf("terminalFrame")).toBeLessThan(
      tracker.events.indexOf("appHello"),
    );

    // Detaching the last viewer must not tear down the relay: its reconnect
    // churn is what reflows background pane runtimes on every tab switch.
    await bridge.handleTerminalRpc(browser, "detach-1", "terminal.detach", {
      terminal_id: "term_1",
    });
    expect(tracker.appCloses).toBe(0);

    await bridge.handleTerminalRpc(browser, "attach-2", "terminal.attach", {
      terminal_id: "term_2",
      cols: 100,
      rows: 30,
    });
    expect(tracker.appConnects).toBe(1);

    // The relay follows the latest viewer size so the server's shared pane
    // geometry stays pinned to the visible window.
    await bridge.handleTerminalRpc(browser, "resize-1", "terminal.resize", {
      terminal_id: "term_2",
      cols: 120,
      rows: 40,
    });
    for (
      let attempt = 0;
      attempt < 50 && !tracker.appSizes.includes("120x40");
      attempt += 1
    ) {
      await Bun.sleep(2);
    }
    expect(tracker.appSizes).toContain("120x40");

    // Once no browser is connected the relay has no consumer and closes.
    bridge.browserClientCountChanged(0);
    for (
      let attempt = 0;
      attempt < 50 && tracker.appCloses === 0;
      attempt += 1
    ) {
      await Bun.sleep(2);
    }
    expect(tracker.appCloses).toBe(1);

    bridge.browserClientCountChanged(1);
    await bridge.handleTerminalRpc(browser, "attach-3", "terminal.attach", {
      terminal_id: "term_3",
      cols: 100,
      rows: 30,
    });
    expect(tracker.appConnects).toBe(2);
    bridge.cleanupWs(browser);
  });

  test("sizes the relay only from the active split pane viewport", async () => {
    const tracker = {
      appConnects: 0,
      appCloses: 0,
      appSizes: [] as string[],
      events: [] as string[],
    };
    const socketPath = await startThinServer({ tracker });
    const browser = {} as ServerWebSocket<unknown>;
    const confirmedRelaySizes: Array<{
      cols: number;
      rows: number;
      paneId: string | null;
    }> = [];
    const bridge = createTerminalBridge({
      clientSocketPath: socketPath,
      herdrProtocol: async () => 17,
      safeSend: () => true,
      clientLabel: () => "browser",
      markRpcError: () => undefined,
      confirmRelayResize: async (request) => {
        confirmedRelaySizes.push(request);
        return true;
      },
    });

    await bridge.handleTerminalRpc(browser, "inactive", "terminal.attach", {
      terminal_id: "term_inactive",
      cols: 70,
      rows: 44,
      relay_active: false,
    });
    expect(tracker.appConnects).toBe(0);

    await bridge.handleTerminalRpc(browser, "active", "terminal.attach", {
      terminal_id: "term_active",
      cols: 70,
      rows: 44,
      relay_active: true,
      relay_cols: 168,
      relay_rows: 45,
    });
    expect(tracker.appConnects).toBe(1);
    expect(tracker.appSizes).toEqual(["168x45"]);

    await bridge.handleTerminalRpc(
      browser,
      "relay-resize",
      "terminal.relay_resize",
      { cols: 170, rows: 46, pane_id: "pane_active" },
    );
    expect(confirmedRelaySizes).toEqual([
      { cols: 170, rows: 46, paneId: "pane_active" },
    ]);
    for (
      let attempt = 0;
      attempt < 50 && !tracker.appSizes.includes("170x46");
      attempt += 1
    ) {
      await Bun.sleep(2);
    }
    expect(tracker.appSizes).toEqual(["168x45", "170x46"]);

    await bridge.handleTerminalRpc(
      browser,
      "inactive-resize",
      "terminal.resize",
      {
        terminal_id: "term_inactive",
        cols: 72,
        rows: 44,
        relay_active: false,
      },
    );
    await Bun.sleep(5);
    expect(tracker.appSizes).toEqual(["168x45", "170x46"]);

    await bridge.handleTerminalRpc(
      browser,
      "active-resize",
      "terminal.resize",
      {
        terminal_id: "term_active",
        cols: 72,
        rows: 44,
        relay_active: true,
        relay_cols: 172,
        relay_rows: 45,
      },
    );
    for (
      let attempt = 0;
      attempt < 50 && !tracker.appSizes.includes("172x45");
      attempt += 1
    ) {
      await Bun.sleep(2);
    }
    expect(tracker.appSizes).toEqual(["168x45", "170x46", "172x45"]);
    bridge.cleanupWs(browser);
  });

  test("does not let a delayed attach overwrite a newer relay target", async () => {
    const tracker = {
      appConnects: 0,
      appCloses: 0,
      appSizes: [] as string[],
      events: [] as string[],
    };
    const socketPath = await startThinServer({
      tracker,
      directFrameDelayMs: 25,
    });
    const browser = {} as ServerWebSocket<unknown>;
    const bridge = createTerminalBridge({
      clientSocketPath: socketPath,
      herdrProtocol: async () => 17,
      safeSend: () => true,
      clientLabel: () => "browser",
      markRpcError: () => undefined,
      confirmRelayResize: async () => true,
    });

    await bridge.handleTerminalRpc(browser, "initial", "terminal.attach", {
      terminal_id: "term_initial",
      cols: 100,
      rows: 30,
      relay_cols: 100,
      relay_rows: 30,
    });
    const delayedAttach = bridge.handleTerminalRpc(
      browser,
      "delayed",
      "terminal.attach",
      {
        terminal_id: "term_delayed",
        cols: 120,
        rows: 40,
        relay_cols: 120,
        relay_rows: 40,
      },
    );
    await Bun.sleep(5);
    await bridge.handleTerminalRpc(
      browser,
      "new-target",
      "terminal.relay_resize",
      { cols: 140, rows: 50, pane_id: "pane_target" },
    );
    await delayedAttach;
    for (
      let attempt = 0;
      attempt < 50 && !tracker.appSizes.includes("140x50");
      attempt += 1
    ) {
      await Bun.sleep(2);
    }
    expect(tracker.appSizes).toContain("140x50");
    expect(tracker.appSizes).not.toContain("120x40");
    bridge.cleanupWs(browser);
  });

  test("rejects input for terminals the browser does not view", async () => {
    const socketPath = await startThinServer();
    const owner = {} as ServerWebSocket<unknown>;
    const stranger = {} as ServerWebSocket<unknown>;
    const messages = new Map<ServerWebSocket<unknown>, string[]>([
      [owner, []],
      [stranger, []],
    ]);
    const bridge = createTerminalBridge({
      clientSocketPath: socketPath,
      herdrProtocol: async () => 17,
      safeSend: (ws, payload) => {
        messages.get(ws)?.push(payload);
        return true;
      },
      clientLabel: () => "browser",
      markRpcError: () => undefined,
    });
    await bridge.handleTerminalRpc(owner, "attach", "terminal.attach", {
      terminal_id: "term_1",
      cols: 100,
      rows: 30,
    });

    await bridge.handleTerminalRpc(stranger, "input", "terminal.input", {
      terminal_id: "term_1",
      data: Buffer.from("steal clipboard").toString("base64"),
    });

    expect(
      messages
        .get(stranger)!
        .map((message) => JSON.parse(message))
        .find((message) => message.id === "input")?.error.message,
    ).toBe("no terminal attached");
    bridge.cleanupWs(owner);
    bridge.cleanupWs(stranger);
  });

  test("dispose closes runtime-owned terminal resources", async () => {
    const tracker = {
      appConnects: 0,
      appCloses: 0,
      appSizes: [] as string[],
      events: [] as string[],
    };
    const socketPath = await startThinServer({ tracker });
    const browser = {} as ServerWebSocket<unknown>;
    const messages: string[] = [];
    const bridge = createTerminalBridge({
      clientSocketPath: socketPath,
      herdrProtocol: async () => 17,
      safeSend: (_ws, payload) => {
        messages.push(payload);
        return true;
      },
      clientLabel: () => "browser",
      markRpcError: () => undefined,
    });

    await bridge.handleTerminalRpc(browser, "attach", "terminal.attach", {
      terminal_id: "term_dispose",
      cols: 100,
      rows: 30,
    });
    expect(bridge.statusTerminals()).toEqual([
      { terminal_id: "term_dispose", viewers: 1 },
    ]);

    bridge.dispose();
    bridge.dispose();
    await bridge.handleTerminalRpc(
      browser,
      "after-dispose",
      "terminal.attach",
      {
        terminal_id: "term_after_dispose",
        cols: 100,
        rows: 30,
      },
    );

    expect(bridge.statusTerminals()).toEqual([]);
    expect(bridge.viewedTerminals(browser)).toEqual([]);
    expect(
      messages
        .map((message) => JSON.parse(message))
        .find((message) => message.id === "after-dispose")?.error.message,
    ).toBe("terminal bridge disposed");
    for (
      let attempt = 0;
      attempt < 50 && tracker.appCloses !== 1;
      attempt += 1
    ) {
      await Bun.sleep(2);
    }
    expect(tracker.appCloses).toBe(1);
  });

  test("dispose wins an in-flight attach without retaining resources", async () => {
    const tracker = {
      appConnects: 0,
      appCloses: 0,
      appSizes: [] as string[],
      events: [] as string[],
    };
    let resolveDirectAttach!: () => void;
    const directAttach = new Promise<void>((resolve) => {
      resolveDirectAttach = resolve;
    });
    const socketPath = await startThinServer({
      tracker,
      skipDirectFrame: true,
      onDirectAttach: resolveDirectAttach,
    });
    const browser = {} as ServerWebSocket<unknown>;
    const messages: string[] = [];
    const bridge = createTerminalBridge({
      clientSocketPath: socketPath,
      herdrProtocol: async () => 17,
      safeSend: (_ws, payload) => {
        messages.push(payload);
        return true;
      },
      clientLabel: () => "browser",
      markRpcError: () => undefined,
    });

    const attaching = bridge.handleTerminalRpc(
      browser,
      "concurrent-attach",
      "terminal.attach",
      {
        terminal_id: "term_concurrent_dispose",
        cols: 100,
        rows: 30,
      },
    );
    await directAttach;
    expect(tracker.events).toContain("attach");
    bridge.dispose();
    await attaching;

    expect(bridge.statusTerminals()).toEqual([]);
    expect(bridge.viewedTerminals(browser)).toEqual([]);
    expect(tracker.appConnects).toBe(0);
    expect(
      messages
        .map((message) => JSON.parse(message))
        .find((message) => message.id === "concurrent-attach")?.error.message,
    ).toBe("terminal bridge disposed");
  });

  test("suppresses terminal replies after the request lease is invalidated", async () => {
    const messages: string[] = [];
    const bridge = createTerminalBridge({
      connectionId: "alpha",
      clientSocketPath: "/tmp/unused-terminal-lease.sock",
      herdrProtocol: async () => 17,
      safeSend: (_ws, payload) => {
        messages.push(payload);
        return true;
      },
      clientLabel: () => "browser",
      markRpcError: () => undefined,
    });

    await bridge.handleTerminalRpc(
      {} as ServerWebSocket<unknown>,
      "stale-terminal",
      "terminal.input",
      { terminal_id: "same", data: "YQ==" },
      () => false,
    );

    expect(messages.map((message) => JSON.parse(message))).toEqual([
      {
        connection_id: "alpha",
        id: "stale-terminal",
        error: { message: "connection changed during request" },
      },
    ]);
    bridge.dispose();
  });
});

test("navigation mode uses exactly the terminal backend decision", async () => {
  const disabled = process.env.HERDR_GUI_DISABLE_ENDPOINT;
  try {
    for (const [protocol, lookup, disable, expected] of [
      [22, true, false, "browser-local"],
      [22, true, true, "shared"],
      [22, false, false, "shared"],
      [20, true, false, "shared"],
    ] as const) {
      if (disable) process.env.HERDR_GUI_DISABLE_ENDPOINT = "1";
      else delete process.env.HERDR_GUI_DISABLE_ENDPOINT;
      const bridge = createTerminalBridge({
        clientSocketPath: "/unused",
        herdrProtocol: async () => protocol,
        lookupPaneId: lookup ? async () => "pane" : undefined,
        safeSend: () => true,
        clientLabel: () => "test",
        markRpcError: () => {},
      });
      expect(await bridge.navigationMode()).toBe(expected);
      bridge.dispose();
    }
  } finally {
    if (disabled === undefined) delete process.env.HERDR_GUI_DISABLE_ENDPOINT;
    else process.env.HERDR_GUI_DISABLE_ENDPOINT = disabled;
  }
});

// A legacy ThinClient stream carries `full` on the wire, and it is false for an
// incremental frame. Coalescing drops held frames, so a dropped incremental
// frame loses output that no later frame repeats: the terminal renders corrupt.
// Only a self-contained repaint may carry a coalesce key.
test("does not coalesce an incremental legacy frame", async () => {
  const socketPath = await startThinServer({ protocol: 17, frameFull: false });
  const browser = {} as ServerWebSocket<unknown>;
  const sends: { payload: string; coalesceKey?: string }[] = [];
  const bridge = createTerminalBridge({
    clientSocketPath: socketPath,
    herdrProtocol: async () => 17,
    safeSend: (_ws, payload, _context, coalesceKey) => {
      sends.push({ payload, coalesceKey });
      return true;
    },
    clientLabel: () => "test",
    markRpcError: () => undefined,
  });
  try {
    await bridge.handleTerminalRpc(browser, "attach", "terminal.attach", {
      terminal_id: "term_1",
      cols: 100,
      rows: 30,
    });
    await waitForTerminalFrame(sends.map((s) => s.payload));
    const frames = sends.filter((s) => s.payload.includes('"terminal"'));
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(JSON.parse(frame.payload).terminal.full).toBe(false);
      expect(frame.coalesceKey).toBeUndefined();
    }
  } finally {
    bridge.dispose();
  }
});

test("keeps full and incremental legacy frames in order under backpressure", async () => {
  let source!: net.Socket;
  const socketPath = await startThinServer({
    onDirectAttach: (socket) => {
      source = socket;
    },
  });
  let buffered = WS_COALESCE_LIMIT_BYTES + 1;
  const sent: string[] = [];
  const received = new EventEmitter();
  const browser = {
    close: () => {},
    getBufferedAmount: () => buffered,
    send: (payload: string) => {
      sent.push(payload);
      return payload.length;
    },
  } as unknown as ServerWebSocket<unknown>;
  const cleanup = () => {};
  const bridge = createTerminalBridge({
    clientSocketPath: socketPath,
    herdrProtocol: async () => 17,
    safeSend: (ws, payload, context, coalesceKey) => {
      const result = sendWebSocketMessage(ws, payload, {
        cleanup,
        context,
        coalesceKey,
      });
      if (JSON.parse(payload).terminal) received.emit("frame");
      return result;
    },
    clientLabel: () => "test",
    markRpcError: () => undefined,
  });
  try {
    const fullFrame = once(received, "frame");
    await bridge.handleTerminalRpc(browser, "attach", "terminal.attach", {
      terminal_id: "term_1",
      cols: 100,
      rows: 30,
      relay_active: false,
    });
    await fullFrame;
    const incrementalFrame = once(received, "frame");
    source.write(terminalFrame(100, 30, 17, false));
    await incrementalFrame;
    buffered = 0;
    flushCoalescedMessages(browser, { cleanup });
    expect(
      sent
        .map((payload) => JSON.parse(payload))
        .filter((message) => message.terminal)
        .map((message) => message.terminal.full),
    ).toEqual([true, false]);
  } finally {
    bridge.dispose();
  }
});

// A held frame is sized for the surface it was rendered against. If the surface
// resizes while that frame is held, flushing it paints the OLD size into the new
// pane, clipping the bottom and right. The bridge must drop the held frame
// whenever the size it was rendered for stops being current.
test("drops a held frame when the viewer resizes the terminal", async () => {
  const socketPath = await startThinServer();
  const browser = {} as ServerWebSocket<unknown>;
  const messages: string[] = [];
  const drops: { ws: ServerWebSocket<unknown>; coalesceKey: string }[] = [];
  const bridge = createTerminalBridge({
    clientSocketPath: socketPath,
    herdrProtocol: async () => 17,
    safeSend: (_ws, payload) => {
      messages.push(payload);
      return true;
    },
    dropCoalesced: (ws, coalesceKey) => drops.push({ ws, coalesceKey }),
    clientLabel: () => "test",
    markRpcError: () => undefined,
  });
  try {
    await bridge.handleTerminalRpc(browser, "attach", "terminal.attach", {
      terminal_id: "term_1",
      cols: 100,
      rows: 30,
    });
    await waitForTerminalFrame(messages);
    drops.length = 0;
    await bridge.handleTerminalRpc(browser, "resize", "terminal.resize", {
      terminal_id: "term_1",
      cols: 120,
      rows: 40,
    });
    expect(drops).toEqual([
      { ws: browser, coalesceKey: 'terminal:[null,null,"term_1"]' },
    ]);
  } finally {
    bridge.dispose();
  }
});

test("drops held frames for every viewer when an attach resizes the shared terminal", async () => {
  const socketPath = await startThinServer();
  const first = {} as ServerWebSocket<unknown>;
  const second = {} as ServerWebSocket<unknown>;
  const messages: string[] = [];
  const drops: { ws: ServerWebSocket<unknown>; coalesceKey: string }[] = [];
  const bridge = createTerminalBridge({
    clientSocketPath: socketPath,
    herdrProtocol: async () => 17,
    safeSend: (_ws, payload) => {
      messages.push(payload);
      return true;
    },
    dropCoalesced: (ws, coalesceKey) => drops.push({ ws, coalesceKey }),
    clientLabel: () => "test",
    markRpcError: () => undefined,
  });
  try {
    await bridge.handleTerminalRpc(first, "a1", "terminal.attach", {
      terminal_id: "term_1",
      cols: 100,
      rows: 30,
    });
    await waitForTerminalFrame(messages);
    drops.length = 0;
    // A different size resizes the shared terminal, so the frame the FIRST
    // viewer is holding is now the wrong size for it too.
    await bridge.handleTerminalRpc(second, "a2", "terminal.attach", {
      terminal_id: "term_1",
      cols: 140,
      rows: 50,
    });
    expect(drops.map((d) => d.ws)).toContain(first);
    expect(
      drops.every((d) => d.coalesceKey === 'terminal:[null,null,"term_1"]'),
    ).toBe(true);
  } finally {
    bridge.dispose();
  }
});

import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import { EventEmitter, once } from "node:events";
import * as net from "node:net";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { BinReader, BinWriter, encodeFrame } from "./bincode";
import {
  EndpointTerminalSession,
  cropFrame,
  frameHyperlinkAt,
  resolvedFrameLink,
} from "./endpoint-terminal-session";
import type { CellData, FrameData } from "./thin-client";
import type { Popup } from "./endpoint-surface";
import type { ServerWebSocket } from "bun";
import { createTerminalBridge } from "./terminal-bridge";
import { silentLogger } from "../utils/logger";
import { EndpointCreationDeadline } from "./endpoint-creation";
import {
  dropCoalescedMessage,
  flushCoalescedMessages,
  sendWebSocketMessage,
  WS_COALESCE_LIMIT_BYTES,
} from "./websocket-send";

const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

function cell(symbol: string, over: Partial<CellData> = {}): CellData {
  return {
    symbol,
    fg: 0,
    bg: 0,
    modifier: 0,
    skip: false,
    hyperlink: null,
    ...over,
  };
}

function writeCell(w: BinWriter, c: CellData) {
  w.string(c.symbol);
  w.varint(c.fg);
  w.varint(c.bg);
  w.varint(c.modifier);
  w.bool(c.skip);
  w.option(c.hyperlink, (v) => w.varint(v));
}

function writeFrame(w: BinWriter, frame: FrameData) {
  w.varint(frame.cells.length);
  for (const c of frame.cells) writeCell(w, c);
  w.varint(frame.width);
  w.varint(frame.height);
  w.option(frame.cursor, (cur) => {
    w.varint(cur.x);
    w.varint(cur.y);
    w.bool(cur.visible);
    w.u8(cur.shape);
  });
  w.varint(frame.hyperlinks.length);
  for (const link of frame.hyperlinks) w.string(link);
  w.bytes(Buffer.alloc(0));
}

type Rect = { x: number; y: number; width: number; height: number };
type TestPane = {
  paneId: string;
  x: number;
  mouseReporting: boolean;
  rect?: Rect;
  innerRect?: Rect;
  offset?: number;
  maxOffset?: number;
  hasScroll?: boolean;
  contentRevision?: number;
  focused?: boolean;
};
const DEFAULT_PANES: TestPane[] = [
  { paneId: "w1:p1", x: 0, mouseReporting: false },
];

function writePane(
  w: BinWriter,
  paneId: string,
  x = 0,
  y = 0,
  mouseReporting = false,
  rect = { x, y, width: 10, height: 5 },
  innerRect = { x: x + 1, y: y + 1, width: 8, height: 3 },
  offset = 0,
  maxOffset = 100,
  hasScroll = true,
  contentRevision = 1,
  focused = true,
) {
  w.string(paneId);
  w.varint(contentRevision);
  for (const bounds of [rect, innerRect]) {
    w.varint(bounds.x);
    w.varint(bounds.y);
    w.varint(bounds.width);
    w.varint(bounds.height);
  }
  w.bool(false);
  w.bool(hasScroll);
  if (hasScroll) {
    w.varint(offset); // offset_from_bottom
    w.varint(maxOffset); // max_offset_from_bottom
    w.varint(3); // viewport_rows
  }
  w.bool(focused); // focused
  w.bool(mouseReporting);
  w.bool(false);
  w.bool(false);
  w.varint(0);
  w.varint(0);
}

type TestPopup = Pick<Popup, "terminalId" | "title" | "width" | "height">;

function surfaceFrame(
  revision: number,
  frame: FrameData,
  panes = DEFAULT_PANES,
  popup: TestPopup | null = null,
): Buffer {
  const w = new BinWriter();
  w.variant(13);
  w.string("boot-1");
  w.varint(1);
  w.varint(revision);
  writeFrame(w, frame);
  w.varint(panes.length);
  for (const pane of panes)
    writePane(
      w,
      pane.paneId,
      pane.x,
      0,
      pane.mouseReporting,
      pane.rect,
      pane.innerRect,
      pane.offset,
      pane.maxOffset,
      pane.hasScroll,
      pane.contentRevision,
      pane.focused,
    );
  w.varint(0); // splits
  w.option(popup, (value) => {
    w.string(value.terminalId);
    w.string(value.title);
    for (const size of [value.width, value.height]) {
      w.option(size, (dimension) => {
        w.variant(dimension.kind === "cells" ? 0 : 1);
        if (dimension.kind === "cells") w.varint(dimension.value);
        else w.u8(dimension.value);
      });
    }
    writeFrame(w, frame);
    w.bool(false);
    w.bool(false);
    w.varint(0);
    w.varint(0);
  });
  w.varint(0); // graphics assets
  w.varint(0); // graphics placements
  w.varint(0); // retained assets
  return w.toBuffer();
}

function controlFrame(kind: string, data: string): Buffer {
  const w = new BinWriter();
  w.variant(20);
  w.string(kind);
  w.string(data);
  return w.toBuffer();
}

const WELCOME = {
  generation: 1,
  server_version: "0.9.0",
  snapshot_codec: "shell.snapshot.v1",
  surface_codec: "shell.surface.v1",
  input_codec: "shell.input.semantic.v1",
  blob_codec: "shell.blob.v1",
  methods: ["pane.focus", "pane.scroll"],
  capabilities: ["health_check"],
};

/**
 * Fake endpoint server that answers the handshake, sends a snapshot, answers
 * endpoint requests, and streams a two-pane surface.
 */
async function startSessionServer(handlers: {
  onHello?: (hello: any) => void;
  onRequest?: (method: string, params: any, connection: number) => unknown;
  methods?: string[] | ((connection: number) => string[]);
  capabilities?: (connection: number) => string[];
  onPaneInput?: (paneId: string, reader: BinReader) => void;
  panes?: TestPane[];
  onConnection?: (
    sendSurface: (panes: TestPane[], frame?: FrameData) => void,
  ) => void;
  onPatchConnection?: (
    send: (cursor: FrameData["cursor"], panes: TestPane[]) => void,
  ) => void;
  onClipboardConnection?: (send: (data: string) => void) => void;
  onDisconnectConnection?: (disconnect: () => void) => void;
  onControlConnection?: (send: (kind: string, data: string) => void) => void;
  initialSurface?: { frame: FrameData; panes: TestPane[] };
  popupForSurface?: () => TestPopup | null;
  surfaceForHello?: (
    cols: number,
    rows: number,
  ) => { frame: FrameData; panes: TestPane[] };
  onResize?: (
    cols: number,
    rows: number,
    send: (frame: FrameData, panes: TestPane[]) => void,
  ) => void;
}) {
  const socketPath = path.join(
    tmpdir(),
    `herdr-gui-eps-${process.pid}-${crypto.randomUUID()}.sock`,
  );
  const frame: FrameData = {
    // Tab surface 10x5; pane w1:p1 inner rect is 1,1 8x3 => "abcdefgh" rows.
    cells: Array.from({ length: handlers.panes ? 100 : 50 }, (_, i) =>
      cell(String.fromCharCode(65 + (i % 26))),
    ),
    width: handlers.panes ? 20 : 10,
    height: 5,
    cursor: { x: 2, y: 2, visible: true, shape: 1 },
    hyperlinks: [],
  };
  let connectionSeq = 0;
  const server = net.createServer((socket) => {
    socket.on("error", (error: NodeJS.ErrnoException) => {
      expect(["EPIPE", "ECONNRESET"]).toContain(error.code ?? "");
    });
    const connection = ++connectionSeq;
    handlers.onDisconnectConnection?.(() => socket.destroy());
    handlers.onControlConnection?.((kind, data) =>
      socket.write(encodeFrame(controlFrame(kind, data))),
    );
    handlers.onClipboardConnection?.((data) => {
      const w = new BinWriter();
      w.variant(5);
      w.string(data);
      socket.write(encodeFrame(w.toBuffer()));
    });
    let input = Buffer.alloc(0);
    let greeted = false;
    let revision = 1;
    handlers.onConnection?.(
      (panes, nextFrame = handlers.initialSurface?.frame ?? frame) =>
        socket.write(
          encodeFrame(
            surfaceFrame(
              ++revision,
              nextFrame,
              panes,
              handlers.popupForSurface?.(),
            ),
          ),
        ),
    );
    handlers.onPatchConnection?.((cursor, panes) => {
      const w = new BinWriter();
      w.variant(19); // PaneSurfacePatch
      w.string("boot-1");
      w.varint(1); // projection_revision
      w.varint(revision);
      w.varint(++revision);
      w.varint(0); // cursor/metadata-only patch: no changed rows
      w.varint(panes.length);
      for (const pane of panes)
        writePane(
          w,
          pane.paneId,
          pane.x,
          0,
          pane.mouseReporting,
          pane.rect,
          pane.innerRect,
        );
      w.option(cursor, (cur) => {
        w.varint(cur.x);
        w.varint(cur.y);
        w.bool(cur.visible);
        w.u8(cur.shape);
      });
      socket.write(encodeFrame(w.toBuffer()));
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
        if (!greeted) {
          greeted = true;
          reader.string(); // kind
          const hello = JSON.parse(reader.string());
          handlers.onHello?.(hello);
          const initialSurface =
            handlers.surfaceForHello?.(
              hello.surface_size.cols,
              hello.surface_size.rows,
            ) ?? handlers.initialSurface;
          socket.write(
            encodeFrame(
              controlFrame(
                "endpoint.welcome.v1",
                JSON.stringify({
                  ...WELCOME,
                  capabilities:
                    handlers.capabilities?.(connection) ?? WELCOME.capabilities,
                  methods:
                    typeof handlers.methods === "function"
                      ? handlers.methods(connection)
                      : (handlers.methods ?? WELCOME.methods),
                }),
              ),
            ),
          );
          socket.write(
            encodeFrame(
              controlFrame(
                "shell.snapshot.v1",
                JSON.stringify({ boot_id: "boot-1", revision: 1 }),
              ),
            ),
          );
          socket.write(
            encodeFrame(
              surfaceFrame(
                1,
                initialSurface?.frame ?? frame,
                initialSurface?.panes ?? handlers.panes,
                handlers.popupForSurface?.(),
              ),
            ),
          );
          continue;
        }
        if (variant === 15) {
          // ClientShellEndpointRequest
          reader.string(); // boot_id
          const request = JSON.parse(reader.string());
          void Promise.resolve()
            .then(() =>
              handlers.onRequest?.(request.method, request.params, connection),
            )
            .then(
              (result) => sendResponse({ result: result ?? {} }),
              (error) => sendResponse({ error: { message: String(error) } }),
            );
          function sendResponse(response: object) {
            const w = new BinWriter();
            w.variant(18);
            w.string("boot-1");
            w.string(request.id);
            w.bool(true);
            w.bytes(
              Buffer.from(JSON.stringify({ id: request.id, ...response })),
            );
            socket.write(encodeFrame(w.toBuffer()));
          }
        } else if (variant === 12) {
          reader.varint(); // cell_width_px
          reader.varint(); // cell_height_px
          const cols = reader.varint();
          const rows = reader.varint();
          handlers.onResize?.(cols, rows, (nextFrame, panes) =>
            socket.write(
              encodeFrame(surfaceFrame(++revision, nextFrame, panes)),
            ),
          );
        } else if (variant === 13) {
          const paneId = reader.string();
          handlers.onPaneInput?.(paneId, reader);
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

test("popup identity updates without any attached pane viewer", async () => {
  const frame: FrameData = {
    cells: [cell("x")],
    width: 1,
    height: 1,
    cursor: null,
    hyperlinks: [],
  };
  let popup: TestPopup | null = {
    terminalId: "floating",
    title: "Float",
    width: { kind: "percent", value: 80 },
    height: { kind: "cells", value: 20 },
  };
  let sendSurface!: (panes: TestPane[], frame?: FrameData) => void;
  let greeted = false;
  let observerWorkspace = "other";
  const socketPath = await startSessionServer({
    initialSurface: { frame, panes: [] },
    methods: [...WELCOME.methods, "workspace.focus"],
    popupForSurface: () =>
      observerWorkspace === "floating-workspace" ? popup : null,
    onRequest: (method, params) => {
      if (method === "workspace.focus") {
        observerWorkspace = params.workspace_id;
        sendSurface([], frame);
      }
      return {};
    },
    onHello: () => {
      greeted = true;
    },
    onConnection: (send) => {
      sendSurface = send;
    },
  });
  const pushes: Array<{ popup: { terminal_id: string } | null }> = [];
  const replies: Array<{ result: { popup: { terminal_id: string } | null } }> =
    [];
  const bridge = createTerminalBridge({
    clientSocketPath: socketPath,
    herdrProtocol: async () => 22,
    lookupPaneId: async () => null,
    focusedWorkspaceId: async () => "floating-workspace",
    broadcast: (payload) => pushes.push(JSON.parse(payload)),
    safeSend: (_ws, payload) => {
      replies.push(JSON.parse(payload));
      return true;
    },
    clientLabel: () => "test",
    markRpcError: () => {},
  });
  try {
    const ws = {} as ServerWebSocket<unknown>;
    await bridge.handleTerminalRpc(ws, "watch", "terminal.watch_popup", {});
    await settleUntil(
      () =>
        greeted &&
        pushes.some((push) => push.popup?.terminal_id === "floating"),
    );
    await bridge.handleTerminalRpc(ws, "watch2", "terminal.watch_popup", {});
    expect(observerWorkspace).toBe("floating-workspace");
    expect(replies.at(-1)?.result.popup?.terminal_id).toBe("floating");
    popup = null;
    sendSurface([], frame);
    await settleUntil(() => pushes.at(-1)?.popup === null);
    expect(pushes.map((push) => push.popup?.terminal_id ?? null)).toEqual([
      "floating",
      null,
    ]);
  } finally {
    bridge.dispose();
  }
});

test.each(["cursor only", "other split pane"])(
  "restores a hidden cursor when a patch updates %s",
  async (update) => {
    const initial: FrameData = {
      cells: Array.from({ length: 100 }, () => cell(" ")),
      width: 20,
      height: 5,
      cursor: null,
      hyperlinks: [],
    };
    const panes = [
      { paneId: "w1:p1", x: 0, mouseReporting: false },
      { paneId: "w1:p2", x: 10, mouseReporting: true },
    ];
    let sendPatch!: (cursor: FrameData["cursor"], panes: TestPane[]) => void;
    const socketPath = await startSessionServer({
      initialSurface: { frame: initial, panes },
      onPatchConnection: (send) => {
        sendPatch = send;
      },
    });
    const session = new EndpointTerminalSession(
      socketPath,
      "terminal",
      async () => "w1:p1",
    );
    const frames: Array<{
      frame: FrameData;
      bytes: Buffer;
      mouseReporting: boolean;
    }> = [];
    session.on("terminal", (frame) => frames.push(frame));
    try {
      await session.connect(8, 3, { cols: 20, rows: 5 });
      expect(frames.at(-1)?.bytes.toString()).toEndWith("\x1b[?25l");
      const changedPanes = update === "cursor only" ? [] : [panes[1]];
      const visible = { x: 2, y: 2, visible: true, shape: 5 };
      for (const cursor of [
        visible,
        null,
        { ...visible, visible: false },
        { ...visible, x: 3 },
      ]) {
        const count = frames.length;
        sendPatch(cursor, changedPanes);
        await Bun.sleep(50);
        expect(frames).toHaveLength(count + 1);
        const result = frames.at(-1)!;
        expect(result.frame.cursor).toEqual(
          cursor ? { ...cursor, x: cursor.x - 1, y: cursor.y - 1 } : null,
        );
        expect(result.mouseReporting).toBe(false);
        expect(result.bytes.toString()).toEndWith(
          cursor?.visible ? "\x1b[5 q\x1b[?25h" : "\x1b[?25l",
        );
      }
    } finally {
      session.close();
    }
  },
);

function splitSurface(cols: number, rows: number, count = 2) {
  const frame: FrameData = {
    width: cols,
    height: rows,
    cells: Array.from({ length: cols * rows }, () => cell("x")),
    cursor: null,
    hyperlinks: [],
  };
  const panes = Array.from({ length: count }, (_, index) => {
    const x = Math.floor((cols * index) / count);
    const width = Math.floor((cols * (index + 1)) / count) - x;
    return {
      paneId: `w1:p${index + 1}`,
      x,
      mouseReporting: false,
      rect: { x, y: 0, width, height: rows },
      innerRect: { x: x + 1, y: 1, width: width - 3, height: rows - 2 },
    };
  });
  return { frame, panes };
}

describe("EndpointTerminalSession", () => {
  test("emits absolute history coordinates with the corresponding pane frame", async () => {
    const socketPath = await startSessionServer({});
    const session = new EndpointTerminalSession(
      socketPath,
      "terminal",
      async () => "w1:p1",
    );
    const frames: any[] = [];
    session.on("terminal", (frame) => frames.push(frame));
    try {
      await session.connect(8, 3, { cols: 10, rows: 5 });
      expect(frames.at(-1)).toMatchObject({
        width: 8,
        height: 3,
        history: { revision: 1, top: 100, total: 103, cols: 8, rows: 3 },
      });
    } finally {
      session.close();
    }
  });

  test.each([
    { cols: 252, rows: 26, count: 3, expected: [249, 26] },
    { cols: 166, rows: 27, count: 2, expected: [166, 26] },
  ])("corrects a one-cell overshoot ($cols x $rows)", async (initial) => {
    const resizes: number[][] = [];
    const socketPath = await startSessionServer({
      surfaceForHello: (cols, rows) => splitSurface(cols, rows, initial.count),
      onResize: (cols, rows, send) => {
        resizes.push([cols, rows]);
        const next = splitSurface(cols, rows, initial.count);
        send(next.frame, next.panes);
      },
    });
    const session = new EndpointTerminalSession(
      socketPath,
      "terminal",
      async () => "w1:p1",
    );
    const frames: Array<{ width: number; height: number }> = [];
    session.on("terminal", (frame) => frames.push(frame));
    try {
      await session.connect(80, 24, { cols: initial.cols, rows: initial.rows });
      await Bun.sleep(60);
      expect(resizes).toEqual([[...initial.expected]]);
      expect(frames.at(-1)).toMatchObject({ width: 80, height: 24 });
    } finally {
      session.close();
    }
  });

  test.each([
    [2, 0],
    [2, 1],
    [3, 1],
  ])(
    "first visible frame fits a %i-way split pane %i without an extra viewer resize",
    async (count, index) => {
      const cols = count === 3 ? 135 : 134;
      const initial = splitSurface(cols, 69, count);
      const requested = Promise.withResolvers<() => void>();
      const socketPath = await startSessionServer({
        initialSurface: initial,
        onResize: (cols, rows, send) => {
          const settled = splitSurface(cols, rows, count);
          send(initial.frame, initial.panes);
          requested.resolve(() => send(settled.frame, settled.panes));
        },
      });
      const session = new EndpointTerminalSession(
        socketPath,
        "terminal",
        async () => initial.panes[index].paneId,
      );
      const frames: Array<{ width: number; height: number }> = [];
      session.on("terminal", (frame) => frames.push(frame));
      jest.useFakeTimers();
      try {
        await session.connect(cols, 69);
        const settle = await requested.promise;
        jest.advanceTimersByTime(60);
        expect(frames).toEqual([]);
        const rendered = once(session, "terminal");
        settle();
        await rendered;
        expect(frames).toEqual([
          expect.objectContaining({ width: cols, height: 69 }),
        ]);
        jest.advanceTimersByTime(550);
        expect(frames).toHaveLength(1); // no stale timer repaint
      } finally {
        session.close();
        jest.useRealTimers();
      }
    },
  );

  test("continuous stale frames cannot extend the first-frame deadline", async () => {
    const initial = splitSurface(134, 69);
    const requested = Promise.withResolvers<(reporting: boolean) => void>();
    const socketPath = await startSessionServer({
      initialSurface: initial,
      onResize: (_cols, _rows, send) =>
        requested.resolve((reporting) =>
          send(
            initial.frame,
            initial.panes.map((pane) => ({
              ...pane,
              mouseReporting: reporting,
            })),
          ),
        ),
    });
    const session = new EndpointTerminalSession(
      socketPath,
      "terminal",
      async () => "w1:p1",
    );
    const frames: Array<{ width: number; mouseReporting: boolean }> = [];
    session.on("terminal", (frame) => frames.push(frame));
    jest.useFakeTimers();
    try {
      await session.connect(134, 69);
      const send = await requested.promise;
      expect(frames).toEqual([]);
      for (let i = 0; i < 7; i++) {
        send(true);
        // The reply shares the socket with surfaces: drain the sent frame
        // before advancing its deadline, without a wall-clock sleep.
        await session.focus(() => true);
        jest.advanceTimersByTime(100);
        if (i < 4) expect(frames).toEqual([]);
      }
      expect(frames.length).toBeGreaterThan(0);
      expect(frames.at(-1)).toEqual(
        expect.objectContaining({ width: 64, mouseReporting: true }),
      );
      send(false);
      await session.focus(() => true);
      expect(frames.at(-1)?.mouseReporting).toBe(false);
    } finally {
      session.close();
      jest.useRealTimers();
    }
  });

  test.each(["local", "remote"])(
    "%s close cancels a pending first frame",
    async (side) => {
      const initial = splitSurface(134, 69);
      const requested = Promise.withResolvers<void>();
      let disconnect!: () => void;
      const socketPath = await startSessionServer({
        initialSurface: initial,
        onDisconnectConnection: (close) => {
          disconnect = close;
        },
        onResize: () => requested.resolve(),
      });
      const session = new EndpointTerminalSession(
        socketPath,
        "terminal",
        async () => "w1:p1",
      );
      const frames: unknown[] = [];
      session.on("terminal", (frame) => frames.push(frame));
      jest.useFakeTimers();
      try {
        await session.connect(134, 69);
        await requested.promise;
        expect(frames).toEqual([]);
        const closed = once(session, "close");
        if (side === "local") session.close();
        else disconnect();
        await closed;
        jest.advanceTimersByTime(600);
        expect(session.isClosed).toBe(true);
        expect(frames).toEqual([]);
      } finally {
        session.close();
        jest.useRealTimers();
      }
    },
  );
  test.each([
    ["single pane", 1, 1, 0, 1],
    ["stacked panes", 1, 0.5, 2, 3],
    ["three stacked panes", 1, 1 / 3, 2, 3],
    ["side-by-side panes", 0.5, 1, 2, 3],
    ["unequal nested splits", 0.3, 0.25, 2, 3],
  ] as const)(
    "fits pane content through a full-tab surface: %s",
    async (_name, widthRatio, heightRatio, rowChrome, colChrome) => {
      const makeSurface = (cols: number, rows: number) => {
        const rect = {
          x: 0,
          y: 0,
          width: Math.floor(cols * widthRatio),
          height: Math.floor(rows * heightRatio),
        };
        const innerRect = {
          x: colChrome > 1 ? 1 : 0,
          y: rowChrome > 0 ? 1 : 0,
          width: rect.width - colChrome,
          height: rect.height - rowChrome,
        };
        return {
          frame: {
            width: cols,
            height: rows,
            cells: Array.from({ length: cols * rows }, () => cell(" ")),
            cursor: null,
            hyperlinks: [],
          } satisfies FrameData,
          panes: [
            { paneId: "w1:p1", x: 0, mouseReporting: false, rect, innerRect },
          ],
        };
      };
      const resizes: Array<[number, number]> = [];
      const initial = makeSurface(100, 30);
      const socketPath = await startSessionServer({
        initialSurface: initial,
        onResize: (cols, rows, send) => {
          resizes.push([cols, rows]);
          // A queued old surface must not cause another correction.
          send(initial.frame, initial.panes);
          const next = makeSurface(cols, rows);
          send(next.frame, next.panes);
        },
      });
      const session = new EndpointTerminalSession(
        socketPath,
        "term_1",
        async () => "w1:p1",
      );
      const waitForSize = (width: number, height: number) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            session.off("terminal", onFrame);
            reject(new Error(`missing ${width}x${height} frame`));
          }, 2000);
          const onFrame = (frame: { width: number; height: number }) => {
            if (frame.width !== width || frame.height !== height) return;
            clearTimeout(timer);
            session.off("terminal", onFrame);
            resolve();
          };
          session.on("terminal", onFrame);
        });
      try {
        await session.connect(100, 30);
        // The viewer attach drives convergence: one targeted resize, at
        // most one rounding follow-up, and the crop lands on the pane size.
        const resized = waitForSize(81, 25);
        session.resize(81, 25);
        await resized;
        // Boot correction + the attach resize + at most one rounding
        // follow-up; never an iterative chase.
        expect(resizes.length).toBeLessThanOrEqual(3);
        const refreshed = waitForSize(81, 25);
        session.resize(81, 25);
        await refreshed;
      } finally {
        session.close();
      }
    },
  );

  test("defers pane fitting while surfaces lack the pane", async () => {
    // Focus transits through tabs that do not contain the pane. Resizing
    // from those foreign geometries reflows the whole tab and shows up as
    // panes first rendering narrow, then expanding.
    const other = {
      frame: {
        width: 48,
        height: 12,
        cells: Array.from({ length: 48 * 12 }, () => cell(" ")),
        cursor: null,
        hyperlinks: [],
      } satisfies FrameData,
      panes: [
        {
          paneId: "w1:other",
          x: 0,
          mouseReporting: false,
          rect: { x: 0, y: 0, width: 48, height: 12 },
          innerRect: { x: 0, y: 1, width: 47, height: 11 },
        },
      ],
    };
    const own = {
      frame: {
        width: 120,
        height: 40,
        cells: Array.from({ length: 120 * 40 }, () => cell(" ")),
        cursor: null,
        hyperlinks: [],
      } satisfies FrameData,
      panes: [
        {
          paneId: "w1:p1",
          x: 0,
          mouseReporting: false,
          rect: { x: 0, y: 0, width: 120, height: 40 },
          innerRect: { x: 0, y: 1, width: 119, height: 39 },
        },
      ],
    };
    const resizes: Array<[number, number]> = [];
    const socketPath = await startSessionServer({
      initialSurface: other,
      onResize: (cols, rows, send) => {
        resizes.push([cols, rows]);
        send(own.frame, own.panes);
      },
    });
    const session = new EndpointTerminalSession(
      socketPath,
      "term_1",
      async () => "w1:p1",
      silentLogger,
      150,
    );
    const frames: Array<{ width: number; height: number }> = [];
    session.on("terminal", (t) => frames.push(t));
    try {
      // The foreign surface never contains the pane, so connect times out
      // rather than fitting against the wrong tab geometry.
      await expect(session.connect(119, 39)).rejects.toThrow(
        "timed out waiting for endpoint surface",
      );
      // No resize may derive from the foreign 48x12 geometry.
      expect(resizes).toEqual([]);
      expect(frames).toEqual([]);
    } finally {
      session.close();
    }
  });

  test("ignores stale surfaces while a viewer resize is in flight", async () => {
    // Split-pane attach: the viewer asks for the settled pane size while the
    // server still streams pre-resize frames. Fitting against that stale
    // ratio reflows the whole tab away from the requested size.
    const makeSurface = (cols: number, rows: number, innerW: number) => ({
      frame: {
        width: cols,
        height: rows,
        cells: Array.from({ length: cols * rows }, () => cell(" ")),
        cursor: null,
        hyperlinks: [],
      } satisfies FrameData,
      panes: [
        {
          paneId: "w1:p1",
          x: 0,
          mouseReporting: false,
          rect: { x: 0, y: 0, width: Math.floor(cols / 2), height: rows },
          innerRect: { x: 0, y: 1, width: innerW, height: rows - 2 },
        },
      ],
    });
    const stale = makeSurface(134, 69, 64); // pre-resize split geometry
    const settled = makeSurface(136, 70, 133); // after applying 136x70
    const resizes: Array<[number, number]> = [];
    const socketPath = await startSessionServer({
      initialSurface: stale,
      onResize: (cols, rows, send) => {
        resizes.push([cols, rows]);
        send(stale.frame, stale.panes); // in-flight stale frames
        if (cols === 136 && rows === 70) send(settled.frame, settled.panes);
      },
    });
    const session = new EndpointTerminalSession(
      socketPath,
      "term_1",
      async () => "w1:p1",
    );
    try {
      await session.connect(134, 69);
      session.resize(134, 69);
      await Bun.sleep(100);
      // The attach resize carries the wanted pane size once; stale frames
      // arriving while it is in flight must not trigger another resize.
      expect(resizes.length).toBeLessThanOrEqual(2);
      expect(resizes.every(([c, r]) => c === 274 && r === 71)).toBe(true);
    } finally {
      session.close();
    }
  });

  test("focuses the pane and emits cropped ANSI terminal frames", async () => {
    const requests: Array<{ method: string; params: any }> = [];
    const socketPath = await startSessionServer({
      onRequest: (method, params) => requests.push({ method, params }),
    });
    const session = new EndpointTerminalSession(
      socketPath,
      "term_1",
      async (terminalId) => (terminalId === "term_1" ? "w1:p1" : null),
    );
    const frames: Array<{
      width: number;
      height: number;
      full: boolean;
      text: string;
    }> = [];
    session.on("terminal", (t) =>
      frames.push({
        width: t.width,
        height: t.height,
        full: t.full,
        text: t.bytes.toString("utf8"),
      }),
    );
    await session.connect(80, 24);

    expect(requests).toEqual([
      { method: "pane.focus", params: { pane_id: "w1:p1" } },
    ]);
    expect(frames.length).toBeGreaterThan(0);
    const first = frames[0];
    expect(first.width).toBe(8);
    expect(first.height).toBe(3);
    expect(first.full).toBe(true);
    // Cropped content: inner rect starts at (1,1) of the 10x5 grid,
    // so the first row is cells 11-18 (L..S).
    expect(first.text).toContain("LMNOPQRS");
    // Cursor was at (2,2) in tab space -> (1,1) in crop space.
    expect(first.text).toContain("\x1b[2;2H");
    session.close();
  });

  test("rejects connect when the terminal has no pane", async () => {
    const socketPath = await startSessionServer({});
    const session = new EndpointTerminalSession(
      socketPath,
      "term_x",
      async () => null,
    );
    await expect(session.connect(80, 24)).rejects.toThrow("no pane found");
  });

  test("classifies input and sends pane.scroll with absolute offsets", async () => {
    const requests: Array<{ method: string; params: any }> = [];
    const inputs: string[] = [];
    const socketPath = await startSessionServer({
      onRequest: (method, params) => requests.push({ method, params }),
      onPaneInput: (paneId, reader) => {
        expect(paneId).toBe("w1:p1");
        const count = reader.varint();
        for (let i = 0; i < count; i++) {
          const v = reader.variant();
          if (v === 1) inputs.push(`text:${reader.string()}`);
          else if (v === 3) inputs.push(`paste:${reader.string()}`);
          else inputs.push(`key:${v}`);
        }
      },
    });
    const session = new EndpointTerminalSession(
      socketPath,
      "term_1",
      async () => "w1:p1",
    );
    await session.connect(80, 24);
    session.input(Buffer.from("hi"));
    session.scroll("up", 3);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(inputs).toContain("text:hi");
    expect(requests).toContainEqual({
      method: "pane.scroll",
      params: { pane_id: "w1:p1", offset_from_bottom: 3 },
    });
    session.close();
  });
});

test("endpoint mouse stays pane-local and mode changes route application input versus history", async () => {
  const panes: TestPane[] = [
    { paneId: "w1:p1", x: 0, mouseReporting: false },
    { paneId: "w1:p2", x: 10, mouseReporting: true },
  ];
  const inputs: Array<{
    paneId: string;
    kind: number;
    column: number;
    row: number;
  }> = [];
  const requests: Array<{ method: string; params: unknown }> = [];
  const senders: Array<(panes: TestPane[]) => void> = [];
  const socketPath = await startSessionServer({
    panes,
    onConnection: (send) => senders.push(send),
    onRequest: (method, params) => requests.push({ method, params }),
    onPaneInput: (paneId, reader) => {
      const count = reader.varint();
      for (let i = 0; i < count; i++) {
        expect(reader.variant()).toBe(2);
        const kind = reader.variant();
        if (kind <= 2) reader.variant();
        expect(reader.variant()).toBe(0);
        const column = reader.varint();
        const row = reader.varint();
        expect(reader.bool()).toBe(false);
        reader.u8();
        reader.varint();
        inputs.push({ paneId, kind, column, row });
      }
    },
  });
  const left = new EndpointTerminalSession(
    socketPath,
    "term-left",
    async () => "w1:p1",
  );
  const right = new EndpointTerminalSession(
    socketPath,
    "term-right",
    async () => "w1:p2",
  );
  const modes: boolean[] = [];
  right.on("terminal", (frame) => modes.push(frame.mouseReporting));
  try {
    // These input fixtures have fixed 8x3 content, not a resizing layout.
    await left.connect(8, 3);
    await right.connect(8, 3);
    const clickDragWheel = Buffer.from(
      "\x1b[<0;2;3M\x1b[<32;3;2M\x1b[<0;3;2m\x1b[<64;8;3M",
    );
    left.input(clickDragWheel); // no mouse reporting in this pane
    right.input(clickDragWheel);
    right.input(Buffer.from("\x1b[<0;9;1M\x1b[<0;1;4M")); // outside 8x3 crop
    right.scroll("down", 3, 1, 2);
    left.scroll("up", 3, 1, 2);
    await Bun.sleep(40);
    expect(inputs).toEqual([
      { paneId: "w1:p2", kind: 0, column: 1, row: 2 },
      { paneId: "w1:p2", kind: 2, column: 2, row: 1 },
      { paneId: "w1:p2", kind: 1, column: 2, row: 1 },
      { paneId: "w1:p2", kind: 4, column: 7, row: 2 },
      { paneId: "w1:p2", kind: 5, column: 1, row: 2 },
    ]);
    expect(requests).toContainEqual({
      method: "pane.scroll",
      params: { pane_id: "w1:p1", offset_from_bottom: 3 },
    });
    // Disable reporting mid-report; no stale mouse is delivered after the mode change.
    right.input(Buffer.from("\x1b[<0;"));
    const disabled = panes.map((pane) => ({ ...pane, mouseReporting: false }));
    for (const send of senders) send(disabled);
    await Bun.sleep(40);
    right.input(Buffer.from("2;3M"));
    right.scroll("up", 4, 1, 2);
    right.scroll("up", Number.NaN);
    await Bun.sleep(40);
    expect(inputs).toHaveLength(5);
    expect(modes).toContain(true);
    expect(modes.at(-1)).toBe(false);
    expect(requests).toContainEqual({
      method: "pane.scroll",
      params: { pane_id: "w1:p2", offset_from_bottom: 4 },
    });
    for (const send of senders) send(panes);
    await Bun.sleep(40);
    right.input(Buffer.from("\x1b[<0;1;1M"));
    left.input(Buffer.from("\x1b[<0;1;1M"));
    await Bun.sleep(40);
    expect(inputs.at(-1)).toEqual({
      paneId: "w1:p2",
      kind: 0,
      column: 0,
      row: 0,
    });
    expect(inputs).toHaveLength(6);
  } finally {
    left.close();
    right.close();
  }
});

test("accepted presses retain clamped drag and release ownership outside the pane crop", async () => {
  const panes: TestPane[] = [
    { paneId: "w1:p1", x: 0, mouseReporting: true },
    { paneId: "w1:p2", x: 10, mouseReporting: true },
  ];
  const inputs: Array<{
    paneId: string;
    kind: number;
    column: number;
    row: number;
  }> = [];
  let sendSurface!: (panes: TestPane[]) => void;
  const socketPath = await startSessionServer({
    panes,
    onConnection: (send) => {
      sendSurface = send;
    },
    onPaneInput: (paneId, reader) => {
      const count = reader.varint();
      for (let i = 0; i < count; i++) {
        expect(reader.variant()).toBe(2);
        const kind = reader.variant();
        reader.variant(); // button
        expect(reader.variant()).toBe(0);
        const column = reader.varint(),
          row = reader.varint();
        reader.bool();
        reader.u8();
        reader.varint();
        inputs.push({ paneId, kind, column, row });
      }
    },
  });
  const session = new EndpointTerminalSession(
    socketPath,
    "right",
    async () => "w1:p2",
  );
  try {
    await session.connect(20, 5);
    session.input(Buffer.from("\x1b[<0;8;3M\x1b[<32;9;3M\x1b[<0;9;3m"));
    await Bun.sleep(40);
    expect(inputs).toEqual(
      [0, 2, 1].map((kind) => ({ paneId: "w1:p2", kind, column: 7, row: 2 })),
    );
    session.input(Buffer.from("\x1b[<0;9;3M\x1b[<32;8;3M\x1b[<0;8;3m"));
    await Bun.sleep(40);
    expect(inputs).toHaveLength(3); // an outside press cannot acquire ownership
    session.input(Buffer.from("\x1b[<0;8;3M"));
    await Bun.sleep(40);
    sendSurface(panes.map((pane) => ({ ...pane, mouseReporting: false })));
    await Bun.sleep(40);
    sendSurface(panes);
    await Bun.sleep(40);
    session.input(Buffer.from("\x1b[<32;9;3M\x1b[<0;9;3m"));
    await Bun.sleep(40);
    expect(inputs).toHaveLength(4); // mode changes cancel gesture ownership
  } finally {
    session.close();
  }
});

test("terminal bridge carries endpoint mouse state and targets each attached terminal explicitly", async () => {
  const inputs: string[] = [];
  const scrollRequests: unknown[] = [];
  const senders: Array<(panes: TestPane[]) => void> = [];
  const socketPath = await startSessionServer({
    onConnection: (send) => senders.push(send),
    onRequest: (method, params, connection) => {
      if (method === "pane.scroll") {
        scrollRequests.push(params);
        senders[connection - 1]([
          { paneId: "w1:p1", x: 0, mouseReporting: true },
          {
            paneId: "w1:p2",
            x: 10,
            mouseReporting: true,
            offset: params.offset_from_bottom,
          },
        ]);
      }
    },
    panes: [
      { paneId: "w1:p1", x: 0, mouseReporting: true },
      { paneId: "w1:p2", x: 10, mouseReporting: true },
    ],
    onPaneInput: (paneId) => inputs.push(paneId),
  });
  const frames: Array<{ terminal_id: string; mouse_reporting: boolean }> = [];
  const errors: string[] = [];
  const ws = {} as ServerWebSocket<unknown>;
  const bridge = createTerminalBridge({
    clientSocketPath: socketPath,
    herdrProtocol: async () => 22,
    lookupPaneId: async (id) => (id === "left" ? "w1:p1" : "w1:p2"),
    safeSend: (_ws, payload) => {
      const message = JSON.parse(payload);
      if (message.terminal) frames.push(message.terminal);
      return true;
    },
    clientLabel: () => "test",
    markRpcError: (_ws, _id, detail) => errors.push(detail ?? "error"),
  });
  try {
    for (const terminalId of ["left", "right"]) {
      await bridge.handleTerminalRpc(ws, "attach", "terminal.attach", {
        terminal_id: terminalId,
        cols: 8,
        rows: 3,
        relay_active: false,
      });
    }
    expect(frames).toContainEqual(
      expect.objectContaining({ terminal_id: "left", mouse_reporting: true }),
    );
    expect(frames).toContainEqual(
      expect.objectContaining({ terminal_id: "right", mouse_reporting: true }),
    );
    for (const terminalId of ["left", "right", "unattached"]) {
      await bridge.handleTerminalRpc(ws, "input", "terminal.input", {
        terminal_id: terminalId,
        data: Buffer.from("\x1b[<0;2;2M").toString("base64"),
      });
    }
    await Bun.sleep(40);
    // Each pane has its own socket; delivery order across sockets is undefined.
    expect(inputs.toSorted()).toEqual(["w1:p1", "w1:p2"]);
    expect(errors).toHaveLength(1);
    for (const [direction, source] of [
      ["up", "history"],
      ["down", "history"],
      ["up", "page-key"],
    ]) {
      const beforeScrolls = scrollRequests.length;
      const beforeInputs = inputs.length;
      await bridge.handleTerminalRpc(ws, "history", "terminal.scroll", {
        terminal_id: "right",
        direction,
        lines: 7,
        source,
      });
      // Verify each routing mode separately; bursts intentionally coalesce.
      if (source === "page-key")
        await settleUntil(() => inputs.length > beforeInputs);
      else await settleUntil(() => scrollRequests.length > beforeScrolls);
    }
    await Bun.sleep(40);
    expect(scrollRequests).toEqual([
      { pane_id: "w1:p2", offset_from_bottom: 7 },
      { pane_id: "w1:p2", offset_from_bottom: 0 },
    ]);
    expect(inputs).toHaveLength(3);
    expect(inputs.at(-1)).toBe("w1:p2");
  } finally {
    bridge.dispose();
  }
});

test("split tab reattach uses the full surface in every endpoint hello", async () => {
  const hellos: Array<[number, number]> = [];
  const resizes: Array<[number, number]> = [];
  const socketPath = await startSessionServer({
    surfaceForHello: (cols, rows) => {
      hellos.push([cols, rows]);
      return splitSurface(cols, rows);
    },
    onResize: (cols, rows, send) => {
      resizes.push([cols, rows]);
      const next = splitSurface(cols, rows);
      send(next.frame, next.panes);
    },
  });
  const frames: Array<{ width: number; height: number }> = [];
  const errors: string[] = [];
  const ws = {} as ServerWebSocket<unknown>;
  const bridge = createTerminalBridge({
    clientSocketPath: socketPath,
    herdrProtocol: async () => 22,
    lookupPaneId: async (id) => (id === "left" ? "w1:p1" : "w1:p2"),
    safeSend: (_ws, payload) => {
      const message = JSON.parse(payload);
      if (message.terminal)
        frames.push({
          width: message.terminal.width,
          height: message.terminal.height,
        });
      return true;
    },
    clientLabel: () => "test",
    markRpcError: (_ws, _id, error) => errors.push(error ?? "error"),
  });
  try {
    for (let visit = 0; visit < 2; visit++) {
      for (const id of ["left", "right"]) {
        await bridge.handleTerminalRpc(ws, "attach", "terminal.attach", {
          terminal_id: id,
          cols: 134,
          rows: 69,
          surface_cols: 274,
          surface_rows: 71,
          relay_active: false,
        });
      }
      await Bun.sleep(40);
      expect(errors).toEqual([]);
      expect(frames.length).toBeGreaterThan(0);
      expect(
        frames.every((frame) => frame.width === 134 && frame.height === 69),
      ).toBe(true);
      for (const id of ["left", "right"]) {
        await bridge.handleTerminalRpc(ws, "detach", "terminal.detach", {
          terminal_id: id,
        });
      }
      frames.length = 0;
    }
    expect(hellos).toEqual(Array.from({ length: 4 }, () => [274, 71]));
    expect(resizes).toEqual([]);
  } finally {
    bridge.dispose();
  }
});

test("endpoint frames are clipped per viewer and per terminal after resize", async () => {
  const initial = splitSurface(26, 6);
  const socketPath = await startSessionServer({
    initialSurface: initial,
    onResize: (_cols, _rows, send) => send(initial.frame, initial.panes),
  });
  const small = {} as ServerWebSocket<unknown>;
  const large = {} as ServerWebSocket<unknown>;
  const frames: Array<{
    viewer: ServerWebSocket<unknown>;
    terminal: { terminal_id: string; width: number; height: number };
  }> = [];
  const bridge = createTerminalBridge({
    clientSocketPath: socketPath,
    herdrProtocol: async () => 22,
    lookupPaneId: async (id) => (id === "left" ? "w1:p1" : "w1:p2"),
    safeSend: (viewer, payload) => {
      const message = JSON.parse(payload);
      if (message.terminal) frames.push({ viewer, terminal: message.terminal });
      return true;
    },
    clientLabel: () => "test",
    markRpcError: () => {},
  });
  try {
    for (const [viewer, terminalId, cols, rows] of [
      [small, "left", 6, 2],
      [small, "right", 8, 3],
      [large, "left", 10, 4],
    ] as const) {
      await bridge.handleTerminalRpc(viewer, "attach", "terminal.attach", {
        terminal_id: terminalId,
        cols,
        rows,
        surface_cols: 26,
        surface_rows: 6,
        relay_active: false,
      });
    }
    await Bun.sleep(600);
    for (const [viewer, terminalId, width, height] of [
      [small, "left", 6, 2],
      [small, "right", 8, 3],
      [large, "left", 10, 4],
    ] as const) {
      expect(
        frames.findLast(
          (f) => f.viewer === viewer && f.terminal.terminal_id === terminalId,
        )?.terminal,
      ).toMatchObject({ width, height });
    }
    await bridge.handleTerminalRpc(small, "resize", "terminal.resize", {
      terminal_id: "right",
      cols: 7,
      rows: 2,
      relay_active: false,
    });
    await Bun.sleep(600);
    expect(frames.at(-1)?.terminal).toMatchObject({
      terminal_id: "right",
      width: 7,
      height: 2,
    });
  } finally {
    bridge.dispose();
  }
});

test("invalid initial surface hints are rejected before opening an endpoint", async () => {
  let connections = 0;
  const socketPath = await startSessionServer({
    onConnection: () => {
      connections++;
    },
  });
  const errors: string[] = [];
  const bridge = createTerminalBridge({
    clientSocketPath: socketPath,
    herdrProtocol: async () => 22,
    lookupPaneId: async () => "w1:p1",
    safeSend: () => true,
    clientLabel: () => "test",
    markRpcError: (_ws, _id, error) => errors.push(error ?? "error"),
  });
  try {
    const invalid = [
      { surface_cols: 274 },
      { surface_cols: 274, surface_rows: 0 },
      { surface_cols: -1, surface_rows: 71 },
      { surface_cols: 1.5, surface_rows: 71 },
      { surface_cols: 65536, surface_rows: 71 },
      { surface_cols: "274", surface_rows: 71 },
      { surface_cols: null, surface_rows: 71 },
      { surface_cols: 274, surface_rows: Infinity },
    ];
    for (const hint of invalid) {
      await bridge.handleTerminalRpc(
        {} as ServerWebSocket<unknown>,
        "attach",
        "terminal.attach",
        {
          terminal_id: "terminal",
          cols: 134,
          rows: 69,
          ...hint,
        },
      );
    }
    expect(errors).toHaveLength(invalid.length);
    expect(errors.every((error) => error.includes("surface_cols"))).toBe(true);
    expect(connections).toBe(0);
  } finally {
    bridge.dispose();
  }
});

test.each([
  "terminal.resize",
  "terminal.attach",
  "terminal.detach",
  "stream.close",
  "cleanup",
  "dispose",
] as const)(
  "invalidates coalesced endpoint frames only for their connection and generation on %s",
  async (action) => {
    const peers: Array<(panes: TestPane[], frame?: FrameData) => void> = [];
    const socketPath = await startSessionServer({
      onConnection: (send) => peers.push(send),
    });
    let buffered = WS_COALESCE_LIMIT_BYTES + 1;
    const sent: string[] = [];
    const received = new EventEmitter();
    const latest = new Map<string, string>();
    const browser = {
      close: () => {},
      getBufferedAmount: () => buffered,
      send: (payload: string) => {
        sent.push(payload);
        return payload.length;
      },
    } as unknown as ServerWebSocket<unknown>;
    const cleanup = () => {};
    const identities = [
      { connectionId: "alpha", connectionGeneration: 1 },
      { connectionId: "beta", connectionGeneration: 1 },
      { connectionId: "alpha", connectionGeneration: 2 },
    ];
    const bridges = identities.map((identity) =>
      createTerminalBridge({
        ...identity,
        clientSocketPath: socketPath,
        herdrProtocol: async () => 22,
        lookupPaneId: async () => "w1:p1",
        safeSend: (ws, payload, context, coalesceKey) => {
          const result = sendWebSocketMessage(ws, payload, {
            cleanup,
            context,
            coalesceKey,
          });
          if (JSON.parse(payload).terminal_closed) received.emit("closed");
          if (JSON.parse(payload).terminal) {
            latest.set(
              `${identity.connectionId}:${identity.connectionGeneration}`,
              payload,
            );
            received.emit("frame");
          }
          return result;
        },
        dropCoalesced: dropCoalescedMessage,
        clientLabel: () => "test",
        markRpcError: () => undefined,
      }),
    );
    const params = {
      terminal_id: "same-terminal",
      cols: 8,
      rows: 3,
      relay_active: false,
    };
    const terminalPayloads = () =>
      sent.filter((payload) => JSON.parse(payload).terminal);
    const repaint = async (peer: number, symbol: string) => {
      const ready = once(received, "frame");
      peers[peer](DEFAULT_PANES, {
        cells: Array.from({ length: 50 }, () => cell(symbol)),
        width: 10,
        height: 5,
        cursor: null,
        hyperlinks: [],
      });
      await ready;
    };
    try {
      for (const bridge of bridges) {
        const ready = once(received, "frame");
        await bridge.handleTerminalRpc(
          browser,
          "attach",
          "terminal.attach",
          params,
        );
        await ready;
      }
      await repaint(0, "Z");
      expect(terminalPayloads()).toEqual([]);
      buffered = 0;
      flushCoalescedMessages(browser, { cleanup });
      expect(terminalPayloads().sort()).toEqual([...latest.values()].sort());
      expect(terminalPayloads()).toHaveLength(3);

      // Invalidating alpha's old generation must not discard beta or alpha's new generation.
      sent.length = 0;
      buffered = WS_COALESCE_LIMIT_BYTES + 1;
      for (let i = 0; i < peers.length; i++) await repaint(i, "Y");
      const viewer = action === "terminal.attach" ? { ...browser } : browser;
      if (action === "cleanup") bridges[0].cleanupWs(viewer);
      else if (action === "dispose") bridges[0].dispose();
      else if (action === "stream.close") {
        const closed = once(received, "closed");
        bridges[0].refreshSurfaceCodecs();
        await closed;
        expect(
          sent.some((payload) => JSON.parse(payload).terminal_closed),
        ).toBe(true);
      } else
        await bridges[0].handleTerminalRpc(
          viewer,
          "invalidate",
          action,
          params,
        );
      buffered = 0;
      flushCoalescedMessages(browser, { cleanup });
      expect(terminalPayloads().sort()).toEqual(
        [latest.get("beta:1")!, latest.get("alpha:2")!].sort(),
      );
      if (viewer !== browser) bridges[0].cleanupWs(viewer);
    } finally {
      for (const bridge of bridges) bridge.dispose();
    }
  },
);

test("a delayed close notifies only old viewers and preserves a replacement's held frame", async () => {
  const sessions: EndpointTerminalSession[] = [];
  const originalConnect = EndpointTerminalSession.prototype.connect;
  const connect = spyOn(
    EndpointTerminalSession.prototype,
    "connect",
  ).mockImplementation(function (
    this: EndpointTerminalSession,
    cols: number,
    rows: number,
  ) {
    sessions.push(this);
    return originalConnect.call(this, cols, rows);
  });
  const peers: Array<(panes: TestPane[]) => void> = [];
  const socketPath = await startSessionServer({
    onConnection: (send) => peers.push(send),
  });
  let buffered = WS_COALESCE_LIMIT_BYTES + 1;
  const messages: { viewer: unknown; message: any }[] = [];
  const frames = new EventEmitter();
  const latest = new Map<unknown, string>();
  const viewers = [0, 1].map(() => ({
    close() {},
    getBufferedAmount: () => buffered,
    send(payload: string) {
      messages.push({ viewer: this, message: JSON.parse(payload) });
      return payload.length;
    },
  })) as unknown as ServerWebSocket<unknown>[];
  const bridge = createTerminalBridge({
    clientSocketPath: socketPath,
    herdrProtocol: async () => 22,
    lookupPaneId: async () => "w1:p1",
    safeSend(viewer, payload, context, coalesceKey) {
      const sent = sendWebSocketMessage(viewer, payload, {
        cleanup() {},
        context,
        coalesceKey,
      });
      if (JSON.parse(payload).terminal) {
        latest.set(viewer, payload);
        frames.emit(String(viewers.indexOf(viewer)));
      }
      return sent;
    },
    dropCoalesced: dropCoalescedMessage,
    clientLabel: () => "test",
    markRpcError() {},
  });
  const attach = (index: number) =>
    bridge.handleTerminalRpc(
      viewers[index],
      `attach-${index}`,
      "terminal.attach",
      {
        terminal_id: "term",
        cols: 8,
        rows: 3,
        relay_active: false,
      },
    );
  let restoreEmit: (() => void) | undefined;
  try {
    for (let i = 0; i < viewers.length; i++) {
      const frame = once(frames, String(i));
      await attach(i);
      if (i > 0) peers[0]([{ ...DEFAULT_PANES[0], mouseReporting: true }]);
      await frame;
    }
    const old = sessions[0];
    const emit = old.emit.bind(old);
    const delayedClose = deferred<() => void>();
    const intercepted = spyOn(old, "emit").mockImplementation(
      (event, ...args) => {
        if (event === "close") {
          delayedClose.resolve(() => {
            emit(event, ...args);
          });
          return true;
        }
        return emit(event, ...args);
      },
    );
    restoreEmit = () => intercepted.mockRestore();
    bridge.refreshSurfaceCodecs();
    const deliverClose = await delayedClose.promise;
    const replacementFrame = once(frames, "0");
    await attach(0);
    await replacementFrame;
    expect(sessions).toHaveLength(2);
    messages.length = 0;
    restoreEmit();
    deliverClose();
    expect(
      messages
        .filter(({ message }) => message.terminal_closed)
        .map(({ viewer }) => viewer),
    ).toEqual([viewers[1]]);
    buffered = 0;
    for (const viewer of viewers)
      flushCoalescedMessages(viewer, { cleanup() {} });
    expect(messages.filter(({ message }) => message.terminal)).toEqual([
      { viewer: viewers[0], message: JSON.parse(latest.get(viewers[0])!) },
    ]);
  } finally {
    restoreEmit?.();
    bridge.dispose();
    connect.mockRestore();
  }
});

test("endpoint clipboard follows foreground-recipient ownership, not producing PTY identity", async () => {
  const peers: Array<(data: string) => void> = [];
  const sessions: EndpointTerminalSession[] = [];
  const originalConnect = EndpointTerminalSession.prototype.connect;
  const connect = spyOn(
    EndpointTerminalSession.prototype,
    "connect",
  ).mockImplementation(function (
    this: EndpointTerminalSession,
    cols: number,
    rows: number,
  ) {
    sessions.push(this);
    return originalConnect.call(this, cols, rows);
  });
  const socketPath = await startSessionServer({
    panes: [
      { paneId: "w1:p1", x: 0, mouseReporting: false },
      { paneId: "w1:p2", x: 10, mouseReporting: false },
    ],
    onClipboardConnection: (send) => peers.push(send),
  });
  const ownerA = {} as ServerWebSocket<unknown>;
  const ownerB = {} as ServerWebSocket<unknown>;
  const passive = {} as ServerWebSocket<unknown>;
  const received: Array<{ ws: ServerWebSocket<unknown>; message: any }> = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const makeBridge = (connectionId: string, connectionGeneration = 1) =>
    createTerminalBridge({
      connectionId,
      connectionGeneration,
      clientSocketPath: socketPath,
      herdrProtocol: async () => 22,
      lookupPaneId: async (id) => (id === "left" ? "w1:p1" : "w1:p2"),
      logger: { ...silentLogger, warn: (message) => warnings.push(message) },
      safeSend: (ws, payload) => {
        const message = JSON.parse(payload);
        if (message.terminal_clipboard) received.push({ ws, message });
        return true;
      },
      clientLabel: () => "test",
      markRpcError: (_ws, _id, detail) => errors.push(detail ?? "error"),
    });
  const alpha = makeBridge("alpha");
  const beta = makeBridge("beta");
  const attach = (
    bridge: typeof alpha,
    ws: typeof ownerA,
    terminal_id: string,
  ) =>
    bridge.handleTerminalRpc(ws, "attach", "terminal.attach", {
      terminal_id,
      cols: 20,
      rows: 5,
    });
  const input = (
    bridge: typeof alpha,
    ws: typeof ownerA,
    terminal_id: string,
  ) =>
    bridge.handleTerminalRpc(ws, "input", "terminal.input", {
      terminal_id,
      data: "eA==",
    });
  const deliver = async (peer: number, data = "Y29weQ==") => {
    peers[peer](data);
    await Bun.sleep(20);
  };
  try {
    await attach(alpha, ownerA, "left");
    await attach(alpha, passive, "left");
    await attach(alpha, ownerB, "right");
    await attach(beta, ownerA, "left"); // duplicate ids and same browser, separate connection
    expect(warnings.some((message) => message.includes("unavailable"))).toBe(
      false,
    );
    await deliver(0); // no recent input
    expect(received).toEqual([]);
    await input(alpha, ownerA, "left");
    await deliver(0);
    expect(received).toEqual([
      {
        ws: ownerA,
        message: {
          connection_id: "alpha",
          connection_generation: 1,
          terminal_clipboard: { terminal_id: "left", data: "Y29weQ==" },
        },
      },
    ]);
    received.length = 0;
    await input(alpha, ownerB, "right");
    await deliver(0); // receiving left session no longer matches global input owner
    await deliver(2); // beta has no owner, despite same terminal/browser ids
    expect(received).toEqual([]);
    // Herdr may send a delayed/background LEFT PTY write to foreground RIGHT.
    // The wire has no source id: approved semantics deliver to B, not A.
    const delayedLeft = Buffer.from("delayed left PTY content").toString(
      "base64",
    );
    await deliver(1, delayedLeft);
    expect(received).toEqual([
      {
        ws: ownerB,
        message: {
          connection_id: "alpha",
          connection_generation: 1,
          terminal_clipboard: { terminal_id: "right", data: delayedLeft },
        },
      },
    ]);
    received.length = 0;
    for (const data of ["?", "invalid", "A".repeat(256 * 1024 + 4)])
      await deliver(1, data);
    expect(received).toEqual([]);
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now + 30_001);
    try {
      sessions[1].emit("clipboard", { data: "Y29weQ==" });
    } finally {
      clock.mockRestore();
    }
    expect(received).toEqual([]);
    await input(beta, ownerA, "left");
    await deliver(2);
    expect(received[0].message.connection_id).toBe("beta");
    received.length = 0;
    // Detach one pane while this browser still views another; reattach must
    // not resurrect its prior input owner, even with the same shared session.
    await attach(alpha, ownerA, "right");
    await input(alpha, ownerA, "left");
    await alpha.handleTerminalRpc(ownerA, "detach", "terminal.detach", {
      terminal_id: "left",
    });
    await attach(alpha, ownerA, "left");
    await deliver(0);
    expect(received).toEqual([]);
    await input(alpha, ownerA, "left");
    // A closed transport cannot pass a queued clipboard event to a replacement.
    sessions[0].close();
    await Bun.sleep(20);
    await attach(alpha, ownerA, "left");
    sessions[0].emit("clipboard", { data: "Y29weQ==" });
    await deliver(3);
    expect(received).toEqual([]);
    await input(alpha, ownerA, "left");
    sessions[0].emit("clipboard", { data: "Y29weQ==" });
    expect(received).toEqual([]);
    await deliver(3);
    expect(received).toHaveLength(1);
    expect(received[0].ws).toBe(ownerA);
    received.length = 0;
    alpha.cleanupWs(ownerA);
    sessions[3].emit("clipboard", { data: "Y29weQ==" });
    expect(received).toEqual([]);
    alpha.dispose();
    const replacement = makeBridge("alpha", 2);
    try {
      await attach(replacement, ownerA, "left");
      await input(replacement, ownerA, "left");
      sessions[3].emit("clipboard", { data: "Y29weQ==" });
      expect(received).toEqual([]);
      await deliver(4);
      expect(received[0].message.connection_generation).toBe(2);
      expect(received).toHaveLength(1);
    } finally {
      replacement.dispose();
    }
    expect(received.some(({ ws }) => ws === passive)).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    alpha.dispose();
    beta.dispose();
    connect.mockRestore();
  }
});

describe("cropFrame", () => {
  test("crops cells and repositions the cursor", () => {
    const frame: FrameData = {
      cells: Array.from({ length: 12 }, (_, i) => cell(String(i))),
      width: 4,
      height: 3,
      cursor: { x: 2, y: 1, visible: true, shape: 0 },
      hyperlinks: ["https://example.com"],
    };
    const cropped = cropFrame(frame, { x: 1, y: 1, width: 2, height: 2 });
    expect(cropped.width).toBe(2);
    expect(cropped.height).toBe(2);
    expect(cropped.cells.map((c) => c.symbol)).toEqual(["5", "6", "9", "10"]);
    expect(cropped.cursor).toEqual({ x: 1, y: 0, visible: true, shape: 0 });
    expect(cropped.hyperlinks).toEqual(["https://example.com"]);
  });

  test("drops an out-of-crop cursor and clamps the rect", () => {
    const frame: FrameData = {
      cells: Array.from({ length: 4 }, () => cell("x")),
      width: 2,
      height: 2,
      cursor: { x: 0, y: 0, visible: true, shape: 0 },
      hyperlinks: [],
    };
    const cropped = cropFrame(frame, { x: 1, y: 1, width: 99, height: 99 });
    expect(cropped.width).toBe(1);
    expect(cropped.height).toBe(1);
    expect(cropped.cursor).toBeNull();
  });
});

const creationSource = {
  workspace_id: "w1",
  tab_id: "w1:t1",
  pane_id: "w1:p1",
  terminal_id: "term1",
};
const creationMethods = [
  "pane.focus",
  "pane.scroll",
  "tab.create",
  "workspace.create",
];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function settleUntil(predicate: () => boolean) {
  for (let i = 0; i < 200 && !predicate(); i++) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

test.each(["endpoint.surface-delta.v1", "endpoint.surface-reuse.v1"])(
  "invalid %s notifies only its viewers and reattachment obtains a fresh frame",
  async (kind) => {
    const peers: Array<(kind: string, data: string) => void> = [];
    const socketPath = await startSessionServer({
      capabilities: () => ["surface_delta", "surface_reuse"],
      onControlConnection: (send) => peers.push(send),
    });
    const { bridge, ws, replies } = creationBridge(socketPath);
    const other = {} as ServerWebSocket<unknown>;
    try {
      await bridge.handleTerminalRpc(ws, "attach-a", "terminal.attach", {
        terminal_id: "a",
        cols: 8,
        rows: 3,
      });
      await bridge.handleTerminalRpc(other, "attach-b", "terminal.attach", {
        terminal_id: "b",
        cols: 8,
        rows: 3,
      });
      const before = replies.filter(
        (r) => r.terminal?.terminal_id === "a",
      ).length;
      peers[0](kind, "invalid");
      await settleUntil(() => replies.some((r) => r.terminal_closed));
      expect(
        replies
          .filter((r) => r.terminal_closed)
          .map((r) => r.terminal_closed.terminal_id),
      ).toEqual(["a"]);
      expect(bridge.statusTerminals().map((t) => t.terminal_id)).toEqual(["b"]);
      await bridge.handleTerminalRpc(ws, "reattach-a", "terminal.attach", {
        terminal_id: "a",
        cols: 8,
        rows: 3,
      });
      expect(peers).toHaveLength(3);
      expect(
        replies.filter((r) => r.terminal?.terminal_id === "a").length,
      ).toBeGreaterThan(before);
      expect(replies.find((r) => r.id === "reattach-a")?.result.ok).toBe(true);
      expect(replies.filter((r) => r.error)).toEqual([]);
    } finally {
      bridge.dispose();
    }
  },
);

test("changing surface codecs reconnects every endpoint viewer, but not other connections", async () => {
  const hellos: any[] = [];
  const requests: string[] = [];
  const socketPath = await startSessionServer({
    onHello: (hello) => hellos.push(hello),
    onRequest: (method) => {
      requests.push(method);
    },
  });
  const viewers = [{}, {}, {}] as ServerWebSocket<unknown>[];
  const messages: { viewer: unknown; message: any }[] = [];
  let enabled = true;
  const bridge = createTerminalBridge({
    clientSocketPath: socketPath,
    connectionId: "alpha",
    connectionGeneration: 1,
    herdrProtocol: async () => 22,
    surfaceCodecsEnabled: async () => enabled,
    lookupPaneId: async () => "w1:p1",
    clientLabel: () => "test",
    markRpcError: () => {},
    safeSend: (viewer, payload) => {
      messages.push({ viewer, message: JSON.parse(payload) });
      return true;
    },
  });
  const unaffected = creationBridge(socketPath);
  const attach = (index: number) =>
    bridge.handleTerminalRpc(
      viewers[index],
      `attach-${index}`,
      "terminal.attach",
      {
        terminal_id: index === 2 ? "other-pane" : "same-pane",
        cols: 8,
        rows: 3,
      },
    );
  try {
    await unaffected.attach();
    for (let i = 0; i < 3; i++) await attach(i);
    expect(hellos).toHaveLength(3);
    for (const next of [false, true]) {
      messages.length = 0;
      enabled = next;
      bridge.refreshSurfaceCodecs();
      await settleUntil(
        () =>
          messages.filter(({ message }) => message.terminal_closed).length ===
          3,
      );
      expect(
        messages
          .filter(({ message }) => message.terminal_closed)
          .map(({ viewer }) =>
            viewers.indexOf(viewer as ServerWebSocket<unknown>),
          )
          .sort(),
      ).toEqual([0, 1, 2]);
      for (const { message } of messages.filter(
        ({ message }) => message.terminal_closed,
      )) {
        expect(message.terminal_closed.reason).toBe(
          "terminal_configuration_changed",
        );
        expect(message.connection_id).toBe("alpha");
      }
      expect(unaffected.bridge.statusTerminals()).toHaveLength(1);
      expect(unaffected.replies.some((reply) => reply.terminal_closed)).toBe(
        false,
      );
      for (let i = 0; i < 3; i++) await attach(i);
      expect(
        hellos
          .slice(-2)
          .map((hello) => [hello.surface_delta, hello.surface_reuse]),
      ).toEqual([
        [next, next],
        [next, next],
      ]);
      expect(bridge.statusTerminals()).toHaveLength(2);
      expect(messages.some(({ message }) => message.terminal?.full)).toBe(true);
      expect(messages.filter(({ message }) => message.error)).toEqual([]);
    }
    expect(requests.some((method) => /kill|destroy|close/.test(method))).toBe(
      false,
    );
  } finally {
    bridge.dispose();
    unaffected.bridge.dispose();
  }
});

test("configuration refresh during handshake still notifies the viewer to retry", async () => {
  const socketPath = path.join(
    tmpdir(),
    `herdr-gui-handshake-${crypto.randomUUID()}.sock`,
  );
  const hello = deferred<void>();
  const closed = deferred<void>();
  const server = net.createServer((socket) => {
    socket.once("data", () => hello.resolve());
    socket.once("close", () => closed.resolve());
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const { bridge, ws, replies } = creationBridge(socketPath);
  const attaching = bridge.handleTerminalRpc(ws, "attach", "terminal.attach", {
    terminal_id: "term",
    cols: 8,
    rows: 3,
  });
  try {
    await hello.promise;
    bridge.refreshSurfaceCodecs();
    await Promise.all([attaching, closed.promise]);
    expect(
      replies
        .filter((reply) => reply.terminal_closed)
        .map((reply) => reply.terminal_closed),
    ).toEqual([
      { terminal_id: "term", reason: "terminal_configuration_changed" },
    ]);
  } finally {
    bridge.dispose();
    await attaching;
  }
});

test.each([false, true])(
  "configuration reattachment survives obsolete lookup failure (different viewer: %s)",
  async (differentViewer) => {
    const lookup = deferred<string>();
    let lookups = 0;
    const inputs: string[] = [];
    const senders: Array<(panes: TestPane[]) => void> = [];
    const socketPath = await startSessionServer({
      onConnection: (send) => senders.push(send),
      onPaneInput: (id) => inputs.push(id),
    });
    const { bridge, ws, replies } = creationBridge(socketPath, {
      lookup: async () => (++lookups === 1 ? lookup.promise : "w1:p1"),
    });
    const replacementViewer = differentViewer
      ? ({} as ServerWebSocket<unknown>)
      : ws;
    const attach = (viewer: ServerWebSocket<unknown>, id: string) =>
      bridge.handleTerminalRpc(viewer, id, "terminal.attach", {
        terminal_id: "term",
        cols: 8,
        rows: 3,
      });
    const prior = attach(ws, "prior");
    try {
      await settleUntil(() => lookups === 1);
      bridge.refreshSurfaceCodecs();
      await settleUntil(() => replies.some((r) => r.terminal_closed));
      await attach(replacementViewer, "replacement");
      expect(replies.find((r) => r.id === "replacement")?.result.ok).toBe(true);
      lookup.resolve("w1:p1");
      await prior;
      expect(replies.find((r) => r.id === "prior")?.error).toBeDefined();
      expect(bridge.statusTerminals()).toHaveLength(1);
      const frames = replies.filter((r) => r.terminal).length;
      senders[1]([{ paneId: "w1:p1", x: 0, mouseReporting: true }]);
      await settleUntil(
        () => replies.filter((r) => r.terminal).length > frames,
      );
      await bridge.handleTerminalRpc(
        replacementViewer,
        "input",
        "terminal.input",
        { terminal_id: "term", data: "eA==" },
      );
      await settleUntil(() => inputs.length === 1);
      expect(replies.find((r) => r.id === "input")?.error).toBeUndefined();
      expect(replies.filter((r) => r.terminal_closed)).toHaveLength(1);
    } finally {
      lookup.resolve("w1:p1");
      await prior;
      bridge.dispose();
    }
  },
);

test("an attach waiting for settings cannot negotiate an obsolete codec preference", async () => {
  const hellos: any[] = [];
  const socketPath = await startSessionServer({
    onHello: (hello) => hellos.push(hello),
  });
  const oldSettings = deferred<boolean>();
  let reads = 0;
  const bridge = createTerminalBridge({
    clientSocketPath: socketPath,
    herdrProtocol: async () => 22,
    surfaceCodecsEnabled: () =>
      ++reads === 1 ? oldSettings.promise : Promise.resolve(true),
    lookupPaneId: async () => "w1:p1",
    clientLabel: () => "test",
    markRpcError: () => {},
    safeSend: () => true,
  });
  try {
    const attaching = bridge.handleTerminalRpc(
      {} as ServerWebSocket<unknown>,
      "attach",
      "terminal.attach",
      { terminal_id: "pane", cols: 8, rows: 3 },
    );
    await settleUntil(() => reads === 1);
    bridge.refreshSurfaceCodecs();
    oldSettings.resolve(false);
    await attaching;
    expect(reads).toBe(2);
    expect(hellos.map((hello) => hello.surface_delta)).toEqual([true]);
  } finally {
    oldSettings.resolve(false);
    bridge.dispose();
  }
});

function creationBridge(
  socketPath: string,
  options: {
    lookup?: (id: string) => Promise<string | null>;
    validate?: (source: typeof creationSource) => Promise<void>;
  } = {},
) {
  const replies: any[] = [];
  const bridge = createTerminalBridge({
    clientSocketPath: socketPath,
    herdrProtocol: async () => 22,
    lookupPaneId: options.lookup ?? (async () => "w1:p1"),
    validateCreationSource: options.validate ?? (async () => {}),
    safeSend: (_ws, message) => {
      replies.push(JSON.parse(message));
      return true;
    },
    clientLabel: () => "test",
    markRpcError: () => {},
  });
  const ws = {} as ServerWebSocket<unknown>;
  const attach = (id = "attach") =>
    bridge.handleTerminalRpc(ws, id, "terminal.attach", {
      terminal_id: "term1",
      cols: 80,
      rows: 24,
      relay_active: false,
    });
  return { bridge, ws, replies, attach };
}

describe("attached endpoint creation and input readiness", () => {
  test("waits for pane lookup/focus readiness before creating or forwarding input", async () => {
    const lookup = deferred<string>();
    let lookupStarted = false;
    const inputs: string[] = [];
    const requests: string[] = [];
    const socketPath = await startSessionServer({
      methods: creationMethods,
      onRequest: (method) => {
        requests.push(method);
      },
      onPaneInput: (paneId) => inputs.push(paneId),
    });
    const { bridge, ws, replies, attach } = creationBridge(socketPath, {
      lookup: async () => {
        lookupStarted = true;
        return lookup.promise;
      },
    });
    try {
      const attaching = attach();
      await settleUntil(() => lookupStarted);
      const input = bridge.handleTerminalRpc(ws, "input", "terminal.input", {
        terminal_id: "term1",
        data: Buffer.from("X").toString("base64"),
      });
      const creation = bridge.createFromTerminal(
        ws,
        "tab.create",
        { workspace_id: "w1", browser_source: creationSource },
        () => true,
      );
      await Bun.sleep(10);
      expect(replies.some((r) => r.id === "input")).toBe(false);
      expect(inputs).toEqual([]);
      lookup.resolve("w1:p1");
      await Promise.all([attaching, input, creation]);
      await settleUntil(() => inputs.length === 1);
      expect(requests).toEqual(["pane.focus", "tab.create"]);
      expect(inputs).toEqual(["w1:p1"]);
      expect(replies.find((r) => r.id === "input")).toEqual({
        id: "input",
        result: { ok: true },
      });
    } finally {
      bridge.dispose();
    }
  });

  for (const invalidation of [
    "detach",
    "replace",
    "lease",
    "dispose",
  ] as const) {
    test(`does not replay pending input after ${invalidation}`, async () => {
      const lookup = deferred<string>();
      let lookupCount = 0;
      let current = true;
      const inputs: string[] = [];
      const socketPath = await startSessionServer({
        onPaneInput: (paneId) => inputs.push(paneId),
      });
      const { bridge, ws, replies, attach } = creationBridge(socketPath, {
        lookup: async () => (++lookupCount === 1 ? lookup.promise : "w1:p1"),
      });
      try {
        const attaching = attach();
        await settleUntil(() => lookupCount === 1);
        const input = bridge.handleTerminalRpc(
          ws,
          "input",
          "terminal.input",
          { terminal_id: "term1", data: "WA==" },
          () => current,
        );
        await Bun.sleep(5);
        if (invalidation === "lease") current = false;
        else if (invalidation === "dispose") bridge.dispose();
        else {
          await bridge.handleTerminalRpc(ws, "detach", "terminal.detach", {
            terminal_id: "term1",
          });
          if (invalidation === "replace") await attach("replacement");
        }
        lookup.resolve("w1:p1");
        await Promise.all([attaching, input]);
        expect(replies.find((r) => r.id === "input")?.error).toBeDefined();
        expect(inputs).toEqual([]);
      } finally {
        bridge.dispose();
      }
    });
  }

  test("preserves defaults for every cwd policy and explicit cwd; no extra focus or browser fields", async () => {
    const requests: Array<{ method: string; params: any }> = [];
    let policy = "follow";
    const policyCwd: Record<string, string> = {
      follow: "/source-tab/shared-focused-pane",
      home: "/home",
      current: "/server-cwd",
      path: "/configured",
    };
    const socketPath = await startSessionServer({
      methods: creationMethods,
      onRequest: (method, params) => {
        requests.push({ method, params });
        return { cwd: params.cwd ?? policyCwd[policy] };
      },
    });
    const { bridge, ws, attach } = creationBridge(socketPath);
    try {
      await attach();
      for (policy of Object.keys(policyCwd)) {
        for (const method of ["tab.create", "workspace.create"] as const) {
          const params = {
            workspace_id: "w1",
            browser_source: creationSource,
            focus: true,
          };
          expect(
            await bridge.createFromTerminal(ws, method, params, () => true),
          ).toEqual({ cwd: policyCwd[policy] });
          expect(
            await bridge.createFromTerminal(
              ws,
              method,
              { ...params, cwd: "/explicit" },
              () => true,
            ),
          ).toEqual({ cwd: "/explicit" });
        }
      }
      expect(requests.filter((r) => r.method === "pane.focus")).toHaveLength(1);
      for (const request of requests.filter((r) =>
        r.method.endsWith("create"),
      )) {
        expect(request.params.focus).toBe(false);
        expect(request.params).not.toHaveProperty("browser_source");
        if (request.params.cwd !== "/explicit")
          expect(request.params).not.toHaveProperty("cwd");
      }
    } finally {
      bridge.dispose();
    }
  });

  test("rejects missing, mismatched, moved, and other-browser source attachments", async () => {
    let moved = false;
    const requests: string[] = [];
    const socketPath = await startSessionServer({
      methods: creationMethods,
      onRequest: (method) => {
        requests.push(method);
      },
    });
    const { bridge, ws, attach } = creationBridge(socketPath, {
      validate: async () => {
        if (moved) throw new Error("source moved");
      },
    });
    const params = { workspace_id: "w1", browser_source: creationSource };
    try {
      await expect(
        bridge.createFromTerminal(ws, "tab.create", params, () => true),
      ).rejects.toThrow("Open the source terminal");
      await expect(
        bridge.createFromTerminal(
          ws,
          "workspace.create",
          { browser_source: null },
          () => true,
        ),
      ).rejects.toThrow("Empty-session creation is unavailable");
      await attach();
      await expect(
        bridge.createFromTerminal(
          {} as ServerWebSocket<unknown>,
          "tab.create",
          params,
          () => true,
        ),
      ).rejects.toThrow("attachment changed");
      await expect(
        bridge.createFromTerminal(
          ws,
          "tab.create",
          { ...params, workspace_id: "other" },
          () => true,
        ),
      ).rejects.toThrow("requested workspace");
      moved = true;
      await expect(
        bridge.createFromTerminal(ws, "tab.create", params, () => true),
      ).rejects.toThrow("source moved");
      expect(requests).toEqual(["pane.focus"]);
    } finally {
      bridge.dispose();
    }
  });

  test("missing method advertisements and create rejection fail explicitly without control fallback", async () => {
    for (const methods of [["pane.focus"], creationMethods]) {
      const requests: string[] = [];
      const socketPath = await startSessionServer({
        methods,
        onRequest: (method) => {
          requests.push(method);
          if (method === "tab.create") throw new Error("creation rejected");
        },
      });
      const { bridge, ws, attach } = creationBridge(socketPath);
      try {
        await attach();
        await expect(
          bridge.createFromTerminal(
            ws,
            "tab.create",
            { workspace_id: "w1", browser_source: creationSource },
            () => true,
          ),
        ).rejects.toThrow(
          methods === creationMethods
            ? "creation rejected"
            : "does not advertise",
        );
        expect(
          requests.filter((method) => method === "tab.create"),
        ).toHaveLength(methods === creationMethods ? 1 : 0);
      } finally {
        bridge.dispose();
      }
    }
  });

  test("serializes concurrent creates/scroll on one attached shell while input keeps its pane target", async () => {
    const heldCreate = deferred<void>();
    const requests: string[] = [];
    const inputs: string[] = [];
    const socketPath = await startSessionServer({
      methods: creationMethods,
      onRequest: async (method) => {
        requests.push(method);
        if (
          method === "tab.create" &&
          requests.filter((m) => m === method).length === 1
        )
          await heldCreate.promise;
        return { method };
      },
      onPaneInput: (paneId) => inputs.push(paneId),
    });
    const { bridge, ws, attach } = creationBridge(socketPath);
    try {
      await attach();
      const params = { workspace_id: "w1", browser_source: creationSource };
      const first = bridge.createFromTerminal(
        ws,
        "tab.create",
        params,
        () => true,
      );
      await settleUntil(() => requests.includes("tab.create"));
      const second = bridge.createFromTerminal(
        ws,
        "workspace.create",
        { browser_source: creationSource },
        () => true,
      );
      await bridge.handleTerminalRpc(ws, "input", "terminal.input", {
        terminal_id: "term1",
        data: "WA==",
      });
      await bridge.handleTerminalRpc(ws, "scroll", "terminal.scroll", {
        terminal_id: "term1",
        direction: "up",
        lines: 1,
      });
      await settleUntil(() => inputs.length === 1);
      expect(requests).toEqual(["pane.focus", "tab.create"]);
      heldCreate.resolve();
      await Promise.all([first, second]);
      await settleUntil(() => requests.includes("pane.scroll"));
      expect(requests.filter((m) => m === "pane.focus")).toHaveLength(1);
      expect(inputs).toEqual(["w1:p1"]);
    } finally {
      heldCreate.resolve();
      bridge.dispose();
    }
  });
});

test("two browser source endpoints create concurrently without changing each other's shell target", async () => {
  const sources = new Map<number, string>();
  const creates: Array<{
    connection: number;
    pane: string;
    workspace: string;
  }> = [];
  const socketPath = await startSessionServer({
    methods: creationMethods,
    panes: [
      { paneId: "w1:p1", x: 0, mouseReporting: false },
      { paneId: "w2:p1", x: 10, mouseReporting: false },
    ],
    onRequest: async (method, params, connection) => {
      if (method === "pane.focus") sources.set(connection, params.pane_id);
      if (method === "tab.create") {
        creates.push({
          connection,
          pane: sources.get(connection)!,
          workspace: params.workspace_id,
        });
        await Bun.sleep(10);
        return { workspace_id: params.workspace_id };
      }
    },
  });
  const { bridge, ws, attach } = creationBridge(socketPath, {
    lookup: async (id) => (id === "term1" ? "w1:p1" : "w2:p1"),
  });
  const other = {} as ServerWebSocket<unknown>;
  const otherSource = {
    workspace_id: "w2",
    tab_id: "w2:t1",
    pane_id: "w2:p1",
    terminal_id: "term2",
  };
  try {
    await Promise.all([
      attach(),
      bridge.handleTerminalRpc(other, "other-attach", "terminal.attach", {
        terminal_id: "term2",
        cols: 80,
        rows: 24,
        relay_active: false,
      }),
    ]);
    expect(
      await Promise.all([
        bridge.createFromTerminal(
          ws,
          "tab.create",
          { workspace_id: "w1", browser_source: creationSource },
          () => true,
        ),
        bridge.createFromTerminal(
          other,
          "tab.create",
          { workspace_id: "w2", browser_source: otherSource },
          () => true,
        ),
      ]),
    ).toEqual([{ workspace_id: "w1" }, { workspace_id: "w2" }]);
    expect(
      creates
        .map(({ pane, workspace }) => ({ pane, workspace }))
        .sort((a, b) => a.workspace.localeCompare(b.workspace)),
    ).toEqual([
      { pane: "w1:p1", workspace: "w1" },
      { pane: "w2:p1", workspace: "w2" },
    ]);
    expect(sources.size).toBe(2);
  } finally {
    bridge.dispose();
  }
});

test("creation queued behind readiness or validation cannot mutate a detached source", async () => {
  const validation = deferred<void>();
  let validating = false;
  const requests: string[] = [];
  const socketPath = await startSessionServer({
    methods: creationMethods,
    onRequest: (method) => {
      requests.push(method);
    },
  });
  const { bridge, ws, attach } = creationBridge(socketPath, {
    validate: async () => {
      validating = true;
      await validation.promise;
    },
  });
  try {
    await attach();
    const creation = bridge.createFromTerminal(
      ws,
      "tab.create",
      { workspace_id: "w1", browser_source: creationSource },
      () => true,
    );
    const rejected = creation.then(
      () => null,
      (error: Error) => error,
    );
    await settleUntil(() => validating);
    await bridge.handleTerminalRpc(ws, "detach", "terminal.detach", {
      terminal_id: "term1",
    });
    validation.resolve();
    expect(await rejected).toBeInstanceOf(Error);
    expect(requests).toEqual(["pane.focus"]);
  } finally {
    validation.resolve();
    bridge.dispose();
  }
});

test("input waits for the first source-pane surface, not only the endpoint welcome", async () => {
  let sendSurface!: (panes: TestPane[]) => void;
  let focused = false;
  const inputs: string[] = [];
  const socketPath = await startSessionServer({
    panes: [{ paneId: "other-pane", x: 0, mouseReporting: false }],
    onConnection: (send) => {
      sendSurface = send;
    },
    onRequest: (method) => {
      if (method === "pane.focus") focused = true;
    },
    onPaneInput: (paneId) => inputs.push(paneId),
  });
  const { bridge, ws, replies, attach } = creationBridge(socketPath);
  try {
    const attaching = attach();
    await settleUntil(() => focused);
    const input = bridge.handleTerminalRpc(ws, "early", "terminal.input", {
      terminal_id: "term1",
      data: "WA==",
    });
    await Bun.sleep(10);
    expect(replies.some((reply) => reply.id === "early")).toBe(false);
    expect(inputs).toEqual([]);
    sendSurface(DEFAULT_PANES);
    await Promise.all([attaching, input]);
    await settleUntil(() => inputs.length === 1);
    expect(inputs).toEqual(["w1:p1"]);
  } finally {
    bridge.dispose();
  }
});

test("creation admission deadline prevents execution after queue residence", async () => {
  const held = deferred<void>();
  const creates: string[] = [];
  const socketPath = await startSessionServer({
    methods: creationMethods,
    onRequest: async (method) => {
      if (method === "tab.create") {
        creates.push(method);
        if (creates.length === 1) await held.promise;
      }
    },
  });
  const { bridge, ws, attach } = creationBridge(socketPath);
  const clock = spyOn(Date, "now").mockReturnValue(Date.now());
  try {
    await attach();
    const params = { workspace_id: "w1", browser_source: creationSource };
    const first = bridge.createFromTerminal(
      ws,
      "tab.create",
      params,
      () => true,
    );
    await settleUntil(() => creates.length === 1);
    const second = bridge
      .createFromTerminal(ws, "tab.create", params, () => true)
      .then(
        () => null,
        (error: Error) => error,
      );
    await Bun.sleep(5);
    clock.mockReturnValue(Date.now() + 30_001);
    held.resolve();
    await first;
    expect(await second).toBeInstanceOf(Error);
    expect(creates).toHaveLength(1);
  } finally {
    held.resolve();
    clock.mockRestore();
    bridge.dispose();
  }
});

for (const stage of ["readiness", "validation"] as const) {
  test(`creation deadline includes ${stage} before the mutation queue`, async () => {
    const held = deferred<void>();
    let waiting = false;
    const creates: string[] = [];
    const socketPath = await startSessionServer({
      methods: creationMethods,
      onRequest: (method) => {
        if (method === "tab.create") creates.push(method);
      },
    });
    const { bridge, ws, attach } = creationBridge(socketPath, {
      lookup: async () => {
        if (stage === "readiness") {
          waiting = true;
          await held.promise;
        }
        return "w1:p1";
      },
      validate: async () => {
        if (stage === "validation") {
          waiting = true;
          await held.promise;
        }
      },
    });
    const clock = spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      const attaching = attach();
      if (stage === "validation") await attaching;
      else await settleUntil(() => waiting);
      const pending = bridge
        .createFromTerminal(
          ws,
          "tab.create",
          { workspace_id: "w1", browser_source: creationSource },
          () => true,
        )
        .then(
          () => null,
          (error: Error) => error,
        );
      if (stage === "validation") await settleUntil(() => waiting);
      else await Bun.sleep(5);
      clock.mockReturnValue(Date.now() + 30_001);
      held.resolve();
      await attaching;
      expect((await pending)?.message).toContain("expired before dispatch");
      expect(creates).toEqual([]);
    } finally {
      held.resolve();
      clock.mockRestore();
      bridge.dispose();
    }
  });
}

test("undispatched queue deadline rejects promptly without closing or mutating; later create still works", async () => {
  const held = deferred<void>();
  const creates: string[] = [];
  const socketPath = await startSessionServer({
    methods: creationMethods,
    onRequest: async (method) => {
      if (method === "tab.create") {
        creates.push(method);
        if (creates.length === 1) await held.promise;
      }
    },
  });
  const session = new EndpointTerminalSession(
    socketPath,
    "term1",
    async () => "w1:p1",
  );
  try {
    await session.connect(80, 24);
    const create = (deadline?: EndpointCreationDeadline) =>
      session.create("tab.create", {}, "w1:p1", async () => {}, deadline);
    const first = create();
    await settleUntil(() => creates.length === 1);
    await expect(create(new EndpointCreationDeadline(20))).rejects.toThrow(
      "expired before dispatch",
    );
    expect(session.isClosed).toBe(false);
    held.resolve();
    await first;
    await create();
    expect(creates).toHaveLength(2);
  } finally {
    held.resolve();
    session.close();
  }
});

test("dispatched deadline warns about uncertainty and closes only the affected endpoint", async () => {
  const held = deferred<void>();
  let dispatched = false;
  const socketPath = await startSessionServer({
    methods: creationMethods,
    onRequest: async (method) => {
      if (method === "tab.create") {
        dispatched = true;
        await held.promise;
      }
    },
  });
  const session = new EndpointTerminalSession(
    socketPath,
    "term1",
    async () => "w1:p1",
  );
  try {
    await session.connect(80, 24);
    await expect(
      session.create(
        "tab.create",
        {},
        "w1:p1",
        async () => {},
        new EndpointCreationDeadline(30),
      ),
    ).rejects.toThrow("may have succeeded");
    expect(dispatched).toBe(true);
    expect(session.isClosed).toBe(true);
  } finally {
    held.resolve();
    session.close();
  }
});

for (const invalidate of ["lease", "dispose"] as const) {
  test(`creation validation rechecks ${invalidate} before dispatch`, async () => {
    const held = deferred<void>();
    let waiting = false,
      current = true;
    const creates: string[] = [];
    const socketPath = await startSessionServer({
      methods: creationMethods,
      onRequest: (method) => {
        if (method === "tab.create") creates.push(method);
      },
    });
    const { bridge, ws, attach } = creationBridge(socketPath, {
      validate: async () => {
        waiting = true;
        await held.promise;
      },
    });
    try {
      await attach();
      const pending = bridge
        .createFromTerminal(
          ws,
          "tab.create",
          { workspace_id: "w1", browser_source: creationSource },
          () => current,
        )
        .then(
          () => null,
          (error: Error) => error,
        );
      await settleUntil(() => waiting);
      if (invalidate === "lease") current = false;
      else bridge.dispose();
      held.resolve();
      expect(await pending).toBeInstanceOf(Error);
      expect(creates).toEqual([]);
    } finally {
      held.resolve();
      bridge.dispose();
    }
  });
}

for (const invalidate of [
  "detach",
  "reattach",
  "lease",
  "dispose",
  "replace",
] as const) {
  test(`ready shared input revalidates ${invalidate} after its await before input or clipboard ownership`, async () => {
    const socketPath = await startSessionServer({ methods: creationMethods });
    const a = {} as ServerWebSocket<unknown>,
      b = {} as ServerWebSocket<unknown>;
    const replies: Array<{ ws: ServerWebSocket<unknown>; message: any }> = [];
    const bridge = createTerminalBridge({
      clientSocketPath: socketPath,
      herdrProtocol: async () => 22,
      lookupPaneId: async () => "w1:p1",
      safeSend: (ws, payload) => {
        replies.push({ ws, message: JSON.parse(payload) });
        return true;
      },
      clientLabel: () => "ready-input-race",
      markRpcError: () => {},
    });
    const forwarded: string[] = [];
    const sessions: EndpointTerminalSession[] = [];
    const original = EndpointTerminalSession.prototype.input;
    const inputSpy = spyOn(
      EndpointTerminalSession.prototype,
      "input",
    ).mockImplementation(function (
      this: EndpointTerminalSession,
      data: Buffer,
    ) {
      sessions.push(this);
      forwarded.push(data.toString());
      original.call(this, data);
    });
    const attach = (ws: typeof a) =>
      bridge.handleTerminalRpc(ws, "attach", "terminal.attach", {
        terminal_id: "term1",
        cols: 80,
        rows: 24,
        relay_active: false,
      });
    let current = true;
    try {
      await attach(a);
      await attach(b);
      await bridge.handleTerminalRpc(b, "owner", "terminal.input", {
        terminal_id: "term1",
        data: "Qg==",
      });
      const session = sessions[0];
      expect(session.connecting).toBeNull();
      expect(session.isClosed).toBe(false);
      expect(bridge.viewedTerminals(a)).toEqual(["term1"]);
      expect(bridge.viewedTerminals(b)).toEqual(["term1"]);
      forwarded.length = 0;
      // No sleep or await between starting ready input and invalidating its lease/token.
      const input = bridge.handleTerminalRpc(
        a,
        "stale-input",
        "terminal.input",
        { terminal_id: "term1", data: "WA==" },
        () => current,
      );
      let invalidating: unknown;
      if (invalidate === "detach")
        invalidating = bridge.handleTerminalRpc(
          a,
          "detach",
          "terminal.detach",
          { terminal_id: "term1" },
        );
      else if (invalidate === "reattach") invalidating = attach(a);
      else if (invalidate === "lease") current = false;
      else if (invalidate === "dispose") bridge.dispose();
      else {
        session.close();
        invalidating = attach(a);
      }
      await Promise.all([input, invalidating]);
      if (invalidate === "detach")
        expect(bridge.viewedTerminals(a)).toEqual([]);
      expect(forwarded).toEqual([]);
      expect(
        replies.find(({ message }) => message.id === "stale-input")?.message
          .error,
      ).toBeDefined();
      if (invalidate !== "dispose" && invalidate !== "replace") {
        expect(bridge.viewedTerminals(b)).toEqual(["term1"]);
        session.emit("clipboard", { data: "Y29weQ==" });
        expect(
          replies
            .filter(({ message }) => message.terminal_clipboard)
            .map(({ ws }) => ws),
        ).toEqual([b]);
      }
    } finally {
      inputSpy.mockRestore();
      bridge.dispose();
    }
  });
}

test("required pane.focus absent fails attach explicitly without legacy takeover", async () => {
  const requests: string[] = [];
  let lookups = 0;
  const socketPath = await startSessionServer({
    methods: [],
    onRequest: (method) => {
      requests.push(method);
    },
  });
  const { bridge, replies, attach } = creationBridge(socketPath, {
    lookup: async () => {
      lookups++;
      return "w1:p1";
    },
  });
  try {
    await attach();
    expect(replies.find((r) => r.id === "attach").error.message).toContain(
      "does not advertise pane.focus",
    );
    expect(requests).toEqual([]);
    expect(lookups).toBe(0);
    expect(bridge.statusTerminals()).toEqual([]);
    expect(await bridge.navigationMode()).toBe("browser-local");
  } finally {
    bridge.dispose();
  }
});

test("backend dispatch keeps subset input/create usable and rejects unsupported history before sending", async () => {
  const requests: string[] = [];
  const inputs: string[] = [];
  const socketPath = await startSessionServer({
    methods: ["pane.focus", "tab.create"],
    onRequest: (method) => {
      requests.push(method);
    },
    onPaneInput: (id) => {
      inputs.push(id);
    },
  });
  const { bridge, ws, replies, attach } = creationBridge(socketPath);
  try {
    await attach();
    expect(
      replies.find((r) => r.id === "attach").result.endpoint.methods,
    ).toEqual(["pane.focus", "tab.create"]);
    await bridge.handleTerminalRpc(ws, "scroll", "terminal.scroll", {
      terminal_id: "term1",
      direction: "up",
      lines: 1,
    });
    expect(replies.find((r) => r.id === "scroll").error.message).toContain(
      "pane.scroll",
    );
    await expect(
      bridge.createFromTerminal(
        ws,
        "workspace.create",
        { browser_source: creationSource },
        () => true,
      ),
    ).rejects.toThrow("workspace.create");
    await bridge.handleTerminalRpc(ws, "input", "terminal.input", {
      terminal_id: "term1",
      data: "WA==",
    });
    await bridge.createFromTerminal(
      ws,
      "tab.create",
      { workspace_id: "w1", browser_source: creationSource },
      () => true,
    );
    expect(inputs).toEqual(["w1:p1"]);
    expect(requests).toEqual(["pane.focus", "tab.create"]);
  } finally {
    bridge.dispose();
  }
});

test("reconnect replaces advertisements while other connection runtimes retain their own subset", async () => {
  const socketPath = await startSessionServer({
    methods: (connection) =>
      connection === 1 ? creationMethods : ["pane.focus"],
    capabilities: (connection) => (connection === 1 ? ["health_check"] : []),
  });
  const a = creationBridge(socketPath);
  const b = creationBridge(socketPath);
  try {
    await a.attach();
    await b.attach();
    expect(a.bridge.endpointAvailability().term1?.capabilities).toEqual([
      "health_check",
    ]);
    expect(b.bridge.endpointAvailability().term1?.capabilities).toEqual([]);
    expect(a.bridge.endpointAvailability().term1?.methods).toEqual(
      creationMethods,
    );
    expect(b.bridge.endpointAvailability().term1?.methods).toEqual([
      "pane.focus",
    ]);
    await a.bridge.handleTerminalRpc(a.ws, "detach", "terminal.detach", {
      terminal_id: "term1",
    });
    expect(a.bridge.endpointAvailability()).toEqual({});
    await a.attach("reattach");
    expect(a.bridge.endpointAvailability().term1?.capabilities).toEqual([]);
    expect(b.bridge.endpointAvailability().term1?.capabilities).toEqual([]);
    expect(a.bridge.endpointAvailability().term1?.methods).toEqual([
      "pane.focus",
    ]);
    expect(b.bridge.endpointAvailability().term1?.methods).toEqual([
      "pane.focus",
    ]);
    await expect(
      a.bridge.createFromTerminal(
        a.ws,
        "tab.create",
        { workspace_id: "w1", browser_source: creationSource },
        () => true,
      ),
    ).rejects.toThrow("tab.create");
  } finally {
    a.bridge.dispose();
    b.bridge.dispose();
  }
});

describe("wheel bursts with delayed endpoint frames", () => {
  test("a stale repaint cannot rewind pending wheel movement", async () => {
    const first = deferred<void>();
    const requests: number[] = [];
    let send!: (panes: TestPane[]) => void;
    const socketPath = await startSessionServer({
      onConnection: (push) => {
        send = push;
      },
      onRequest: async (method, params) => {
        if (method !== "pane.scroll") return;
        requests.push(params.offset_from_bottom);
        if (requests.length === 1) await first.promise;
        send([{ ...DEFAULT_PANES[0], offset: params.offset_from_bottom }]);
      },
    });
    const session = new EndpointTerminalSession(
      socketPath,
      "term1",
      async () => "w1:p1",
    );
    let frames = 0;
    session.on("terminal", () => frames++);
    try {
      await session.connect(8, 3, { cols: 10, rows: 5 });
      session.scroll("up", 3);
      await settleUntil(() => requests.length === 1);
      session.scroll("up", 3);
      const before = frames;
      send(DEFAULT_PANES); // old viewport arrives while the first request is pending
      await settleUntil(() => frames > before);
      session.scroll("up", 3);
      first.resolve();
      await Bun.sleep(60);
      expect(requests[requests.length - 1]).toBe(9);
      expect(
        requests.every((offset, i) => i === 0 || offset >= requests[i - 1]),
      ).toBe(true);
      expect(requests.length).toBeLessThanOrEqual(2);
    } finally {
      first.resolve();
      session.close();
    }
  });
});

test("wheel targets survive RPC replies before their surface acknowledgements", async () => {
  const requests: number[] = [];
  let send!: (panes: TestPane[]) => void;
  const socketPath = await startSessionServer({
    onConnection: (push) => {
      send = push;
    },
    onRequest: (method, params) => {
      if (method === "pane.scroll") requests.push(params.offset_from_bottom);
    },
  });
  const session = new EndpointTerminalSession(
    socketPath,
    "term1",
    async () => "w1:p1",
  );
  let frames = 0;
  session.on("terminal", () => frames++);
  const publish = async (offset: number) => {
    const before = frames;
    send([{ ...DEFAULT_PANES[0], offset }]);
    await settleUntil(() => frames > before);
  };
  try {
    await session.connect(8, 3, { cols: 10, rows: 5 });
    session.scroll("up", 3);
    await settleUntil(() => requests.length === 1);
    await session.focus(() => true); // RPC completed, but no surface yet
    session.scroll("up", 3);
    await session.focus(() => true);
    session.scroll("up", 3);
    await session.focus(() => true);
    expect(requests).toEqual([3]); // all unsent movement coalesces behind the frame
    await publish(3);
    await settleUntil(() => requests.length === 2);
    await publish(9); // final acknowledgement retires the pending intent
    await publish(20); // subsequent scrolling by another client is authoritative
    session.scroll("down", 2);
    await settleUntil(() => requests.length === 3);
    expect(requests).toEqual([3, 9, 18]);
  } finally {
    session.close();
  }
});

for (const scenario of ["reverse", "grow", "close", "input"] as const) {
  test(`pending wheel burst handles ${scenario}`, async () => {
    const first = deferred<void>();
    const requests: number[] = [];
    let send!: (panes: TestPane[]) => void;
    let maxOffset = 100;
    const socketPath = await startSessionServer({
      onConnection: (push) => {
        send = push;
      },
      onRequest: async (method, params) => {
        if (method !== "pane.scroll") return;
        requests.push(params.offset_from_bottom);
        if (requests.length === 1) await first.promise;
        if (scenario !== "close")
          send([
            {
              ...DEFAULT_PANES[0],
              offset: params.offset_from_bottom,
              maxOffset,
            },
          ]);
      },
    });
    const session = new EndpointTerminalSession(
      socketPath,
      "term1",
      async () => "w1:p1",
    );
    let frames = 0;
    session.on("terminal", () => frames++);
    try {
      await session.connect(8, 3, { cols: 10, rows: 5 });
      session.scroll("up", 3);
      await settleUntil(() => requests.length === 1);
      if (scenario === "grow") {
        maxOffset = 105;
        const before = frames;
        send([{ ...DEFAULT_PANES[0], maxOffset }]);
        await settleUntil(() => frames > before);
        session.scroll("up", 2);
      } else {
        session.scroll("up", 12);
        if (scenario === "reverse") session.scroll("down", 20);
        else if (scenario === "input") session.input(Buffer.from("x"));
        else session.close();
      }
      first.resolve();
      if (scenario !== "close" && scenario !== "input")
        await settleUntil(() => requests.length === 2);
      else await Bun.sleep(30);
      expect(requests).toEqual(
        scenario === "grow" ? [3, 10] : scenario === "reverse" ? [3, 0] : [3],
      );
    } finally {
      first.resolve();
      session.close();
    }
  });
}

test("failed scrolling releases pending intent for the next wheel gesture", async () => {
  const requests: number[] = [];
  const failed = deferred<void>();
  const socketPath = await startSessionServer({
    onRequest: (method, params) => {
      if (method !== "pane.scroll") return;
      requests.push(params.offset_from_bottom);
      if (requests.length === 1) throw new Error("scroll rejected");
    },
  });
  const session = new EndpointTerminalSession(
    socketPath,
    "term1",
    async () => "w1:p1",
    {
      ...silentLogger,
      debug: (message) => {
        if (message === "endpoint pane.scroll failed") failed.resolve();
      },
    },
  );
  try {
    await session.connect(8, 3, { cols: 10, rows: 5 });
    session.scroll("up", 3);
    await failed.promise;
    session.scroll("up", 2);
    await settleUntil(() => requests.length === 2);
    expect(requests).toEqual([3, 2]);
  } finally {
    session.close();
  }
});

describe("attached endpoint cursor focus", () => {
  test("focuses an owned attachment without input and rejects other viewers", async () => {
    const requests: Array<{ method: string; params: any }> = [];
    const inputs: string[] = [];
    const socketPath = await startSessionServer({
      onRequest: (method, params) => {
        requests.push({ method, params });
      },
      onPaneInput: (paneId) => inputs.push(paneId),
    });
    const { bridge, ws, replies, attach } = creationBridge(socketPath);
    try {
      await attach();
      requests.length = 0;
      await bridge.handleTerminalRpc(ws, "focus", "terminal.focus", {
        terminal_id: "term1",
      });
      expect(requests).toEqual([
        { method: "pane.focus", params: { pane_id: "w1:p1" } },
      ]);
      expect(replies.find((r) => r.id === "focus")?.result).toEqual({
        ok: true,
      });
      await bridge.handleTerminalRpc(
        {} as ServerWebSocket<unknown>,
        "other",
        "terminal.focus",
        { terminal_id: "term1" },
      );
      await bridge.handleTerminalRpc(ws, "unknown", "terminal.focus", {
        terminal_id: "missing",
      });
      expect(replies.find((r) => r.id === "other")?.error).toBeDefined();
      expect(replies.find((r) => r.id === "unknown")?.error).toBeDefined();
      expect(requests).toHaveLength(1);
      expect(inputs).toEqual([]);
    } finally {
      bridge.dispose();
    }
  });

  for (const invalidation of [
    "none",
    "detach",
    "replace",
    "lease",
    "disconnect",
    "dispose",
  ] as const) {
    test(`waits for attachment readiness and handles ${invalidation}`, async () => {
      const lookup = deferred<string>();
      let lookupCount = 0;
      let current = true;
      const requests: string[] = [];
      const socketPath = await startSessionServer({
        onRequest: (method) => {
          requests.push(method);
        },
      });
      const { bridge, ws, replies, attach } = creationBridge(socketPath, {
        lookup: async () => (++lookupCount === 1 ? lookup.promise : "w1:p1"),
      });
      try {
        const attaching = attach();
        await settleUntil(() => lookupCount === 1);
        const focusing = bridge.handleTerminalRpc(
          ws,
          "focus",
          "terminal.focus",
          { terminal_id: "term1" },
          () => current,
        );
        await Bun.sleep(10);
        expect(requests).toEqual([]);
        expect(replies.find((r) => r.id === "focus")).toBeUndefined();
        if (invalidation === "lease") current = false;
        else if (invalidation === "dispose") bridge.dispose();
        else if (invalidation === "disconnect") bridge.cleanupWs(ws);
        else if (invalidation !== "none") {
          await bridge.handleTerminalRpc(ws, "detach", "terminal.detach", {
            terminal_id: "term1",
          });
          if (invalidation === "replace") await attach("replacement");
        }
        lookup.resolve("w1:p1");
        await Promise.all([attaching, focusing]);
        const response = replies.find((r) => r.id === "focus");
        if (invalidation === "none") {
          expect(response?.result).toEqual({ ok: true });
          expect(requests).toEqual(["pane.focus", "pane.focus"]);
        } else {
          expect(response?.error).toBeDefined();
          expect(requests).toHaveLength(
            invalidation === "lease" || invalidation === "replace" ? 1 : 0,
          );
        }
      } finally {
        bridge.dispose();
      }
    });
  }

  for (const supersede of [false, true]) {
    test(`orders focus across endpoint lanes${supersede ? " and drops superseded selections" : ""}`, async () => {
      const hold = deferred<void>();
      const requests: string[] = [];
      let block = false;
      const socketPath = await startSessionServer({
        panes: [
          { paneId: "w1:p1", x: 0, mouseReporting: false },
          { paneId: "w1:p2", x: 10, mouseReporting: false },
        ],
        onRequest: async (method, params) => {
          if (method !== "pane.focus") return;
          requests.push(params.pane_id);
          if (block && requests.length === 1) await hold.promise;
        },
      });
      const { bridge, ws, replies, attach } = creationBridge(socketPath, {
        lookup: async (id) => (id === "term1" ? "w1:p1" : "w1:p2"),
      });
      try {
        await attach();
        await bridge.handleTerminalRpc(ws, "attach2", "terminal.attach", {
          terminal_id: "term2",
          cols: 8,
          rows: 3,
          relay_active: false,
        });
        requests.length = 0;
        block = true;
        const focus = (id: string, terminalId: string) =>
          bridge.handleTerminalRpc(ws, id, "terminal.focus", {
            terminal_id: terminalId,
          });
        const first = focus("first", "term1");
        await settleUntil(() => requests.length === 1);
        const second = focus("second", "term2");
        const third = supersede ? focus("third", "term1") : Promise.resolve();
        await Bun.sleep(20);
        expect(requests).toEqual(["w1:p1"]);
        hold.resolve();
        await Promise.all([first, second, third]);
        expect(requests).toEqual(["w1:p1", supersede ? "w1:p1" : "w1:p2"]);
        expect(
          replies
            .filter((r) => ["first", "second", "third"].includes(r.id))
            .every((r) => r.result?.ok),
        ).toBe(true);
      } finally {
        hold.resolve();
        bridge.dispose();
      }
    });
  }
});

async function scrollFixture(
  onScroll: (offset: number, index: number) => unknown = () => ({}),
) {
  const requests: number[] = [];
  let send!: (panes: TestPane[]) => void;
  const socketPath = await startSessionServer({
    onConnection: (push) => {
      send = push;
    },
    onRequest: (method, params) => {
      if (method !== "pane.scroll") return;
      requests.push(params.offset_from_bottom);
      return onScroll(params.offset_from_bottom, requests.length);
    },
  });
  const session = new EndpointTerminalSession(
    socketPath,
    "term1",
    async () => "w1:p1",
  );
  await session.connect(8, 3, { cols: 10, rows: 5 });
  return {
    session,
    requests,
    send,
    // Focus is a public command-lane fence, not a private scheduler assertion.
    fence: () => session.focus(() => true),
    publish: async (offset: number, maxOffset = 100) => {
      const frame = new Promise<void>((resolve) =>
        session.once("terminal", () => resolve()),
      );
      send([{ ...DEFAULT_PANES[0], offset, maxOffset }]);
      await frame;
    },
  };
}

function paneScrollResult(offset: number, maxOffset = 100) {
  return {
    type: "pane_info",
    pane: {
      pane_id: "w1:p1",
      scroll: {
        offset_from_bottom: offset,
        max_offset_from_bottom: maxOffset,
        viewport_rows: 3,
      },
      revision: 999, // terminal metadata revision, deliberately unrelated to surfaces
    },
  };
}

describe("scroll dispatch reconciliation", () => {
  test("growth after RPC completion cannot create an unsent hidden target", async () => {
    const f = await scrollFixture();
    try {
      f.session.scroll("up", 3);
      await f.fence();
      await f.publish(0, 105);
      await f.publish(3, 105);
      await f.fence();
      expect(f.requests).toEqual([3]);
      f.session.scroll("up", 2);
      await f.fence();
      expect(f.requests).toEqual([3, 5]);
    } finally {
      f.session.close();
    }
  });

  test("external viewport replacement retires a completed dispatch without its exact target", async () => {
    const f = await scrollFixture();
    try {
      f.session.scroll("up", 3);
      await f.fence();
      await f.publish(20);
      f.session.scroll("down", 2);
      await f.fence();
      expect(f.requests).toEqual([3, 18]);
    } finally {
      f.session.close();
    }
  });

  test("rapid gestures coalesce across multiple delayed surfaces without stale replay", async () => {
    const f = await scrollFixture();
    try {
      for (let i = 0; i < 3; i++) {
        f.session.scroll("up", 3);
        await f.fence();
      }
      expect(f.requests).toEqual([3]);
      await f.publish(3);
      await f.fence();
      expect(f.requests).toEqual([3, 9]);
      await f.publish(3); // queued repaint of the preceding viewport
      f.session.scroll("up", 2);
      await f.fence();
      expect(f.requests).toEqual([3, 9]);
      await f.publish(9);
      await f.fence();
      await f.publish(11);
      await f.fence();
      expect(f.requests).toEqual([3, 9, 11]);
      await f.publish(20);
      f.session.scroll("down", 2);
      await f.fence();
      expect(f.requests).toEqual([3, 9, 11, 18]);
    } finally {
      f.session.close();
    }
  });

  test("surface before RPC completion cannot retire newer wheel intent", async () => {
    const hold = deferred<void>();
    const f = await scrollFixture(async (_offset, index) => {
      if (index === 1) await hold.promise;
    });
    try {
      f.session.scroll("up", 3);
      await settleUntil(() => f.requests.length === 1);
      await f.publish(3);
      f.session.scroll("up", 3);
      f.session.scroll("up", 3);
      hold.resolve();
      await f.fence();
      await settleUntil(() => f.requests.length === 2);
      await f.publish(9);
      await f.fence();
      expect(f.requests).toEqual([3, 9]);
    } finally {
      hold.resolve();
      f.session.close();
    }
  });

  test("undispatched reversal retires a no-op before the next gesture", async () => {
    const f = await scrollFixture();
    try {
      f.session.scroll("up", 3);
      f.session.scroll("down", 3);
      await f.fence();
      expect(f.requests).toEqual([]);
      f.session.scroll("up", 2);
      await f.fence();
      expect(f.requests).toEqual([2]);
    } finally {
      f.session.close();
    }
  });

  test("undispatched reversal retains wheel intent arriving during no-op completion", async () => {
    const f = await scrollFixture();
    try {
      f.session.scroll("up", 3);
      f.session.scroll("down", 3);
      // Let the queued callback run, but not its promise completion handlers.
      await Promise.resolve();
      f.session.scroll("up", 2);
      await f.fence();
      await settleUntil(() => f.requests.length > 0);
      expect(f.requests).toEqual([2]);
    } finally {
      f.session.close();
    }
  });

  test("reversal awaits its own surface instead of reviving the earlier offset", async () => {
    const f = await scrollFixture();
    try {
      f.session.scroll("up", 3);
      await f.fence();
      f.session.scroll("down", 3);
      await f.fence();
      expect(f.requests).toEqual([3]);
      await f.publish(3);
      await f.fence();
      await f.publish(3);
      f.session.scroll("down", 1);
      await f.fence();
      expect(f.requests).toEqual([3, 0]);
      await f.publish(0);
      f.session.scroll("up", 2);
      await f.fence();
      expect(f.requests).toEqual([3, 0, 2]);
    } finally {
      f.session.close();
    }
  });

  test("waiting for a surface does not block focus, resize, or application input", async () => {
    const requests: number[] = [];
    const resizes: number[][] = [];
    const inputs: string[] = [];
    const socketPath = await startSessionServer({
      onRequest: (method, params) => {
        if (method === "pane.scroll") requests.push(params.offset_from_bottom);
      },
      onResize: (cols, rows) => {
        resizes.push([cols, rows]);
      },
      onPaneInput: (paneId) => {
        inputs.push(paneId);
      },
    });
    const session = new EndpointTerminalSession(
      socketPath,
      "term1",
      async () => "w1:p1",
    );
    try {
      await session.connect(8, 3, { cols: 10, rows: 5 });
      session.scroll("up", 3);
      await session.focus(() => true);
      session.scroll("up", 2);
      session.resize(8, 3);
      await session.focus(() => true);
      expect(requests).toEqual([3]);
      expect(resizes).toEqual([[10, 5]]);
      session.input(Buffer.from("x"));
      await session.focus(() => true);
      expect(inputs).toEqual(["w1:p1"]);
    } finally {
      session.close();
    }
  });

  test("a clamped no-op result needs no surface and leaves the command lane usable", async () => {
    const f = await scrollFixture((_offset, index) =>
      index === 1 ? paneScrollResult(0, 0) : {},
    );
    try {
      f.session.scroll("up", 3);
      await f.fence();
      // History can regrow without changing the viewport's offset.
      await f.publish(0, 100);
      f.session.scroll("up", 2);
      await f.fence();
      expect(f.requests).toEqual([3, 2]);
    } finally {
      f.session.close();
    }
  });

  test("history shrink settles an opaque-result dispatch at its clamped surface", async () => {
    const f = await scrollFixture();
    try {
      f.session.scroll("up", 3);
      await f.fence();
      await f.publish(0, 0);
      await f.fence();
      await f.publish(0, 100);
      f.session.scroll("up", 2);
      await f.fence();
      expect(f.requests).toEqual([3, 2]);
    } finally {
      f.session.close();
    }
  });

  test("growth during a pending RPC preserves queued movement despite older result metrics", async () => {
    const hold = deferred<void>();
    const f = await scrollFixture(async (offset, index) => {
      if (index === 1) {
        await hold.promise;
        return paneScrollResult(offset, 100);
      }
    });
    try {
      f.session.scroll("up", 3);
      await settleUntil(() => f.requests.length === 1);
      f.session.scroll("up", 97);
      await f.publish(0, 105);
      hold.resolve();
      await f.fence();
      expect(f.requests).toEqual([3]);
      await f.publish(3, 105);
      await f.fence();
      expect(f.requests).toEqual([3, 105]);
      await f.publish(105, 105);
      await f.fence();
      expect(f.requests).toEqual([3, 105]);
    } finally {
      hold.resolve();
      f.session.close();
    }
  });

  test("a server-clamped nonzero result settles at its applied viewport", async () => {
    const f = await scrollFixture((_offset, index) =>
      index === 1 ? paneScrollResult(2, 2) : {},
    );
    try {
      f.session.scroll("up", 3);
      await f.fence();
      await f.publish(2, 2);
      f.session.scroll("down", 1);
      await f.fence();
      expect(f.requests).toEqual([3, 1]);
    } finally {
      f.session.close();
    }
  });

  test.each([
    {},
    { ...paneScrollResult(0, 0), type: "other" },
    {
      type: "pane_info",
      pane: { ...paneScrollResult(0, 0).pane, pane_id: "other" },
    },
    paneScrollResult(-1),
    paneScrollResult(3, 2),
    paneScrollResult(Number.MAX_SAFE_INTEGER + 1),
  ])(
    "unrecognized scroll result %# waits for viewport feedback",
    async (result) => {
      const f = await scrollFixture(() => result);
      try {
        f.session.scroll("up", 3);
        await f.fence();
        f.session.scroll("up", 2);
        await f.fence();
        expect(f.requests).toEqual([3]);
        await f.publish(3);
        await f.fence();
        expect(f.requests).toEqual([3, 5]);
      } finally {
        f.session.close();
      }
    },
  );

  test.each(["input", "pane disappears", "metrics disappear", "close"])(
    "%s cancels waiting and queued scroll intent",
    async (reason) => {
      const f = await scrollFixture();
      try {
        f.session.scroll("up", 3);
        await f.fence();
        f.session.scroll("up", 6);
        if (reason === "input") f.session.input(Buffer.from("x"));
        else if (reason === "pane disappears") f.send([]);
        else if (reason === "metrics disappear")
          f.send([{ ...DEFAULT_PANES[0], hasScroll: false }]);
        else f.session.close();
        if (reason !== "close") {
          await f.fence();
          await f.publish(0);
          f.session.scroll("up", 2);
          await f.fence();
          expect(f.requests).toEqual([3, 2]);
        } else {
          const replacement = await scrollFixture();
          try {
            replacement.session.scroll("up", 2);
            await replacement.fence();
            expect(replacement.requests).toEqual([2]);
          } finally {
            replacement.session.close();
          }
          expect(f.requests).toEqual([3]);
        }
      } finally {
        f.session.close();
      }
    },
  );
});

test("full page keys use semantic pane input even when history scrolling is unavailable", async () => {
  const inputs: Array<{ paneId: string; code: number; modifiers: number }> = [];
  const requests: string[] = [];
  const socketPath = await startSessionServer({
    methods: ["pane.focus"],
    onRequest: (method) => {
      requests.push(method);
    },
    onPaneInput: (paneId, reader) => {
      expect(reader.varint()).toBe(1); // one event
      expect(reader.variant()).toBe(0); // Key
      const code = reader.variant();
      const modifiers = reader.u8();
      inputs.push({ paneId, code, modifiers });
    },
  });
  const { bridge, ws, replies, attach } = creationBridge(socketPath);
  try {
    await attach();
    for (const direction of ["up", "down"]) {
      await bridge.handleTerminalRpc(ws, direction, "terminal.scroll", {
        terminal_id: "term1",
        direction,
        lines: 20,
        source: "page-key",
      });
      expect(replies.find((r) => r.id === direction)?.result).toEqual({
        ok: true,
      });
    }
    await settleUntil(() => inputs.length === 2);
    expect(inputs).toEqual([
      { paneId: "w1:p1", code: 8, modifiers: 0 },
      { paneId: "w1:p1", code: 9, modifiers: 0 },
    ]);
    expect(requests).toEqual(["pane.focus"]);
  } finally {
    bridge.dispose();
  }
});

for (const invalidate of [false, true]) {
  test(`page-key input waits for attachment readiness${invalidate ? " and rejects a stale request" : ""}`, async () => {
    const lookup = deferred<string>();
    let started = false;
    let current = true;
    const inputs: string[] = [];
    const socketPath = await startSessionServer({
      onPaneInput: (id) => inputs.push(id),
    });
    const { bridge, ws, replies, attach } = creationBridge(socketPath, {
      lookup: async () => {
        started = true;
        return lookup.promise;
      },
    });
    try {
      const attaching = attach();
      await settleUntil(() => started);
      const page = bridge.handleTerminalRpc(
        ws,
        "page",
        "terminal.scroll",
        {
          terminal_id: "term1",
          direction: "down",
          source: "page-key",
          lines: 24,
        },
        () => current,
      );
      await Bun.sleep(10);
      expect(inputs).toEqual([]);
      expect(replies.find((r) => r.id === "page")).toBeUndefined();
      if (invalidate) current = false;
      lookup.resolve("w1:p1");
      await Promise.all([attaching, page]);
      if (invalidate) {
        expect(replies.find((r) => r.id === "page")?.error).toBeDefined();
        expect(inputs).toEqual([]);
      } else {
        expect(replies.find((r) => r.id === "page")?.result).toEqual({
          ok: true,
        });
        await settleUntil(() => inputs.length === 1);
        expect(inputs).toEqual(["w1:p1"]);
      }
    } finally {
      bridge.dispose();
    }
  });
}

function linkFrame(rows: string[], width = 24): FrameData {
  return {
    width,
    height: rows.length,
    cursor: null,
    hyperlinks: [],
    cells: rows.flatMap((text) => {
      const cells: CellData[] = [];
      for (const symbol of new Intl.Segmenter(undefined, {
        granularity: "grapheme",
      }).segment(text)) {
        cells.push(cell(symbol.segment));
        for (let i = 1; i < Bun.stringWidth(symbol.segment); i++)
          cells.push(cell(" "));
      }
      while (cells.length < width) cells.push(cell(" "));
      return cells;
    }),
  };
}

const resolvedRegions = (
  regions: { row: number; start_col: number; end_col: number }[],
) => ({ type: "pane_link_resolved", regions });

describe("read-only terminal links", () => {
  test("OSC8 hit testing follows wide cells, combining glyphs and the actual split crop", async () => {
    const frame = linkFrame(["", "    界e\u0301 label", ""], 24);
    frame.hyperlinks = [
      "https://example.org/hidden",
      "file://localhost/tmp/docs",
    ];
    frame.cells[28]!.hyperlink = 0;
    frame.cells[30]!.hyperlink = 1;
    const cropped = cropFrame(frame, { x: 4, y: 1, width: 12, height: 1 });
    expect(frameHyperlinkAt(cropped, 0, 0)).toBe(frame.hyperlinks[0]);
    expect(frameHyperlinkAt(cropped, 0, 1)).toBe(frame.hyperlinks[0]);
    expect(frameHyperlinkAt(cropped, 0, 2)).toBe(frame.hyperlinks[1]);
    expect(frameHyperlinkAt(cropped, 0, 3)).toBeUndefined();
    cropped.cells[2]!.hyperlink = 99;
    expect(frameHyperlinkAt(cropped, 0, 2)).toBeNull();
  });

  test("owned OSC8 target needs no upstream link capability and rejects stale tokens", async () => {
    const frame = linkFrame(["", "    label", ""], 24);
    frame.cells[28]!.hyperlink = 0;
    frame.hyperlinks = ["file://localhost/tmp/docs"];
    const panes: TestPane[] = [
      {
        paneId: "w1:p1",
        x: 0,
        mouseReporting: false,
        rect: { x: 0, y: 0, width: 24, height: 3 },
        innerRect: { x: 4, y: 1, width: 12, height: 1 },
      },
    ];
    const requests: string[] = [];
    let send!: (panes: TestPane[], frame?: FrameData) => void;
    const socketPath = await startSessionServer({
      initialSurface: { frame, panes },
      methods: ["pane.focus"],
      onConnection: (value) => {
        send = value;
      },
      onRequest: (method) => {
        requests.push(method);
      },
    });
    const session = new EndpointTerminalSession(
      socketPath,
      "terminal",
      async () => "w1:p1",
    );
    let token = "";
    session.on("terminal", (value) => {
      token = value.linkFrame;
    });
    try {
      await session.connect(12, 1, { cols: 24, rows: 3 });
      expect(await session.resolveLink(token, 0, 0)).toEqual({
        regions: [],
        url: null,
        uri: frame.hyperlinks[0],
      });
      const old = token;
      const next = once(session, "terminal");
      send(panes, { ...frame, hyperlinks: ["javascript:alert(1)"] });
      await next;
      await expect(session.resolveLink(old, 0, 0)).rejects.toThrow(
        "frame changed",
      );
      expect(await session.resolveLink(token, 0, 0)).toEqual({
        regions: [],
        url: null,
        uri: "javascript:alert(1)",
      });
      expect(requests).not.toContain("pane.link.resolve");
      expect(requests).not.toContain("pane.link.activate");
    } finally {
      session.close();
    }
  });

  test("recovers wrapped URLs from pane display cells, including wide and combining text", () => {
    const frame = linkFrame([
      "",
      "See https://example.com/",
      "界e\u0301/guide",
      "",
    ]);
    const regions = [
      { row: 1, start_col: 4, end_col: 23 },
      { row: 2, start_col: 0, end_col: 8 },
    ];
    expect(resolvedFrameLink(resolvedRegions(regions), frame, 2, 1)).toEqual({
      regions,
      url: "https://example.com/界e\u0301/guide",
    });
  });

  test("accepts only a single blank spacer before a wrapped wide glyph", () => {
    const frame = linkFrame(["", " https://example.com/ab", "界/c", ""]);
    const regions = [
      { row: 1, start_col: 1, end_col: 22 },
      { row: 2, start_col: 0, end_col: 3 },
    ];
    const resolve = () =>
      resolvedFrameLink(resolvedRegions(regions), frame, 2, 0).url;
    expect(resolve()).toBe("https://example.com/ab界/c");
    frame.cells[47]!.symbol = "x";
    expect(resolve()).toBeNull();
    frame.cells[47]!.symbol = " ";
    frame.cells[48]!.symbol = "a";
    expect(resolve()).toBeNull();
    frame.cells[48]!.symbol = "界";
    regions[0]!.end_col--;
    expect(resolve()).toBeNull();
  });

  test("rejects clipped head and tail instead of opening a visible URL fragment", () => {
    const head = linkFrame(["https://example.com/part", ""]);
    const headRegions = [{ row: 0, start_col: 0, end_col: 22 }];
    expect(resolvedFrameLink(resolvedRegions(headRegions), head, 0, 2)).toEqual(
      { regions: headRegions, url: null },
    );
    const tail = linkFrame(["", " https://example.com/tail"]);
    const tailRegions = [{ row: 1, start_col: 1, end_col: 23 }];
    expect(
      resolvedFrameLink(resolvedRegions(tailRegions), tail, 1, 2).url,
    ).toBeNull();
    // Ghostty omits the spacer before a wide glyph that wrapped offscreen.
    expect(
      resolvedFrameLink(
        resolvedRegions([{ row: 1, start_col: 1, end_col: 22 }]),
        tail,
        1,
        2,
      ).url,
    ).toBeNull();
  });

  test("does not reinterpret OSC 8 labels or malformed/out-of-crop regions as URLs", () => {
    const frame = linkFrame(["", "https://example.com", ""]);
    const region = { row: 1, start_col: 0, end_col: 18 };
    frame.cells[24]!.hyperlink = 0;
    frame.hyperlinks = ["https://example.org/real-target"];
    expect(
      resolvedFrameLink(resolvedRegions([region]), frame, 1, 1).url,
    ).toBeNull();
    for (const invalid of [
      [{ ...region, end_col: 24 }],
      [{ ...region, row: 3 }],
      [{ ...region, start_col: -1 }],
      [region, region],
      [{ ...region, row: 0 }],
    ])
      expect(resolvedFrameLink(resolvedRegions(invalid), frame, 1, 1)).toEqual({
        regions: [],
        url: null,
      });
  });

  test.each(["frame", "scroll", "resize", "input", "close"])(
    "drops delayed resolution after %s and never activates plugins",
    async (change) => {
      let send!: (panes: TestPane[]) => void;
      let finish!: (result: unknown) => void;
      let dispatched!: () => void;
      const pending = new Promise<void>((resolve) => {
        dispatched = resolve;
      });
      const requests: { method: string; params: any }[] = [];
      const socketPath = await startSessionServer({
        methods: [
          "pane.focus",
          "pane.scroll",
          "pane.link.resolve",
          "pane.link.activate",
        ],
        onConnection: (value) => {
          send = value;
        },
        onRequest: (method, params) => {
          requests.push({ method, params });
          if (method === "pane.link.resolve") {
            dispatched();
            return new Promise((resolve) => {
              finish = resolve;
            });
          }
        },
      });
      const session = new EndpointTerminalSession(
        socketPath,
        "terminal",
        async () => "w1:p1",
      );
      let token = "";
      session.on("terminal", (frame) => {
        token = frame.linkFrame;
      });
      try {
        await session.connect(8, 3, { cols: 10, rows: 5 });
        const result = session
          .resolveLink(token, 1, 2)
          .catch((error: unknown) => error);
        await pending;
        expect(requests.at(-1)).toEqual({
          method: "pane.link.resolve",
          params: {
            pane_id: "w1:p1",
            viewport_row: 1,
            col: 2,
            content_revision: 1,
            offset_from_bottom: 0,
          },
        });
        if (change === "frame") {
          const next = once(session, "terminal");
          send(DEFAULT_PANES.map((pane) => ({ ...pane, contentRevision: 2 })));
          await next;
        } else if (change === "scroll") session.scroll("up", 2);
        else if (change === "resize") session.resize(9, 3);
        else if (change === "input") session.input(Buffer.from("a"));
        else session.close();
        finish(resolvedRegions([{ row: 1, start_col: 0, end_col: 7 }]));
        expect(await result).toBeInstanceOf(Error);
        expect(requests.some((r) => r.method === "pane.link.activate")).toBe(
          false,
        );
      } finally {
        session.close();
      }
    },
  );

  test.each(["reversal", "clamped"])(
    "%s scroll without a surface keeps new lookups usable but retires pending replies",
    async (kind) => {
      const held = deferred<unknown>();
      const dispatched = deferred<void>();
      let requests = 0;
      let scrolls = 0;
      const socketPath = await startSessionServer({
        methods: ["pane.focus", "pane.scroll", "pane.link.resolve"],
        onRequest: (method) => {
          if (method === "pane.scroll") {
            scrolls++;
            return paneScrollResult(0, 0);
          }
          if (method === "pane.link.resolve") {
            if (++requests === 1) {
              dispatched.resolve();
              return held.promise;
            }
            return resolvedRegions([]);
          }
        },
      });
      const session = new EndpointTerminalSession(
        socketPath,
        "terminal",
        async () => "w1:p1",
      );
      let token = "";
      let frames = 0;
      session.on("terminal", (frame) => {
        token = frame.linkFrame;
        frames++;
      });
      try {
        await session.connect(8, 3, { cols: 10, rows: 5 });
        const displayed = token;
        const frameCount = frames;
        const stale = session.resolveLink(displayed, 1, 2).catch((e) => e);
        await dispatched.promise;
        session.scroll("up", 3);
        if (kind === "reversal") session.scroll("down", 3);
        await session.focus(() => false);
        held.resolve(resolvedRegions([]));
        expect(await stale).toBeInstanceOf(Error);
        expect(await session.resolveLink(displayed, 1, 2)).toEqual({
          regions: [],
          url: null,
        });
        expect(token).toBe(displayed);
        expect(frames).toBe(frameCount);
        expect(scrolls).toBe(kind === "reversal" ? 0 : 1);
      } finally {
        held.resolve(resolvedRegions([]));
        session.close();
      }
    },
  );

  test("resolve and focus full-surface emissions retain link identity, but content and intent do not", async () => {
    const frame = linkFrame(["", " https://example.com/a", ""], 24);
    const panes: TestPane[] = [
      {
        paneId: "w1:p1",
        x: 0,
        mouseReporting: false,
        rect: { x: 0, y: 0, width: 24, height: 3 },
        innerRect: { x: 0, y: 0, width: 24, height: 3 },
      },
    ];
    let send!: (panes: TestPane[], frame?: FrameData) => void;
    const methods: string[] = [];
    const socketPath = await startSessionServer({
      initialSurface: { frame, panes },
      methods: ["pane.focus", "pane.scroll", "pane.link.resolve"],
      onConnection: (value) => {
        send = value;
      },
      onRequest: async (method) => {
        methods.push(method);
        // Real Herdr emits a new full surface as a side effect of each RPC.
        if (method === "pane.link.resolve") {
          const shown = once(session, "terminal");
          send(panes, structuredClone(frame));
          await shown;
          return resolvedRegions([{ row: 1, start_col: 1, end_col: 21 }]);
        }
        send(panes, {
          ...frame,
          cursor: { x: 2, y: 1, visible: true, shape: 1 },
        });
      },
    });
    const session = new EndpointTerminalSession(
      socketPath,
      "terminal",
      async () => "w1:p1",
    );
    let token = "";
    session.on("terminal", (value) => {
      token = value.linkFrame;
    });
    try {
      await session.connect(24, 3);
      const original = token;
      expect((await session.resolveLink(original, 1, 2)).url).toBe(
        "https://example.com/a",
      );
      expect(token).toBe(original);
      // A bounded wheel is an intent no-op and produces no acknowledgement.
      session.scroll("down", 3);
      expect((await session.resolveLink(original, 1, 2)).url).toBe(
        "https://example.com/a",
      );
      const focused = once(session, "terminal");
      await session.focus(() => true);
      await focused;
      expect(token).toBe(original);
      expect((await session.resolveLink(original, 1, 2)).url).toBe(
        "https://example.com/a",
      );
      expect(
        methods.filter((method) => method === "pane.link.resolve"),
      ).toHaveLength(3);
      for (const change of [
        "cells",
        "hyperlink",
        "scroll",
        "viewport",
        "revision",
        "input",
      ]) {
        const restored = once(session, "terminal");
        send(panes, frame);
        await restored;
        const before = token;
        const changed = structuredClone(frame);
        const metadata = structuredClone(panes);
        if (change === "cells") changed.cells[25]!.symbol = "X";
        if (change === "hyperlink") {
          changed.cells[25]!.hyperlink = 0;
          changed.hyperlinks = ["https://example.org/other"];
        }
        if (change === "scroll") metadata[0]!.offset = 1;
        if (change === "viewport") metadata[0]!.innerRect!.width = 23;
        if (change === "revision") metadata[0]!.contentRevision = 2;
        if (change === "input") session.input(Buffer.from("a"));
        const shown = once(session, "terminal");
        send(metadata, changed);
        await shown;
        expect(token).not.toBe(before);
        await expect(session.resolveLink(before, 1, 2)).rejects.toThrow(
          "frame changed",
        );
      }
      expect(methods).not.toContain("pane.link.activate");
    } finally {
      session.close();
    }
  });

  test("uses only the attached socket's methods and rejects cells outside its split crop", async () => {
    const requests: string[] = [];
    const socketPath = await startSessionServer({
      methods: (connection) =>
        connection === 1 ? ["pane.focus", "pane.link.resolve"] : ["pane.focus"],
      onRequest: (method) => {
        requests.push(method);
        return resolvedRegions([]);
      },
      panes: [{ paneId: "w1:p2", x: 10, mouseReporting: false }],
    });
    const first = new EndpointTerminalSession(
      socketPath,
      "t2",
      async () => "w1:p2",
    );
    const second = new EndpointTerminalSession(
      socketPath,
      "t2",
      async () => "w1:p2",
    );
    let token = "";
    first.on("terminal", (frame) => {
      token = frame.linkFrame;
    });
    let secondToken = "";
    second.on("terminal", (frame) => {
      secondToken = frame.linkFrame;
    });
    try {
      await first.connect(8, 3, { cols: 20, rows: 5 });
      await first.resolveLink(token, 1, 2);
      await expect(first.resolveLink(token, 0, 8)).rejects.toThrow();
      await second.connect(8, 3, { cols: 20, rows: 5 });
      await expect(second.resolveLink(token, 1, 2)).rejects.toThrow();
      expect(await second.resolveLink(secondToken, 1, 2)).toEqual({
        regions: [],
        url: null,
      });
      expect(requests.filter((r) => r === "pane.link.resolve")).toHaveLength(1);
    } finally {
      first.close();
      second.close();
    }
  });
});

test("terminal.link.resolve requires this viewer's attachment and frame token", async () => {
  const requests: { method: string; params: any }[] = [];
  const socketPath = await startSessionServer({
    methods: ["pane.focus", "pane.link.resolve"],
    onRequest: (method, params) => {
      requests.push({ method, params });
      return resolvedRegions([]);
    },
  });
  const { bridge, ws, replies, attach } = creationBridge(socketPath);
  try {
    await attach();
    const frame = replies.find((reply) => reply.terminal?.link_frame)?.terminal
      .link_frame;
    expect(frame).toBeString();
    const params = { terminal_id: "term1", frame, row: 1, col: 2 };
    await bridge.handleTerminalRpc(
      ws,
      "resolve",
      "terminal.link.resolve",
      params,
    );
    expect(replies.find((reply) => reply.id === "resolve")?.result).toEqual({
      regions: [],
      url: null,
    });
    await bridge.handleTerminalRpc(
      {} as ServerWebSocket<unknown>,
      "other-viewer",
      "terminal.link.resolve",
      params,
    );
    await bridge.handleTerminalRpc(ws, "bad-cell", "terminal.link.resolve", {
      ...params,
      row: 0.5,
    });
    await bridge.handleTerminalRpc(ws, "bad-frame", "terminal.link.resolve", {
      ...params,
      frame: "prior-socket:1",
    });
    await bridge.handleTerminalRpc(ws, "detach", "terminal.detach", {
      terminal_id: "term1",
    });
    await bridge.handleTerminalRpc(
      ws,
      "detached",
      "terminal.link.resolve",
      params,
    );
    for (const id of ["other-viewer", "bad-cell", "bad-frame", "detached"])
      expect(replies.find((reply) => reply.id === id)?.error).toBeDefined();
    expect(requests.filter((r) => r.method === "pane.link.resolve")).toEqual([
      {
        method: "pane.link.resolve",
        params: {
          pane_id: "w1:p1",
          viewport_row: 1,
          col: 2,
          content_revision: 1,
          offset_from_bottom: 0,
        },
      },
    ]);
  } finally {
    bridge.dispose();
  }
});

test("optional link lookup timeout does not block scroll or disconnect the terminal", async () => {
  const started = deferred<void>();
  const scrolled = deferred<void>();
  const socketPath = await startSessionServer({
    methods: ["pane.focus", "pane.scroll", "pane.link.resolve"],
    onRequest: (method) => {
      if (method === "pane.link.resolve") {
        started.resolve();
        return new Promise(() => {});
      }
      if (method === "pane.scroll") scrolled.resolve();
    },
  });
  const session = new EndpointTerminalSession(
    socketPath,
    "terminal",
    async () => "w1:p1",
  );
  let frame = "";
  session.on("terminal", (value) => {
    frame = value.linkFrame;
  });
  try {
    await session.connect(8, 3, { cols: 10, rows: 5 });
    jest.useFakeTimers();
    const lookup = session
      .resolveLink(frame, 1, 2)
      .catch((error: unknown) => error);
    await started.promise;
    session.scroll("up", 1);
    await scrolled.promise;
    jest.advanceTimersByTime(1500);
    expect(await lookup).toBeInstanceOf(Error);
    expect(session.isClosed).toBe(false);
  } finally {
    jest.useRealTimers();
    session.close();
  }
});

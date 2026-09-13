import { afterEach, describe, expect, jest, test } from "bun:test";
import { once } from "node:events";
import * as net from "node:net";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { BinReader, BinWriter, encodeFrame } from "./bincode";
import { EndpointClient, type EndpointSurface } from "./endpoint-client";
import type { CellData, FrameData } from "./thin-client";

const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

const WELCOME = {
  generation: 1,
  server_version: "0.9.0",
  snapshot_codec: "shell.snapshot.v1",
  surface_codec: "shell.surface.v1",
  input_codec: "shell.input.semantic.v1",
  blob_codec: "shell.blob.v1",
  methods: ["pane.focus"],
  capabilities: ["surface_interest", "health_check"],
};

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
  w.bytes(Buffer.alloc(0)); // graphics
}

function writePane(
  w: BinWriter,
  paneId: string,
  focused = true,
  mouseReporting = false,
) {
  w.string(paneId);
  w.varint(1); // content_revision
  for (const rect of [
    { x: 0, y: 0, width: 10, height: 5 },
    { x: 0, y: 0, width: 10, height: 5 },
  ]) {
    w.varint(rect.x);
    w.varint(rect.y);
    w.varint(rect.width);
    w.varint(rect.height);
  }
  w.bool(false); // scrollbar_rect
  w.bool(false); // scroll metrics
  w.bool(focused);
  w.bool(mouseReporting); // mouse_reporting
  w.bool(false); // sgr_pixel_mouse
  w.bool(false); // alternate_screen_active
  w.varint(0); // pixel_width
  w.varint(0); // pixel_height
}

type TestPane = {
  paneId: string;
  focused?: boolean;
  mouseReporting?: boolean;
};

function surfaceFrame(payload: {
  surfaceRevision: number;
  frame: FrameData;
  panes?: TestPane[];
}): Buffer {
  const w = new BinWriter();
  w.variant(13); // PaneSurface
  w.string("boot-1");
  w.varint(1); // projection_revision
  w.varint(payload.surfaceRevision);
  writeFrame(w, payload.frame);
  const panes = payload.panes ?? [{ paneId: "w1:p1" }];
  w.varint(panes.length);
  for (const pane of panes)
    writePane(w, pane.paneId, pane.focused, pane.mouseReporting);
  w.varint(0); // splits
  w.bool(false); // popup
  // SurfaceGraphicsScene tail: the client stops reading before it.
  return w.toBuffer();
}

function patchFrame(payload: {
  baseSurfaceRevision: number;
  surfaceRevision: number;
  rows: Array<{ x: number; y: number; cells: CellData[] }>;
  cursor?: FrameData["cursor"];
  panes?: TestPane[];
  mouseReporting?: boolean;
}): Buffer {
  const w = new BinWriter();
  w.variant(19); // PaneSurfacePatch
  w.string("boot-1");
  w.varint(1);
  w.varint(payload.baseSurfaceRevision);
  w.varint(payload.surfaceRevision);
  w.varint(payload.rows.length);
  for (const row of payload.rows) {
    w.varint(row.x);
    w.varint(row.y);
    w.varint(row.cells.length);
    for (const c of row.cells) writeCell(w, c);
  }
  const panes = payload.panes ?? [
    { paneId: "w1:p1", mouseReporting: payload.mouseReporting },
  ];
  w.varint(panes.length);
  for (const pane of panes)
    writePane(w, pane.paneId, pane.focused, pane.mouseReporting);
  w.option(payload.cursor, (cur) => {
    w.varint(cur.x);
    w.varint(cur.y);
    w.bool(cur.visible);
    w.u8(cur.shape);
  });
  return w.toBuffer();
}

function controlFrame(kind: string, data: string): Buffer {
  const w = new BinWriter();
  w.variant(20);
  w.string(kind);
  w.string(data);
  return w.toBuffer();
}

/**
 * Fake endpoint server: expects endpoint.hello.v1 as the first message, then
 * replies with the welcome and runs the given script.
 */
async function startEndpointServer(
  onHello: (hello: any, socket: net.Socket) => void,
  onMessage?: (variant: number, reader: BinReader, socket: net.Socket) => void,
  sendSnapshot = true,
  welcome: Record<string, unknown> = WELCOME,
) {
  const socketPath = path.join(
    tmpdir(),
    `herdr-gui-endpoint-${process.pid}-${crypto.randomUUID()}.sock`,
  );
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let input = Buffer.alloc(0);
    let greeted = false;
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
          expect(variant).toBe(20);
          expect(reader.string()).toBe("endpoint.hello.v1");
          const hello = JSON.parse(reader.string());
          expect(reader.remaining).toBe(0);
          socket.write(
            encodeFrame(
              controlFrame("endpoint.welcome.v1", JSON.stringify(welcome)),
            ),
          );
          if (sendSnapshot) {
            socket.write(
              encodeFrame(
                controlFrame(
                  "shell.snapshot.v1",
                  JSON.stringify({ boot_id: "boot-1", revision: 1 }),
                ),
              ),
            );
          }
          onHello(hello, socket);
          continue;
        }
        onMessage?.(variant, reader, socket);
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

describe("EndpointClient (endpoint generation 1)", () => {
  test.each([
    Buffer.from("OSC52 \u4e2d\u6587").toString("base64"),
    "A".repeat(256 * 1024),
  ])(
    "decodes tagged 0.9.0 Clipboard tag 5 as unchanged base64 (case %#)",
    async (data) => {
      const socketPath = await startEndpointServer((_hello, socket) => {
        const w = new BinWriter();
        w.variant(5);
        w.string(data);
        socket.write(encodeFrame(w.toBuffer()));
      });
      const client = new EndpointClient(socketPath);
      const clipboard = new Promise((resolve) =>
        client.once("clipboard", resolve),
      );
      try {
        await client.connect(80, 24);
        expect(await clipboard).toEqual({ data });
      } finally {
        client.close();
      }
    },
  );

  test.each([
    "",
    "?",
    "not base64",
    "YQ=",
    "YQ==\n",
    "A".repeat(256 * 1024 + 4),
  ])("drops invalid or oversized Clipboard bodies (case %#)", async (data) => {
    const socketPath = await startEndpointServer((_hello, socket) => {
      const w = new BinWriter();
      w.variant(5);
      w.string(data);
      socket.write(encodeFrame(w.toBuffer()));
    });
    const client = new EndpointClient(socketPath);
    const received: unknown[] = [];
    client.on("clipboard", (value) => received.push(value));
    try {
      await client.connect(80, 24);
      await Bun.sleep(20);
      expect(received).toEqual([]);
      expect(client.isClosed).toBe(false);
    } finally {
      client.close();
    }
  });

  test("drops trailing Clipboard fields and ignores buffered messages after close", async () => {
    const socketPath = await startEndpointServer((_hello, socket) => {
      const w = new BinWriter();
      w.variant(5);
      w.string("YQ==");
      const valid = encodeFrame(w.toBuffer());
      w.u8(0); // Clipboard has exactly one string field, no tail.
      socket.write(Buffer.concat([encodeFrame(w.toBuffer()), valid, valid]));
    });
    const client = new EndpointClient(socketPath);
    const received: unknown[] = [];
    client.on("clipboard", (value) => {
      received.push(value);
      client.close();
    });
    try {
      await client.connect(80, 24);
      await Bun.sleep(20);
      expect(received).toEqual([{ data: "YQ==" }]);
      expect(client.isClosed).toBe(true);
    } finally {
      client.close();
    }
  });

  test("rejects truncated Clipboard wire strings without delivering data", async () => {
    const socketPath = await startEndpointServer((_hello, socket) => {
      socket.write(encodeFrame(Buffer.from([5, 8, 65])));
    });
    const client = new EndpointClient(socketPath);
    const received: unknown[] = [];
    client.on("clipboard", (value) => received.push(value));
    const error = new Promise<Error>((resolve) =>
      client.once("error", resolve),
    );
    try {
      await client.connect(80, 24);
      expect((await error).message).toContain("short read");
      expect(client.isClosed).toBe(true);
      expect(received).toEqual([]);
    } finally {
      client.close();
    }
  });

  test("sends a generation-1 hello with the required codecs", async () => {
    const socketPath = await startEndpointServer(() => {});
    const client = new EndpointClient(socketPath);
    const welcome = new Promise<any>((resolve) =>
      client.once("welcome", resolve),
    );
    await client.connect(100, 30);
    const w = await welcome;
    expect(w.serverVersion).toBe("0.9.0");
    expect(w.capabilities).toEqual(["surface_interest", "health_check"]);
    client.close();
  });

  test("waits for a valid snapshot after welcome before becoming ready", async () => {
    let peer!: net.Socket;
    const socketPath = await startEndpointServer(
      (_hello, socket) => {
        peer = socket;
      },
      undefined,
      false,
    );
    const client = new EndpointClient(socketPath);
    const welcome = new Promise<void>((resolve) =>
      client.once("welcome", resolve),
    );
    let ready = false;
    const connecting = client.connect(80, 24).then(() => {
      ready = true;
    });
    try {
      await welcome;
      expect(ready).toBe(false);
      const invalidSnapshot = new Promise<void>((resolve) =>
        client.once("snapshot", resolve),
      );
      peer.write(
        encodeFrame(controlFrame("shell.snapshot.v1", '{"boot_id":42}')),
      );
      await invalidSnapshot;
      expect(ready).toBe(false);
      peer.write(
        encodeFrame(controlFrame("shell.snapshot.v1", '{"boot_id":"boot-1"}')),
      );
      await connecting;
      expect(ready).toBe(true);
    } finally {
      client.close();
    }
  });

  test("rejects startup when the peer closes before the snapshot", async () => {
    const socketPath = await startEndpointServer(
      (_hello, socket) => socket.end(),
      undefined,
      false,
    );
    const client = new EndpointClient(socketPath);
    try {
      await expect(client.connect(80, 24)).rejects.toThrow("closed");
    } finally {
      client.close();
    }
  });

  test("times out if welcome is not followed by a snapshot", async () => {
    const socketPath = await startEndpointServer(() => {}, undefined, false);
    const client = new EndpointClient(socketPath);
    jest.useFakeTimers();
    try {
      const welcomed = once(client, "welcome");
      const result = client.connect(80, 24).catch((error: unknown) => error);
      await welcomed;
      jest.advanceTimersByTime(7_999);
      expect(client.isClosed).toBe(false);
      jest.advanceTimersByTime(1);
      expect(await result).toMatchObject({
        message: expect.stringContaining("welcome and snapshot"),
      });
      expect(client.isClosed).toBe(true);
    } finally {
      client.close();
      jest.useRealTimers();
    }
  });

  test.each(["peer", "client"])(
    "rejects pending and new requests when the %s closes",
    async (closer) => {
      const socketPath = await startEndpointServer(
        () => {},
        (variant, _reader, socket) => {
          if (variant === 15 && closer === "peer") socket.end();
        },
      );
      const client = new EndpointClient(socketPath);
      try {
        await client.connect(80, 24);
        const pending = client.callEndpoint("pane.focus", { pane_id: "w1:p1" });
        if (closer === "client") client.close();
        await expect(pending).rejects.toThrow("closed");
        expect(client.isClosed).toBe(true);
        await expect(client.callEndpoint("pane.scroll", {})).rejects.toThrow(
          "closed",
        );
      } finally {
        client.close();
      }
    },
  );

  test("composes full surfaces and applies patches on the matching base", async () => {
    const base: FrameData = {
      cells: Array.from({ length: 20 }, () => cell(" ")),
      width: 10,
      height: 2,
      cursor: null,
      hyperlinks: [],
    };
    const socketPath = await startEndpointServer((_hello, socket) => {
      socket.write(
        encodeFrame(surfaceFrame({ surfaceRevision: 1, frame: base })),
      );
      socket.write(
        encodeFrame(
          patchFrame({
            baseSurfaceRevision: 1,
            surfaceRevision: 2,
            mouseReporting: true,
            rows: [{ x: 2, y: 1, cells: [cell("h"), cell("i")] }],
            cursor: { x: 4, y: 1, visible: true, shape: 1 },
          }),
        ),
      );
      // Stale patch: wrong base must be dropped.
      socket.write(
        encodeFrame(
          patchFrame({
            baseSurfaceRevision: 1,
            surfaceRevision: 3,
            rows: [{ x: 0, y: 0, cells: [cell("X")] }],
          }),
        ),
      );
    });
    const client = new EndpointClient(socketPath);
    const surfaces: EndpointSurface[] = [];
    client.on("surface", (s) => surfaces.push(s));
    await client.connect(10, 2);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(surfaces.length).toBe(2);
    expect(surfaces[0].surfaceRevision).toBe(1);
    expect(surfaces[0].panes).toEqual([
      {
        paneId: "w1:p1",
        contentRevision: 1,
        rect: { x: 0, y: 0, width: 10, height: 5 },
        innerRect: { x: 0, y: 0, width: 10, height: 5 },
        scroll: null,
        focused: true,
        mouseReporting: false,
      },
    ]);
    const patched = surfaces[1];
    expect(patched.panes[0].mouseReporting).toBe(true);
    expect(patched.surfaceRevision).toBe(2);
    expect(patched.frame.cells[12].symbol).toBe("h");
    expect(patched.frame.cells[13].symbol).toBe("i");
    expect(patched.frame.cells[0].symbol).toBe(" ");
    // Earlier emitted frames stay immutable for retained consumers.
    expect(surfaces[0].frame.cells[12].symbol).toBe(" ");
    expect(patched.frame.cursor).toEqual({
      x: 4,
      y: 1,
      visible: true,
      shape: 1,
    });
    client.close();
  });

  test("keeps pane metadata through cursor-only hide, clear, and show patches", async () => {
    const visible = { x: 4, y: 1, visible: true, shape: 5 };
    const cursors = [
      visible,
      { ...visible, visible: false },
      null,
      { ...visible, x: 6 },
    ];
    const socketPath = await startEndpointServer((_hello, socket) => {
      socket.write(
        encodeFrame(
          surfaceFrame({
            surfaceRevision: 1,
            frame: {
              cells: Array.from({ length: 50 }, () => cell(" ")),
              width: 10,
              height: 5,
              cursor: visible,
              hyperlinks: [],
            },
            panes: [{ paneId: "w1:p1" }, { paneId: "w1:p2", focused: false }],
          }),
        ),
      );
      for (let i = 1; i < cursors.length; i++) {
        socket.write(
          encodeFrame(
            patchFrame({
              baseSurfaceRevision: i,
              surfaceRevision: i + 1,
              rows: [],
              panes: [],
              cursor: cursors[i],
            }),
          ),
        );
      }
    });
    const client = new EndpointClient(socketPath);
    const surfaces: EndpointSurface[] = [];
    client.on("surface", (surface) => surfaces.push(surface));
    try {
      await client.connect(10, 5);
      await Bun.sleep(50);
      expect(surfaces).toHaveLength(cursors.length);
      expect(surfaces.map((surface) => surface.frame.cursor)).toEqual(cursors);
      expect(surfaces[0].panes.map((pane) => pane.paneId)).toEqual([
        "w1:p1",
        "w1:p2",
      ]);
      for (const surface of surfaces.slice(1)) {
        expect(surface.panes).toEqual(surfaces[0].panes);
        expect(surface.frame.cells).toEqual(surfaces[0].frame.cells);
      }
    } finally {
      client.close();
    }
  });

  test("merges partial pane updates without losing other panes or mutating earlier surfaces", async () => {
    const socketPath = await startEndpointServer((_hello, socket) => {
      socket.write(
        encodeFrame(
          surfaceFrame({
            surfaceRevision: 1,
            frame: {
              cells: Array.from({ length: 50 }, () => cell(" ")),
              width: 10,
              height: 5,
              cursor: null,
              hyperlinks: [],
            },
            panes: [{ paneId: "w1:p1" }, { paneId: "w1:p2", focused: false }],
          }),
        ),
      );
      socket.write(
        encodeFrame(
          patchFrame({
            baseSurfaceRevision: 1,
            surfaceRevision: 2,
            rows: [{ x: 1, y: 0, cells: [cell("a")] }],
            panes: [{ paneId: "w1:p2", focused: false, mouseReporting: true }],
            cursor: { x: 4, y: 1, visible: true, shape: 5 },
          }),
        ),
      );
      socket.write(
        encodeFrame(
          patchFrame({
            baseSurfaceRevision: 2,
            surfaceRevision: 3,
            rows: [],
            panes: [{ paneId: "w1:p1", mouseReporting: true }],
            cursor: null,
          }),
        ),
      );
    });
    const client = new EndpointClient(socketPath);
    const surfaces: EndpointSurface[] = [];
    client.on("surface", (surface) => surfaces.push(surface));
    try {
      await client.connect(10, 5);
      await Bun.sleep(50);
      expect(surfaces).toHaveLength(3);
      expect(
        surfaces.map((surface) =>
          surface.panes.map((pane) => [pane.paneId, pane.mouseReporting]),
        ),
      ).toEqual([
        [
          ["w1:p1", false],
          ["w1:p2", false],
        ],
        [
          ["w1:p1", false],
          ["w1:p2", true],
        ],
        [
          ["w1:p1", true],
          ["w1:p2", true],
        ],
      ]);
      expect(surfaces[0].frame.cells[1].symbol).toBe(" ");
      expect(surfaces[1].frame.cells[1].symbol).toBe("a");
      expect(surfaces[1].frame.cursor?.visible).toBe(true);
      expect(surfaces[2].frame.cursor).toBeNull();
    } finally {
      client.close();
    }
  });

  test("rejects unknown-pane patches without changing the retained surface", async () => {
    const base: FrameData = {
      cells: Array.from({ length: 50 }, () => cell(" ")),
      width: 10,
      height: 5,
      cursor: null,
      hyperlinks: [],
    };
    const socketPath = await startEndpointServer((_hello, socket) => {
      socket.write(
        encodeFrame(surfaceFrame({ surfaceRevision: 1, frame: base })),
      );
      socket.write(
        encodeFrame(
          patchFrame({
            baseSurfaceRevision: 1,
            surfaceRevision: 2,
            rows: [{ x: 0, y: 0, cells: [cell("X")] }],
            panes: [{ paneId: "unknown" }],
            cursor: { x: 4, y: 1, visible: true, shape: 5 },
          }),
        ),
      );
      socket.write(
        encodeFrame(
          patchFrame({
            baseSurfaceRevision: 1,
            surfaceRevision: 3,
            rows: [{ x: 1, y: 0, cells: [cell("Y")] }],
            panes: [],
            cursor: null,
          }),
        ),
      );
    });
    const client = new EndpointClient(socketPath);
    const surfaces: EndpointSurface[] = [];
    client.on("surface", (surface) => surfaces.push(surface));
    try {
      await client.connect(10, 5);
      await Bun.sleep(50);
      expect(surfaces.map((surface) => surface.surfaceRevision)).toEqual([
        1, 3,
      ]);
      expect(surfaces[0].frame).toEqual(base);
      expect(surfaces[1].frame.cells[0].symbol).toBe(" ");
      expect(surfaces[1].frame.cells[1].symbol).toBe("Y");
      expect(surfaces[1].frame.cursor).toBeNull();
      expect(surfaces[1].panes).toEqual(surfaces[0].panes);
    } finally {
      client.close();
    }
  });

  test("encodes resize and answers health pings with a pong", async () => {
    const seen: Array<{ variant: number; fields: unknown[] }> = [];
    const socketPath = await startEndpointServer(
      (_hello, socket) => {
        socket.write(
          encodeFrame(controlFrame("endpoint.health.ping.v1", "{}")),
        );
      },
      (variant, reader, socket) => {
        if (variant === 12) {
          seen.push({
            variant,
            fields: [
              reader.varint(),
              reader.varint(),
              reader.varint(),
              reader.varint(),
              reader.bool(),
            ],
          });
        } else if (variant === 20) {
          seen.push({ variant, fields: [reader.string(), reader.string()] });
          socket.write(
            encodeFrame(controlFrame("endpoint.health.pong.v1", "{}")),
          );
        }
      },
    );
    const client = new EndpointClient(socketPath);
    await client.connect(100, 30);
    client.resize(80, 24);
    client.ping();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(seen).toContainEqual({ variant: 12, fields: [0, 0, 80, 24, false] });
    expect(seen).toContainEqual({
      variant: 20,
      fields: ["endpoint.health.ping.v1", "{}"],
    });
    // The client's pong reply to the server ping.
    expect(seen).toContainEqual({
      variant: 20,
      fields: ["endpoint.health.pong.v1", "{}"],
    });
    client.close();
  });

  test("rejects when the welcome carries a handshake error", async () => {
    const socketPath = path.join(
      tmpdir(),
      `herdr-gui-endpoint-err-${process.pid}-${crypto.randomUUID()}.sock`,
    );
    const server = net.createServer((socket) => {
      socket.once("data", () => {
        socket.write(
          encodeFrame(
            controlFrame(
              "endpoint.welcome.v1",
              JSON.stringify({
                ...WELCOME,
                methods: [],
                capabilities: [],
                error: {
                  code: "unsupported_generation",
                  message: "endpoint generation 2 is unsupported",
                },
              }),
            ),
          ),
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const client = new EndpointClient(socketPath);
    await expect(client.connect(100, 30)).rejects.toThrow(
      "unsupported_generation",
    );
  });
});

test("method subset and absent health capability never send unsupported bytes", async () => {
  const received: number[] = [];
  const socketPath = await startEndpointServer(
    () => {},
    (variant, _reader, socket) => {
      received.push(variant);
      // Resize acts as an ordered wire fence after the rejected operations.
      if (variant === 12) socket.end();
    },
    true,
    { ...WELCOME, methods: [], capabilities: [] },
  );
  const client = new EndpointClient(socketPath);
  client.on("error", () => {});
  try {
    expect(client.negotiation).toBeNull();
    await client.connect(80, 24);
    expect(client.negotiation?.methods).toEqual([]);
    await expect(client.callEndpoint("pane.focus", {})).rejects.toThrow(
      "does not advertise pane.focus",
    );
    client.ping();
    const closed = new Promise<void>((resolve) =>
      client.once("close", resolve),
    );
    client.resize(80, 24);
    await closed;
    expect(received).toEqual([12]);
    expect(client.negotiation).toBeNull();
  } finally {
    client.close();
  }
});

for (const invalid of [
  { generation: 2 },
  { snapshot_codec: "shell.snapshot.v2" },
  { surface_codec: "shell.surface.v2" },
  { input_codec: "shell.input.raw.v2" },
  { blob_codec: "shell.blob.v2" },
  { methods: "pane.focus" },
  { capabilities: [123] },
]) {
  test(`rejects unverified negotiation ${JSON.stringify(invalid)}`, async () => {
    const received: number[] = [];
    const socketPath = await startEndpointServer(
      () => {},
      (variant) => {
        received.push(variant);
      },
      true,
      { ...WELCOME, ...invalid },
    );
    const client = new EndpointClient(socketPath);
    client.on("error", () => {});
    try {
      await expect(client.connect(80, 24)).rejects.toThrow();
      expect(client.negotiation).toBeNull();
      expect(received).toEqual([]);
    } finally {
      client.close();
    }
  });
}

test("core resize and semantic input wait for verified codecs", () => {
  const client = new EndpointClient("/unused-issue111.sock");
  expect(() => client.resize(80, 24)).toThrow("not been negotiated");
  expect(() =>
    client.sendPaneInput("p1", [{ type: "paste", text: "blocked" }]),
  ).toThrow("not been negotiated");
  client.close();
});

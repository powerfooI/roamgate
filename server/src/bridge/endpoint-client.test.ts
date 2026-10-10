import { afterEach, describe, expect, jest, test } from "bun:test";
import { once } from "node:events";
import * as net from "node:net";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { BinReader, BinWriter, encodeFrame } from "./bincode";
import { EndpointClient, type EndpointSurface } from "./endpoint-client";
import type { CellData, FrameData } from "./thin-client";
import {
  SurfaceReader,
  readFullSurface,
  readSurfaceDelta,
  readSurfaceReuse,
  SURFACE_DELTA_KIND,
  SURFACE_REUSE_KIND,
} from "./endpoint-surface";

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
  bootId?: string;
  projectionRevision?: number;
}): Buffer {
  const w = new BinWriter();
  w.variant(13); // PaneSurface
  w.string(payload.bootId ?? "boot-1");
  w.varint(payload.projectionRevision ?? 1); // projection_revision
  w.varint(payload.surfaceRevision);
  writeFrame(w, payload.frame);
  const panes = payload.panes ?? [{ paneId: "w1:p1" }];
  w.varint(panes.length);
  for (const pane of panes)
    writePane(w, pane.paneId, pane.focused, pane.mouseReporting);
  w.varint(0); // splits
  w.bool(false); // popup
  w.varint(0); // graphics assets
  w.varint(0); // graphics placements
  w.varint(0); // retained assets
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
    const socketPath = await startEndpointServer((hello) => {
      expect(hello.surface_delta).toBe(true);
      expect(hello.surface_reuse).toBe(true);
      expect(hello.surface_codecs).toEqual(["shell.surface.v1"]);
    });
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
    const error = new Promise<Error>((resolve) =>
      client.once("error", resolve),
    );
    await client.connect(10, 2);
    expect((await error).message).toContain("baseline mismatch");
    expect(client.isClosed).toBe(true);
    expect(client.currentSurface).toBeNull();

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

  test("closes unknown-pane patches without emitting a partial surface", async () => {
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
    const error = new Promise<Error>((resolve) =>
      client.once("error", resolve),
    );
    try {
      await client.connect(10, 5);
      expect((await error).message).toContain("topology");
      expect(surfaces.map((surface) => surface.surfaceRevision)).toEqual([1]);
      expect(surfaces[0].frame).toEqual(base);
      expect(client.currentSurface).toBeNull();
      expect(client.isClosed).toBe(true);
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
    const errors: Error[] = [];
    client.once("error", (error: Error) => errors.push(error));
    try {
      await expect(client.connect(100, 30)).rejects.toThrow(
        "unsupported_generation",
      );
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("unsupported_generation");
      expect(client.isClosed).toBe(true);
    } finally {
      client.close();
    }
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

const CODEC_WELCOME = {
  ...WELCOME,
  server_version: "0.9.1",
  capabilities: ["surface_delta", "surface_reuse", "health_check"],
};
const CODEC_FRAME: FrameData = {
  width: 10,
  height: 5,
  cells: Array.from({ length: 50 }, () => cell(" ")),
  cursor: null,
  hyperlinks: [],
};

function deltaData(
  options: {
    base?: number;
    baseProjection?: number;
    revision?: number;
    projection?: number;
    bootId?: string;
    frame?: FrameData;
    panes?: TestPane[];
    rows?: Array<{ x: number; y: number; cells: CellData[] }>;
  } = {},
) {
  const w = new BinWriter();
  w.varint(options.baseProjection ?? 1);
  w.varint(options.base ?? 1);
  const surface = surfaceFrame({
    surfaceRevision: options.revision ?? 2,
    projectionRevision: options.projection ?? 2,
    bootId: options.bootId,
    frame: options.frame ?? { ...CODEC_FRAME, cells: [] },
    panes: options.panes,
  }).subarray(1); // SurfaceDelta embeds the struct, not the enum tag.
  const tail = new BinWriter();
  const rows = options.rows ?? [{ x: 2, y: 1, cells: [cell("x")] }];
  tail.varint(rows.length);
  for (const row of rows) {
    tail.varint(row.x);
    tail.varint(row.y);
    tail.varint(row.cells.length);
    for (const c of row.cells) writeCell(tail, c);
  }
  tail.bool(false); // popup_cells
  return Buffer.concat([w.toBuffer(), surface, tail.toBuffer()])
    .toString("base64")
    .replace(/=+$/, "");
}

function reuseData(base = 2, revision = 3) {
  return {
    base_surface_revision: base,
    surface: {
      boot_id: "boot-1",
      projection_revision: 3,
      surface_revision: revision,
      frame: { ...CODEC_FRAME, cells: [] as CellData[], graphics: [] },
      panes: [
        {
          pane_id: "w1:p2",
          content_revision: 9,
          rect: { x: 0, y: 0, width: 10, height: 5 },
          inner_rect: { x: 1, y: 1, width: 8, height: 3 },
          scrollbar_rect: null,
          scroll: {
            offset_from_bottom: 5,
            max_offset_from_bottom: 20,
            viewport_rows: 3,
          },
          focused: true,
          mouse_reporting: true,
          sgr_pixel_mouse: false,
          alternate_screen_active: false,
          pixel_width: 0,
          pixel_height: 0,
        },
      ],
      splits: [],
      popup: null,
      graphics: { assets: [], placements: [], retained_assets: [] },
    },
  };
}

function codecBaseline() {
  const r = new SurfaceReader(
    surfaceFrame({ surfaceRevision: 1, frame: CODEC_FRAME }),
  );
  r.variant();
  return readFullSurface(r);
}

// This checksum is frozen by Herdr v0.9.1's surface_delta_v1_binary_fixture_is_frozen.
test.each([true, false])(
  "legacy full frames and patches accept u32 hyperlinks (codecs: %s)",
  async (enabled) => {
    const frame: FrameData = {
      width: 257,
      height: 257,
      cursor: null,
      cells: Array.from({ length: 257 * 257 }, (_, i) =>
        cell("x", { hyperlink: i < 65537 ? i : null }),
      ),
      hyperlinks: Array.from(
        { length: 65537 },
        (_, i) => `https://e.test/${i.toString(36)}`,
      ),
    };
    const full = surfaceFrame({ surfaceRevision: 1, frame });
    expect(full.length).toBeLessThan(2 * 1024 * 1024);
    let peer!: net.Socket;
    const socketPath = await startEndpointServer((_hello, socket) => {
      peer = socket;
      socket.write(encodeFrame(full));
    });
    const client = new EndpointClient(socketPath, enabled);
    try {
      const first = once(client, "surface");
      await Promise.all([client.connect(257, 257), first]);
      expect(client.currentSurface?.frame.hyperlinks).toHaveLength(65537);
      expect(client.currentSurface?.frame.cells[65536].hyperlink).toBe(65536);
      const patched = once(client, "surface");
      peer.write(
        encodeFrame(
          patchFrame({
            baseSurfaceRevision: 1,
            surfaceRevision: 2,
            rows: [{ x: 0, y: 0, cells: [cell("Y", { hyperlink: 65536 })] }],
          }),
        ),
      );
      await patched;
      expect(client.currentSurface?.frame.cells[0]).toMatchObject({
        symbol: "Y",
        hyperlink: 65536,
      });
      expect(client.isClosed).toBe(false);
    } finally {
      client.close();
    }
    expect(() =>
      readSurfaceDelta(
        deltaData({ frame: { ...frame, cells: [] } }),
        codecBaseline(),
      ),
    ).toThrow("integer out of range");
  },
);

test("full-frame pane collections are byte-bounded rather than delta-bounded", () => {
  const panes = Array.from({ length: 4097 }, (_, i) => ({
    paneId: `pane-${i}`,
  }));
  const reader = new SurfaceReader(
    surfaceFrame({ surfaceRevision: 1, frame: CODEC_FRAME, panes }),
  );
  reader.variant();
  expect(readFullSurface(reader).panes).toHaveLength(4097);
  expect(() => readSurfaceDelta(deltaData({ panes }), codecBaseline())).toThrow(
    "integer out of range",
  );
});

test("delta fixture matches the upstream frozen wire checksum", () => {
  const data = deltaData({
    bootId: "boot",
    frame: { ...CODEC_FRAME, width: 120, height: 40, cells: [] },
    panes: [],
    rows: [{ x: 0, y: 0, cells: [cell("x")] }],
  });
  const wire = encodeFrame(controlFrame(SURFACE_DELTA_KIND, data));
  expect(new Bun.CryptoHasher("sha256").update(wire).digest("hex")).toBe(
    "1effe2cbf998ff334bda9151995b87d54e646a1b90c10d853723d5bc1c8a84bf",
  );
});

test("full, delta, reuse, patch and resized full share one immutable baseline", async () => {
  const reuse = reuseData();
  reuse.surface.frame.cursor = { x: 2, y: 1, visible: false, shape: 5 };
  const socketPath = await startEndpointServer(
    (_hello, socket) => {
      const messages = [
        surfaceFrame({
          surfaceRevision: 1,
          frame: CODEC_FRAME,
          panes: [{ paneId: "w1:p1" }, { paneId: "w1:p2" }],
        }),
        controlFrame(
          SURFACE_DELTA_KIND,
          deltaData({
            panes: [
              { paneId: "w1:p1", focused: false },
              { paneId: "w1:p2", mouseReporting: true },
            ],
          }),
        ),
        controlFrame(SURFACE_REUSE_KIND, JSON.stringify(reuse)),
        // Return to another tab at the same geometry: metadata is a complete list.
        controlFrame(
          SURFACE_DELTA_KIND,
          deltaData({
            base: 3,
            baseProjection: 3,
            revision: 4,
            projection: 4,
            panes: [{ paneId: "w2:p1" }],
            rows: [],
          }),
        ),
        surfaceFrame({
          surfaceRevision: 5,
          projectionRevision: 5,
          frame: { ...CODEC_FRAME, width: 5, height: 10 },
        }),
        controlFrame(
          SURFACE_DELTA_KIND,
          deltaData({
            base: 5,
            baseProjection: 5,
            revision: 6,
            projection: 5,
            frame: { ...CODEC_FRAME, width: 5, height: 10, cells: [] },
            rows: [{ x: 4, y: 9, cells: [cell("Z")] }],
          }),
        ),
      ];
      // Fragment a control payload and coalesce the rest on the same socket.
      const wire = Buffer.concat(messages.map(encodeFrame));
      socket.write(wire.subarray(0, 7));
      socket.write(wire.subarray(7));
    },
    undefined,
    true,
    CODEC_WELCOME,
  );
  const client = new EndpointClient(socketPath);
  const surfaces: EndpointSurface[] = [];
  const done = new Promise<void>((resolve) =>
    client.on("surface", (s) => {
      surfaces.push(s);
      if (surfaces.length === 6) resolve();
    }),
  );
  try {
    await client.connect(10, 5);
    await done;
    expect(surfaces.map((s) => s.surfaceRevision)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(surfaces[0].frame.cells[12].symbol).toBe(" ");
    expect(surfaces[1].frame.cells[12].symbol).toBe("x");
    expect(surfaces[1].panes).toHaveLength(2);
    expect(surfaces[2].panes.map((p) => p.paneId)).toEqual(["w1:p2"]);
    expect(surfaces[2].panes[0].scroll?.offsetFromBottom).toBe(5);
    expect(surfaces[2].panes[0].mouseReporting).toBe(true);
    expect(surfaces[2].frame.cursor?.visible).toBe(false);
    expect(surfaces[3].panes[0].paneId).toBe("w2:p1");
    expect(surfaces[3].frame.cursor).toBeNull();
    expect(surfaces[5].frame.cells[49].symbol).toBe("Z");
    expect(surfaces[4].frame.cells[49].symbol).toBe(" ");
  } finally {
    client.close();
  }
});

test("legacy patch updates the base used by delta and reuse", async () => {
  const socketPath = await startEndpointServer(
    (_hello, socket) => {
      for (const payload of [
        surfaceFrame({ surfaceRevision: 1, frame: CODEC_FRAME }),
        patchFrame({
          baseSurfaceRevision: 1,
          surfaceRevision: 2,
          rows: [{ x: 0, y: 0, cells: [cell("P")] }],
        }),
        controlFrame(SURFACE_DELTA_KIND, deltaData({ base: 2, revision: 3 })),
        controlFrame(SURFACE_REUSE_KIND, JSON.stringify(reuseData(3, 4))),
      ])
        socket.write(encodeFrame(payload));
    },
    undefined,
    true,
    CODEC_WELCOME,
  );
  const client = new EndpointClient(socketPath);
  const done = new Promise<EndpointSurface>((resolve) =>
    client.on("surface", (s) => {
      if (s.surfaceRevision === 4) resolve(s);
    }),
  );
  try {
    await client.connect(10, 5);
    const surface = await done;
    expect(surface.frame.cells[0].symbol).toBe("P");
    expect(surface.frame.cells[12].symbol).toBe("x");
  } finally {
    client.close();
  }
});

for (const [name, options] of Object.entries({
  "wrong base": { base: 0 },
  "wrong projection": { baseProjection: 0 },
  "revision gap": { revision: 3 },
  "duplicate revision": { revision: 1 },
  "old projection": { projection: 0 },
  "other boot": { bootId: "boot-2" },
  resize: { frame: { ...CODEC_FRAME, width: 5, height: 10, cells: [] } },
  "nonempty grid": { frame: CODEC_FRAME },
  "outside row": { rows: [{ x: 10, y: 0, cells: [cell("!")] }] },
  "outside grid": { rows: [{ x: 0, y: 5, cells: [cell("!")] }] },
  "empty span": { rows: [{ x: 0, y: 0, cells: [] }] },
  overlap: {
    rows: [
      { x: 0, y: 0, cells: [cell("!")] },
      { x: 0, y: 0, cells: [cell("!")] },
    ],
  },
  "bad hyperlink": {
    rows: [{ x: 0, y: 0, cells: [cell("!", { hyperlink: 0 })] }],
  },
})) {
  test(`rejects delta ${name} atomically`, () => {
    const base = codecBaseline();
    expect(() => readSurfaceDelta(deltaData(options), base)).toThrow();
    expect(base.surfaceRevision).toBe(1);
    expect(base.frame.cells[12].symbol).toBe(" ");
    expect(readSurfaceDelta(deltaData(), base).frame.cells[12].symbol).toBe(
      "x",
    );
  });
}

test("rejects malformed base64, trailing bytes and oversized collection prefixes", () => {
  const base = codecBaseline();
  const valid = Buffer.from(deltaData(), "base64");
  for (const data of [
    "!",
    "A",
    deltaData() + "=",
    Buffer.concat([valid, Buffer.from([0])])
      .toString("base64")
      .replace(/=+$/, ""),
  ])
    expect(() => readSurfaceDelta(data, base)).toThrow();
  // Replace the metadata grid count with a huge u64; no cells may be allocated.
  const w = new BinWriter();
  w.varint(1);
  w.varint(1);
  w.string("boot-1");
  w.varint(2);
  w.varint(2);
  w.varint(2n ** 63n);
  expect(() =>
    readSurfaceDelta(w.toBuffer().toString("base64").replace(/=+$/, ""), base),
  ).toThrow();
});

test("hyperlink tables, wide cells, combining text and styles survive deltas", () => {
  const base = codecBaseline();
  const styled = cell("\u4e2d", {
    fg: 0xff112233,
    bg: 0xff445566,
    modifier: 3,
    hyperlink: 0,
  });
  const data = deltaData({
    frame: { ...CODEC_FRAME, cells: [], hyperlinks: ["https://example.com"] },
    rows: [
      {
        x: 0,
        y: 0,
        cells: [styled, cell("", { skip: true }), cell("e\u0301")],
      },
    ],
  });
  const surface = readSurfaceDelta(data, base);
  expect(surface.frame.cells.slice(0, 3)).toEqual([
    styled,
    cell("", { skip: true }),
    cell("e\u0301"),
  ]);
  expect(surface.frame.hyperlinks).toEqual(["https://example.com"]);
  const reuse = reuseData();
  reuse.surface.frame.hyperlinks = [];
  expect(() => readSurfaceReuse(JSON.stringify(reuse), surface)).toThrow(
    "hyperlink",
  );
});

test.each([SURFACE_DELTA_KIND, SURFACE_REUSE_KIND])(
  "connection-local negotiation and fresh baseline for %s",
  async (kind) => {
    let connection = 0;
    const socketPath = await startEndpointServer(
      (_hello, socket) => {
        if (++connection === 1)
          socket.write(
            encodeFrame(
              surfaceFrame({ surfaceRevision: 1, frame: CODEC_FRAME }),
            ),
          );
        socket.write(
          encodeFrame(
            controlFrame(
              kind,
              kind === SURFACE_DELTA_KIND
                ? deltaData()
                : JSON.stringify(reuseData(1, 2)),
            ),
          ),
        );
      },
      undefined,
      true,
      CODEC_WELCOME,
    );
    for (let i = 0; i < 2; i++) {
      const client = new EndpointClient(socketPath);
      const result = new Promise<string>((resolve) => {
        client.on("error", () => resolve("error"));
        client.on("surface", (s) => {
          if (s.surfaceRevision === 2) resolve("surface");
        });
      });
      try {
        await client.connect(10, 5);
        expect(await result).toBe(i === 0 ? "surface" : "error");
        if (i === 1) {
          expect(client.isClosed).toBe(true);
          expect(client.currentSurface).toBeNull();
        }
      } finally {
        client.close();
      }
    }
    const oldPath = await startEndpointServer((_hello, socket) =>
      socket.write(encodeFrame(controlFrame(kind, "invalid"))),
    );
    const old = new EndpointClient(oldPath);
    const error = new Promise<Error>((resolve) => old.once("error", resolve));
    try {
      await old.connect(10, 5);
      expect((await error).message).toContain("unnegotiated");
    } finally {
      old.close();
    }
  },
);

test("popup patch/replace and graphics tails cannot desynchronize main delta rows", () => {
  function popupSurface(revision: number, metadata: boolean, popupId: string) {
    const w = new BinWriter();
    w.string("boot-1");
    w.varint(1);
    w.varint(revision);
    writeFrame(w, { ...CODEC_FRAME, cells: metadata ? [] : CODEC_FRAME.cells });
    w.varint(0); // panes
    w.varint(1); // splits
    w.variant(1);
    w.varint(4);
    for (let i = 0; i < 2; i++) for (const n of [0, 0, 10, 5]) w.varint(n);
    w.varint(2);
    w.bool(true);
    w.bool(false);
    w.bool(true);
    w.string(popupId);
    w.string("popup");
    w.bool(true);
    w.variant(0);
    w.varint(2); // width in cells
    w.bool(true);
    w.variant(1);
    w.u8(50); // height in percent
    writeFrame(w, {
      ...CODEC_FRAME,
      width: 2,
      height: 1,
      cells: metadata ? [] : [cell("a"), cell("b")],
    });
    w.bool(false);
    w.bool(false);
    w.varint(0);
    w.varint(0);
    const key = (layer: boolean) => {
      w.variant(layer ? 1 : 0);
      if (layer) {
        w.string("w1:p1");
        w.string("layer");
      } else {
        w.variant(1);
        w.string(popupId);
        w.varint(1);
      }
      w.varint(1);
      w.varint(1);
      w.variant(1);
      w.varint(4);
      w.varint(2n ** 63n);
    };
    w.varint(1);
    key(true);
    w.bytes(Buffer.from([0, 128, 255, 255]));
    w.varint(1);
    key(false);
    for (let i = 0; i < 13; i++) w.varint(i);
    w.varint(1);
    key(true);
    return w.toBuffer();
  }
  let base = readFullSurface(
    new SurfaceReader(popupSurface(1, false, "popup-1")),
  );
  const first = base;
  for (const [revision, replace, id] of [
    [2, false, "popup-1"],
    [3, true, "popup-2"],
  ] as const) {
    const prefix = new BinWriter();
    prefix.varint(1);
    prefix.varint(revision - 1);
    const tail = new BinWriter();
    tail.varint(1);
    tail.varint(0);
    tail.varint(0);
    tail.varint(1);
    writeCell(tail, cell("M"));
    tail.bool(true);
    tail.variant(replace ? 1 : 0);
    if (replace) {
      tail.varint(2);
      writeCell(tail, cell("Y"));
      writeCell(tail, cell("Z"));
    } else {
      tail.varint(1);
      tail.varint(1);
      tail.varint(0);
      tail.varint(1);
      writeCell(tail, cell("X"));
    }
    const data = Buffer.concat([
      prefix.toBuffer(),
      popupSurface(revision, true, id),
      tail.toBuffer(),
    ])
      .toString("base64")
      .replace(/=+$/, "");
    base = readSurfaceDelta(data, base);
    expect(base.frame.cells[0].symbol).toBe("M");
    expect(base.popup?.frame.cells.map((c) => c.symbol).join("")).toBe(
      replace ? "YZ" : "aX",
    );
  }
  expect(first.popup?.frame.cells.map((c) => c.symbol).join("")).toBe("ab");
  expect(first.frame.cells[0].symbol).toBe(" ");
});

test("reuse rejects invalid JSON metadata and revision mismatches atomically", () => {
  const base = codecBaseline();
  for (const mutate of [
    (v: ReturnType<typeof reuseData>) => {
      v.base_surface_revision = 0;
    },
    (v: ReturnType<typeof reuseData>) => {
      v.surface.surface_revision = 3;
    },
    (v: ReturnType<typeof reuseData>) => {
      v.surface.boot_id = "other";
    },
    (v: ReturnType<typeof reuseData>) => {
      v.surface.projection_revision = 0;
    },
    (v: ReturnType<typeof reuseData>) => {
      v.surface.frame.width = 9;
    },
    (v: ReturnType<typeof reuseData>) => {
      v.surface.frame.cells = [cell("!")];
    },
    (v: ReturnType<typeof reuseData>) => {
      v.surface.panes[0].content_revision = Number.MAX_SAFE_INTEGER + 1;
    },
    (v: ReturnType<typeof reuseData>) => {
      v.surface.panes.push(v.surface.panes[0]);
    },
  ]) {
    const data = reuseData(1, 2);
    mutate(data);
    expect(() => readSurfaceReuse(JSON.stringify(data), base)).toThrow();
    expect(base.surfaceRevision).toBe(1);
  }
  expect(() => readSurfaceReuse("{", base)).toThrow();
  expect(() =>
    readSurfaceReuse(
      JSON.stringify({ ...reuseData(1, 2), surface: null }),
      base,
    ),
  ).toThrow();
});

test.each(["snapshot boot", "surface boot", "stale full", "stale projection"])(
  "closes a connection with %s without publishing its frame",
  async (kind) => {
    const socketPath = await startEndpointServer((_hello, socket) => {
      socket.write(
        encodeFrame(surfaceFrame({ surfaceRevision: 1, frame: CODEC_FRAME })),
      );
      socket.write(
        encodeFrame(
          kind === "snapshot boot"
            ? controlFrame(
                "shell.snapshot.v1",
                JSON.stringify({ boot_id: "boot-2", revision: 1 }),
              )
            : surfaceFrame({
                surfaceRevision: kind === "stale full" ? 1 : 2,
                frame: CODEC_FRAME,
                bootId: kind === "surface boot" ? "boot-2" : "boot-1",
                projectionRevision: kind === "stale projection" ? 0 : 1,
              }),
        ),
      );
    });
    const client = new EndpointClient(socketPath);
    const surfaces: EndpointSurface[] = [];
    client.on("surface", (surface) => surfaces.push(surface));
    const error = new Promise<Error>((resolve) =>
      client.once("error", resolve),
    );
    try {
      await client.connect(10, 5);
      expect((await error).message).toContain("reconnect required");
      expect(surfaces).toHaveLength(1);
      expect(client.currentSurface).toBeNull();
      expect(client.isClosed).toBe(true);
    } finally {
      client.close();
    }
  },
);

test("disabled surface codecs are omitted from negotiation even when advertised", async () => {
  let peer!: net.Socket;
  const socketPath = await startEndpointServer(
    (hello, socket) => {
      expect(hello.surface_delta).toBe(false);
      expect(hello.surface_reuse).toBe(false);
      peer = socket;
      socket.write(
        encodeFrame(surfaceFrame({ surfaceRevision: 1, frame: CODEC_FRAME })),
      );
    },
    undefined,
    true,
    CODEC_WELCOME,
  );
  const client = new EndpointClient(socketPath, false);
  const error = new Promise<Error>((resolve) => client.once("error", resolve));
  try {
    await client.connect(10, 5);
    expect(client.currentSurface?.frame).toEqual(CODEC_FRAME);
    peer.write(encodeFrame(controlFrame(SURFACE_DELTA_KIND, deltaData())));
    expect((await error).message).toContain("unnegotiated");
    expect(client.isClosed).toBe(true);
  } finally {
    client.close();
  }
});

test("core resize and semantic input wait for verified codecs", () => {
  const client = new EndpointClient("/unused-issue111.sock");
  expect(() => client.resize(80, 24)).toThrow("not been negotiated");
  expect(() =>
    client.sendPaneInput("p1", [{ type: "paste", text: "blocked" }]),
  ).toThrow("not been negotiated");
  client.close();
});

type SemanticFixture = {
  kind: number;
  title: string;
  body?: string;
  sound?: number;
  agent?: string;
  workspaceId?: string;
  tabId?: string;
  paneId?: string;
  position?: number;
};

// Mirrors Herdr's `ServerMessage::SemanticNotification` (tag 14) layout.
function semanticNotificationFrame(n: SemanticFixture): Buffer {
  const w = new BinWriter();
  w.variant(14);
  w.variant(n.kind);
  w.string(n.title);
  w.option(n.body, (v) => w.string(v));
  w.option(n.sound, (v) => w.variant(v));
  w.option(n.agent, (v) => w.string(v));
  w.option(n.workspaceId, (v) => w.string(v));
  w.option(n.tabId, (v) => w.string(v));
  w.option(n.paneId, (v) => w.string(v));
  w.option(n.position, (v) => w.variant(v));
  return encodeFrame(w.toBuffer());
}

describe("SemanticNotification (tag 14)", () => {
  test("a notifications client sends a passive hello without surface codecs", async () => {
    const hello = Promise.withResolvers<any>();
    const socketPath = await startEndpointServer((value) =>
      hello.resolve(value),
    );
    const client = new EndpointClient(socketPath, true, "notifications");
    try {
      await client.connect(80, 24);
      const sent = await hello.promise;
      expect(sent.surface_active).toBe(false);
      expect(sent.surface_delta).toBe(false);
      expect(sent.surface_reuse).toBe(false);
    } finally {
      client.close();
    }
  });

  test.each([
    [
      "agent transition",
      {
        kind: 1,
        title: "claude finished",
        body: "cvision · tab 2",
        sound: 0,
        agent: "claude",
        workspaceId: "w1",
        tabId: "w1:t2",
        paneId: "w1:p3",
      },
      {
        kind: "finished",
        title: "claude finished",
        body: "cvision · tab 2",
        sound: "done",
        agent: "claude",
        workspaceId: "w1",
        tabId: "w1:t2",
        paneId: "w1:p3",
      },
    ],
    [
      "notification.show custom alert",
      { kind: 3, title: "codex needs input", sound: 1, position: 3 },
      {
        kind: "custom",
        title: "codex needs input",
        body: null,
        sound: "request",
        agent: null,
        workspaceId: null,
        tabId: null,
        paneId: null,
      },
    ],
    [
      "needs attention without sound",
      { kind: 0, title: "pi needs attention", paneId: "w2:p1" },
      {
        kind: "needs_attention",
        title: "pi needs attention",
        body: null,
        sound: null,
        agent: null,
        workspaceId: null,
        tabId: null,
        paneId: "w2:p1",
      },
    ],
  ])("decodes %s", async (_name, fixture, expected) => {
    const socketPath = await startEndpointServer((_hello, socket) =>
      socket.write(semanticNotificationFrame(fixture as SemanticFixture)),
    );
    const client = new EndpointClient(socketPath, false, "notifications");
    const received = new Promise((resolve) =>
      client.once("semantic_notification", resolve),
    );
    try {
      await client.connect(80, 24);
      expect(await received).toEqual(expected);
    } finally {
      client.close();
    }
  });

  test("terminal clients ignore notifications so open views do not multiply them", async () => {
    const socketPath = await startEndpointServer((_hello, socket) =>
      socket.write(semanticNotificationFrame({ kind: 1, title: "done" })),
    );
    const client = new EndpointClient(socketPath);
    const received: unknown[] = [];
    client.on("semantic_notification", (value) => received.push(value));
    try {
      await client.connect(80, 24);
      await Bun.sleep(20);
      expect(received).toEqual([]);
      expect(client.isClosed).toBe(false);
    } finally {
      client.close();
    }
  });

  test("a malformed notification is reported without closing the shell", async () => {
    const socketPath = await startEndpointServer((_hello, socket) => {
      socket.write(semanticNotificationFrame({ kind: 9, title: "future" }));
      socket.write(
        encodeFrame(Buffer.from([14, 1, 10, 0x61])), // truncated title
      );
      socket.write(semanticNotificationFrame({ kind: 1, title: "ok" }));
    });
    const client = new EndpointClient(socketPath, false, "notifications");
    const errors: Error[] = [];
    client.on("notification_error", (error) => errors.push(error));
    const received = new Promise<any>((resolve) =>
      client.once("semantic_notification", resolve),
    );
    try {
      await client.connect(80, 24);
      expect((await received).title).toBe("ok");
      expect(errors.map((error) => error.message)).toEqual([
        "unknown semantic notification kind",
        expect.stringContaining("short read"),
      ]);
      expect(client.isClosed).toBe(false);
    } finally {
      client.close();
    }
  });

  test("clips oversized titles and bodies", async () => {
    const socketPath = await startEndpointServer((_hello, socket) =>
      socket.write(
        semanticNotificationFrame({
          kind: 3,
          title: "t".repeat(1000),
          body: "b".repeat(1000),
        }),
      ),
    );
    const client = new EndpointClient(socketPath, false, "notifications");
    const received = new Promise<any>((resolve) =>
      client.once("semantic_notification", resolve),
    );
    try {
      await client.connect(80, 24);
      const notification = await received;
      expect(notification.title).toHaveLength(200);
      expect(notification.body).toHaveLength(400);
    } finally {
      client.close();
    }
  });
});

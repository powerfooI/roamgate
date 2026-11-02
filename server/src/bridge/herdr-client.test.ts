import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../utils/logger";
import { HERDR_MAX_REQUEST_BYTES, HerdrClient } from "./herdr-client";

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

async function startServer(
  onData?: (socket: net.Socket, data: Buffer) => void,
) {
  const socketPath = join(
    tmpdir(),
    `herdr-gui-herdr-client-${process.pid}-${crypto.randomUUID()}.sock`,
  );
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    if (onData) {
      socket.once("data", (data) =>
        onData(socket, Buffer.isBuffer(data) ? data : Buffer.from(data)),
      );
    }
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return socketPath;
}

/** A server that answers each request line with the length of its text. */
async function startLineServer() {
  const socketPath = join(
    tmpdir(),
    `herdr-gui-herdr-client-${process.pid}-${crypto.randomUUID()}.sock`,
  );
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let received = "";
    socket.on("data", (data) => {
      received += data.toString("utf8");
      const end = received.indexOf("\n");
      if (end < 0) return;
      const request = JSON.parse(received.slice(0, end));
      socket.end(
        `${JSON.stringify({ id: request.id, result: { length: request.params.text.length } })}\n`,
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return socketPath;
}

/**
 * Sends pane.send_input with a text sized so the request line, without its
 * newline, is exactly `lineBytes` long.
 */
function sizedSendInput(client: HerdrClient, lineBytes: number) {
  const now = spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  const random = spyOn(Math, "random").mockReturnValue(0.5);
  try {
    const id = `r_${Date.now().toString(36)}_${(0.5).toString(36).slice(2, 6)}`;
    const empty = JSON.stringify({
      id,
      method: "pane.send_input",
      params: { text: "" },
    });
    const text = "x".repeat(lineBytes - Buffer.byteLength(empty));
    return { pending: client.call("pane.send_input", { text }), text };
  } finally {
    now.mockRestore();
    random.mockRestore();
  }
}

for (const [transport, useBunSocket] of [
  ["Bun.connect", true],
  ["node:net", false],
] as const) {
  describe(`HerdrClient one-shot lifecycle over ${transport}`, () => {
    const oneShot = (socketPath: string) =>
      new HerdrClient(socketPath, { useBunSocket });

    test("rechecks authorization after socket connection and sends no revoked request", async () => {
      let received = false;
      let checked = false;
      let allowed = true;
      const closed = Promise.withResolvers<void>();
      const client = oneShot(
        await startServer(() => {
          received = true;
        }),
      );
      servers
        .at(-1)!
        .once("connection", (socket) => socket.once("close", closed.resolve));
      const pending = client.call("workspace.create", {}, 8000, () => {
        checked = true;
        if (!allowed) throw new Error("Approval revoked");
      });
      allowed = false;
      await expect(pending).rejects.toThrow("Approval revoked");
      await closed.promise;
      expect(checked).toBe(true);
      expect(received).toBe(false);
    });

    test("rejects mismatched and malformed one-shot response envelopes", async () => {
      const wrongId = oneShot(
        await startServer((socket) => {
          socket.end(`${JSON.stringify({ id: "wrong", result: {} })}\n`);
        }),
      );
      await expect(wrongId.call("ping")).rejects.toThrow(
        "invalid response envelope",
      );

      const mixedEnvelope = oneShot(
        await startServer((socket, data) => {
          const request = JSON.parse(data.toString("utf8"));
          socket.end(
            `${JSON.stringify({ id: request.id, result: {}, error: {} })}\n`,
          );
        }),
      );
      await expect(mixedEnvelope.call("ping")).rejects.toThrow(
        "invalid response envelope",
      );
    });

    test("sends a request too large for one socket write", async () => {
      // Larger than a unix socket buffer, so one write cannot take it all.
      const text = "long message ".repeat(70_000);
      const result = await oneShot(await startLineServer()).call(
        "pane.send_input",
        { text },
      );
      expect(result).toEqual({ length: text.length });
    });

    test("sends a request line of exactly Herdr's 1 MiB", async () => {
      const client = oneShot(await startLineServer());
      const { pending, text } = sizedSendInput(client, HERDR_MAX_REQUEST_BYTES);
      expect(await pending).toEqual({ length: text.length });
    });

    test("refuses a request line one byte over Herdr's 1 MiB, at once", async () => {
      let connected = false;
      const client = oneShot(
        await startServer(() => {
          connected = true;
        }),
      );
      jest.useFakeTimers();
      try {
        const { pending } = sizedSendInput(client, HERDR_MAX_REQUEST_BYTES + 1);
        // Rejects without the clock moving: no timeout is left armed.
        await expect(pending).rejects.toThrow(
          "pane.send_input: too large for Herdr (1025 KiB, at most 1024)",
        );
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
      expect(connected).toBe(false);
    });

    test("bounds a one-shot response without a newline", async () => {
      const client = oneShot(
        await startServer((socket) => {
          socket.write("x".repeat(1024 * 1024 + 1));
        }),
      );

      await expect(client.call("ping")).rejects.toThrow(
        "response line is too large",
      );
    });

    test("destroys a half-open socket when a call times out", async () => {
      let resolveClosed!: () => void;
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      const client = oneShot(
        await startServer((socket) => {
          socket.once("close", () => resolveClosed());
        }),
      );

      await expect(client.call("ping", {}, 25)).rejects.toThrow(
        "timeout: ping",
      );
      await expect(
        Promise.race([
          closed,
          Bun.sleep(500).then(() => {
            throw new Error("server did not observe client closure");
          }),
        ]),
      ).resolves.toBeUndefined();
    });
  });
}

describe("HerdrClient subscription lifecycle", () => {
  test("close before acknowledgement rejects ready and resolves closed", async () => {
    const client = new HerdrClient(await startServer());
    client.on("error", () => undefined);
    const subscription = client.subscribe(["pane.updated"]);

    subscription.close();
    subscription.close();

    await expect(subscription.ready).rejects.toThrow(
      "subscription closed before acknowledgement",
    );
    await expect(subscription.closed).resolves.toBeUndefined();
  });

  test("rejects a mismatched acknowledgement and an acknowledgement timeout", async () => {
    const mismatched = new HerdrClient(
      await startServer((socket) => {
        socket.write(`${JSON.stringify({ id: "wrong", result: {} })}\n`);
      }),
    );
    mismatched.on("error", () => undefined);
    const invalidSubscription = mismatched.subscribe(["pane.updated"]);
    await expect(invalidSubscription.ready).rejects.toThrow(
      "invalid subscription acknowledgement",
    );
    await expect(invalidSubscription.closed).resolves.toBeUndefined();

    const silent = new HerdrClient(await startServer());
    silent.on("error", () => undefined);
    const timedOutSubscription = silent.subscribe(["pane.updated"], 10);
    await expect(timedOutSubscription.ready).rejects.toThrow(
      "acknowledgement timed out",
    );
    await expect(timedOutSubscription.closed).resolves.toBeUndefined();
  });

  test("close forcefully resolves closed after acknowledgement", async () => {
    const client = new HerdrClient(
      await startServer((socket) => {
        socket.write(`${JSON.stringify({ id: "sub", result: {} })}\n`);
      }),
    );
    client.on("error", () => undefined);
    const subscription = client.subscribe(["pane.updated"]);

    await expect(subscription.ready).resolves.toBeUndefined();
    subscription.close();
    subscription.close();

    await expect(subscription.closed).resolves.toBeUndefined();
  });
});

describe("HerdrClient debug timing", () => {
  test("logs method, sizes and round-trip timings for each call", async () => {
    const lines: string[] = [];
    const client = new HerdrClient(
      await startServer((socket, data) => {
        const { id } = JSON.parse(data.toString("utf8"));
        socket.end(`${JSON.stringify({ id, result: { ok: true } })}\n`);
      }),
      {
        logger: createLogger({
          level: "debug",
          scope: "herdr",
          stdout: (line) => lines.push(line),
        }),
        connectionId: "conn_1",
      },
    );

    await expect(
      client.call("pane.list", { workspace: "w1" }),
    ).resolves.toEqual({ ok: true });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /DEBUG herdr herdr call connection=conn_1 method=pane\.list status=ok req_bytes=\d+ resp_bytes=\d+ total_ms=\d+ connect_ms=\d+ first_byte_ms=\d+$/,
    );
  });

  test("logs failures without a first byte", async () => {
    const lines: string[] = [];
    const client = new HerdrClient(
      await startServer((socket) => socket.destroy()),
      {
        logger: createLogger({
          level: "debug",
          stdout: (line) => lines.push(line),
        }),
      },
    );

    await expect(client.call("ping")).rejects.toThrow();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("method=ping status=error");
    expect(lines[0]).not.toContain("first_byte_ms=");
    expect(lines[0]).toContain("error=");
  });
});

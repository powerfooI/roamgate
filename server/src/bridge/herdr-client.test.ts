import { afterEach, describe, expect, test } from "bun:test";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrClient } from "./herdr-client";

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

describe("HerdrClient one-shot lifecycle", () => {
  test("rechecks authorization after socket connection and sends no revoked request", async () => {
    let received = false;
    let checked = false;
    let allowed = true;
    const closed = Promise.withResolvers<void>();
    const client = new HerdrClient(
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
    const wrongId = new HerdrClient(
      await startServer((socket) => {
        socket.end(`${JSON.stringify({ id: "wrong", result: {} })}\n`);
      }),
    );
    await expect(wrongId.call("ping")).rejects.toThrow(
      "invalid response envelope",
    );

    const mixedEnvelope = new HerdrClient(
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

  test("bounds a one-shot response without a newline", async () => {
    const client = new HerdrClient(
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
    const client = new HerdrClient(
      await startServer((socket) => {
        socket.once("close", () => resolveClosed());
      }),
    );

    await expect(client.call("ping", {}, 25)).rejects.toThrow("timeout: ping");
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

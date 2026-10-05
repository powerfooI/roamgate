import { EventEmitter } from "node:events";
import * as net from "node:net";

const MAX_NDJSON_LINE_BYTES = 1024 * 1024;
const SUBSCRIPTION_ACK_TIMEOUT_MS = 8000;

/** Subscription selector: a bare event type or a parameterized subscription. */
export type HerdrSubscription =
  | string
  | { type: string; [key: string]: unknown };

/**
 * Minimal NDJSON client for the Herdr local socket.
 *
 * Herdr's wire model (confirmed against a running 0.7.0 server):
 *
 *   - **RPC is one-request-per-connection.** The server reads a single
 *     request line, writes a single response line, then closes the socket.
 *     So every `call()` opens a fresh connection.
 *   - **Subscriptions are long-lived.** `events.subscribe` keeps its
 *     connection open after the ack and pushes events as subsequent lines
 *     of the shape `{ event: "<name>", data: { ... } }`.
 */
export class HerdrClient extends EventEmitter {
  constructor(private socketPath: string) {
    super();
  }

  /** One-shot RPC: open -> send one request -> read one response -> close. */
  call(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 8000,
    beforeSend?: () => void,
  ): Promise<any> {
    const requestId = `r_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ path: this.socketPath });
      let buf = "";
      let done = false;

      const timer = setTimeout(
        () => finish(new Error(`timeout: ${method}`)),
        timeoutMs,
      );

      function finish(err?: Error, val?: any) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          // One-shot RPCs never reuse the socket. Force closure so a peer that
          // keeps its readable side half-open cannot retain our descriptor
          // after a timeout or malformed response.
          s.destroy();
        } catch {
          /* already closed */
        }
        if (err) reject(err);
        else resolve(val);
      }

      s.on("error", (e) =>
        finish(new Error(`${(e as any).code ?? "error"}: ${e.message}`)),
      );
      s.on("connect", () => {
        if (done) return;
        try {
          beforeSend?.();
          s.write(JSON.stringify({ id: requestId, method, params }) + "\n");
        } catch (error) {
          finish(
            error instanceof Error ? error : new Error("RPC dispatch rejected"),
          );
        }
      });
      s.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const i = buf.indexOf("\n");
        if (i === -1) {
          if (Buffer.byteLength(buf) > MAX_NDJSON_LINE_BYTES) {
            finish(new Error("Herdr response line is too large"));
          }
          return;
        }
        const line = buf.slice(0, i).trim();
        if (Buffer.byteLength(line) > MAX_NDJSON_LINE_BYTES) {
          return finish(new Error("Herdr response line is too large"));
        }
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          return finish(new Error("bad JSON from Herdr"));
        }
        if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
          return finish(new Error("invalid response envelope from Herdr"));
        }
        const envelope = msg as Record<string, unknown>;
        const hasResult = Object.hasOwn(envelope, "result");
        const hasError = Object.hasOwn(envelope, "error");
        if (
          envelope.id !== requestId ||
          hasResult === hasError ||
          (hasError &&
            (!envelope.error ||
              typeof envelope.error !== "object" ||
              Array.isArray(envelope.error)))
        ) {
          return finish(new Error("invalid response envelope from Herdr"));
        }
        if (hasError) {
          const error = envelope.error as Record<string, unknown>;
          const code = typeof error.code === "string" ? error.code : "error";
          const message =
            typeof error.message === "string"
              ? error.message
              : "Herdr request failed";
          finish(new Error(`${code}: ${message}`));
        } else {
          finish(undefined, envelope.result);
        }
      });
      s.on("close", () => {
        if (!done) {
          finish(new Error(`connection closed before response: ${method}`));
        }
      });
    });
  }

  /**
   * Long-lived event subscription. Returns a `close` handle and a `ready`
   * promise that resolves once the subscription is acknowledged.
   */
  subscribe(
    types: HerdrSubscription[],
    ackTimeoutMs = SUBSCRIPTION_ACK_TIMEOUT_MS,
  ): {
    close: () => void;
    ready: Promise<void>;
    closed: Promise<void>;
  } {
    const s = net.createConnection({ path: this.socketPath });
    let buf = "";
    let acked = false;
    let readySettled = false;
    let closeRequested = false;
    let readyResolve!: () => void;
    let readyReject!: (e: Error) => void;
    let closedResolve!: () => void;
    const ready = new Promise<void>((res, rej) => {
      readyResolve = res;
      readyReject = rej;
    });
    const ackTimer = setTimeout(
      () => {
        if (readySettled) return;
        readySettled = true;
        readyReject(new Error("subscription acknowledgement timed out"));
        s.destroy();
      },
      Math.max(1, ackTimeoutMs),
    );
    const resolveReady = () => {
      if (readySettled) return;
      readySettled = true;
      clearTimeout(ackTimer);
      readyResolve();
    };
    const rejectReady = (error: Error) => {
      if (readySettled) return;
      readySettled = true;
      clearTimeout(ackTimer);
      readyReject(error);
    };
    const closed = new Promise<void>((resolve) => {
      closedResolve = resolve;
    });

    s.on("error", (e) => {
      this.emit("error", e);
      if (!acked) rejectReady(e);
    });
    s.on("connect", () => {
      s.write(
        JSON.stringify({
          id: "sub",
          method: "events.subscribe",
          params: {
            subscriptions: types.map((t) =>
              typeof t === "string" ? { type: t } : t,
            ),
          },
        }) + "\n",
      );
    });
    s.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        if (Buffer.byteLength(line) > MAX_NDJSON_LINE_BYTES) {
          rejectReady(new Error("Herdr subscription line is too large"));
          s.destroy();
          return;
        }
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          if (!acked) {
            rejectReady(new Error("bad subscription JSON from Herdr"));
            s.destroy();
            return;
          }
          continue;
        }
        if (!acked) {
          if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
            rejectReady(new Error("invalid subscription acknowledgement"));
            s.destroy();
            return;
          }
          const envelope = msg as Record<string, unknown>;
          const hasResult = Object.hasOwn(envelope, "result");
          const hasError = Object.hasOwn(envelope, "error");
          if (envelope.id !== "sub" || hasResult === hasError) {
            rejectReady(new Error("invalid subscription acknowledgement"));
            s.destroy();
            return;
          }
          acked = true;
          if (hasError) {
            const error = envelope.error;
            const message =
              error &&
              typeof error === "object" &&
              !Array.isArray(error) &&
              typeof (error as { message?: unknown }).message === "string"
                ? (error as { message: string }).message
                : "subscribe failed";
            rejectReady(new Error(message));
            s.destroy();
          } else {
            resolveReady();
          }
          continue;
        }
        if (
          msg &&
          typeof msg === "object" &&
          !Array.isArray(msg) &&
          typeof (msg as { event?: unknown }).event === "string"
        ) {
          this.emit("event", msg);
        }
      }
      if (Buffer.byteLength(buf) > MAX_NDJSON_LINE_BYTES) {
        rejectReady(new Error("Herdr subscription line is too large"));
        s.destroy();
      }
    });
    s.on("close", () => {
      if (!acked) {
        rejectReady(new Error("subscription closed before acknowledgement"));
      }
      clearTimeout(ackTimer);
      closedResolve();
      this.emit("subscription_closed");
    });

    const close = () => {
      if (closeRequested) return;
      closeRequested = true;
      s.destroy();
    };

    return { close, ready, closed };
  }

  ping(): Promise<any> {
    return this.call("ping");
  }
}

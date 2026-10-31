import { expect, test } from "bun:test";
import { Bridge } from "./api";

test("the shortcut sync client can read settings with the current protocol", async () => {
  const priorSocket = globalThis.WebSocket;
  const priorLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  class Socket {
    static OPEN = 1;
    static instance: Socket;
    readyState = 1;
    bufferedAmount = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror = null;
    constructor() {
      Socket.instance = this;
      queueMicrotask(() => this.onopen?.());
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
    send(raw: string) {
      const request = JSON.parse(raw);
      expect(request.connection_id).toBeUndefined();
      expect(request.connection_generation).toBeUndefined();
      queueMicrotask(() =>
        this.onmessage?.({
          data: JSON.stringify({
            id: request.id,
            result: { ui: {} },
          }),
        } as MessageEvent),
      );
    }
  }
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { protocol: "http:", host: "localhost:5173" },
  });
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const bridge = new Bridge(1000, 1000);
  try {
    bridge.connect();
    await Promise.resolve();
    Socket.instance.onmessage?.({
      data: JSON.stringify({
        hello: true,
        bridge_protocol_version: 2,
        default_connection_id: "alpha",
        capabilities: { connection_runtime_generation: true },
      }),
    } as MessageEvent);
    await expect(bridge.call("bridge.ui_settings.get")).resolves.toEqual({
      ui: {},
    });
  } finally {
    bridge.disconnect();
    globalThis.WebSocket = priorSocket;
    if (priorLocation)
      Object.defineProperty(globalThis, "location", priorLocation);
    else Reflect.deleteProperty(globalThis, "location");
  }
});

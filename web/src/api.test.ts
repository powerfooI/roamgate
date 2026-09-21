import { afterEach, describe, expect, test } from "bun:test";
import {
  Bridge,
  type ConnectionStatus,
  logoutBrowserSession,
  parseConnectionSummary,
} from "./api";

const originalWebSocket = globalThis.WebSocket;
const originalFetch = globalThis.fetch;
const originalLocation = Object.getOwnPropertyDescriptor(
  globalThis,
  "location",
);
const testBridges: Bridge[] = [];

class HangingWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = HangingWebSocket.CONNECTING;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event?: Pick<CloseEvent, "code">) => void) | null = null;

  close() {
    this.readyState = HangingWebSocket.CLOSED;
    this.onclose?.();
  }

  send() {}
}

function installBrowserGlobals(webSocket: typeof WebSocket) {
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { protocol: "http:", host: "localhost:5173" },
  });
  globalThis.WebSocket = webSocket;
}

function createTestBridge(connectTimeoutMs = 5, reconnectDelayMs = 1000) {
  const bridge = new Bridge(connectTimeoutMs, reconnectDelayMs);
  testBridges.push(bridge);
  return bridge;
}

function sendHello(
  socket: HangingWebSocket,
  defaultConnectionId = "legacy-default",
) {
  socket.onmessage?.({
    data: JSON.stringify({
      hello: true,
      bridge_protocol_version: 2,
      default_connection_id: defaultConnectionId,
      capabilities: { connection_id: true, connection_scoped_http: true },
    }),
  } as MessageEvent);
}

afterEach(() => {
  testBridges.splice(0).forEach((bridge) => bridge.disconnect());
  globalThis.WebSocket = originalWebSocket;
  globalThis.fetch = originalFetch;
  if (originalLocation) {
    Object.defineProperty(globalThis, "location", originalLocation);
  } else {
    Reflect.deleteProperty(globalThis, "location");
  }
});

describe("browser logout", () => {
  test.each([204, 500])(
    "only redirects after cookie removal succeeds (%s)",
    async (status) => {
      let destination = "";
      Object.defineProperty(globalThis, "location", {
        configurable: true,
        value: {
          replace(value: string) {
            destination = value;
          },
        },
      });
      const response = Promise.withResolvers<Response>();
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        value: (url: string, init: RequestInit) => {
          expect(url).toBe("/api/logout");
          expect(init).toMatchObject({
            method: "POST",
            credentials: "same-origin",
            headers: { "x-roamgate-logout": "1" },
          });
          return response.promise;
        },
      });
      const logout = logoutBrowserSession();
      expect(destination).toBe("");
      response.resolve(new Response(null, { status }));
      if (status === 204) {
        await logout;
        expect(destination).toBe("/login");
      } else {
        await expect(logout).rejects.toThrow("Could not log out");
        expect(destination).toBe("");
      }
    },
  );

  test("a logout close stops reconnection and clears the cookie before leaving another tab", async () => {
    class LogoutSocket extends HangingWebSocket {
      static instance: LogoutSocket;
      constructor() {
        super();
        LogoutSocket.instance = this;
      }
    }
    installBrowserGlobals(LogoutSocket as unknown as typeof WebSocket);
    const navigated = Promise.withResolvers<string>();
    Object.assign(location, { replace: navigated.resolve });
    const response = Promise.withResolvers<Response>();
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: () => response.promise,
    });
    const bridge = createTestBridge(1000);
    bridge.connect();
    const socket = LogoutSocket.instance;
    socket.readyState = WebSocket.OPEN;
    sendHello(socket);
    socket.readyState = WebSocket.CLOSED;
    socket.onclose?.({ code: 4001 });
    expect(bridge.status).toBe("disconnected");
    expect(
      (bridge as unknown as { reconnectEnabled: boolean }).reconnectEnabled,
    ).toBe(false);
    response.resolve(new Response(null, { status: 204 }));
    expect(await navigated.promise).toBe("/login");
  });
});

describe("bridge connection lifecycle", () => {
  test("marks the bridge connected only after a valid hello", async () => {
    class OpeningWebSocket extends HangingWebSocket {
      static instance: OpeningWebSocket;

      constructor() {
        super();
        OpeningWebSocket.instance = this;
        queueMicrotask(() => {
          this.readyState = OpeningWebSocket.OPEN;
          this.onopen?.();
        });
      }
    }
    installBrowserGlobals(OpeningWebSocket as unknown as typeof WebSocket);
    const bridge = createTestBridge(50);

    bridge.connect();
    await Bun.sleep(1);
    expect(bridge.status).toBe("connecting");

    sendHello(OpeningWebSocket.instance);
    expect(bridge.status).toBe("connected");
    await Bun.sleep(60);
    expect(bridge.status).toBe("connected");
  });

  test("rejects an open socket that never sends a valid hello", async () => {
    class SilentWebSocket extends HangingWebSocket {
      constructor() {
        super();
        queueMicrotask(() => {
          this.readyState = SilentWebSocket.OPEN;
          this.onopen?.();
        });
      }
    }
    installBrowserGlobals(SilentWebSocket as unknown as typeof WebSocket);
    const bridge = createTestBridge(5, 1000);

    bridge.connect();
    await Bun.sleep(15);

    expect(bridge.status).toBe("disconnected");
  });

  test("ignores a hello with malformed known capabilities", async () => {
    class ManualWebSocket extends HangingWebSocket {
      static instance: ManualWebSocket;

      constructor() {
        super();
        ManualWebSocket.instance = this;
        queueMicrotask(() => {
          this.readyState = ManualWebSocket.OPEN;
          this.onopen?.();
        });
      }
    }
    installBrowserGlobals(ManualWebSocket as unknown as typeof WebSocket);
    const bridge = createTestBridge(50);
    bridge.connect();
    await Bun.sleep(1);

    ManualWebSocket.instance.onmessage?.({
      data: JSON.stringify({
        hello: true,
        bridge_protocol_version: 2,
        default_connection_id: "alpha",
        capabilities: { connection_id: "yes" },
      }),
    } as MessageEvent);
    expect(bridge.status).toBe("connecting");

    sendHello(ManualWebSocket.instance, "alpha");
    expect(bridge.status).toBe("connected");
  });

  test("leaves connecting state when the WebSocket handshake hangs", async () => {
    installBrowserGlobals(HangingWebSocket as unknown as typeof WebSocket);
    const bridge = createTestBridge();
    const statuses: ConnectionStatus[] = [];
    bridge.onStatus((status) => statuses.push(status));

    bridge.connect();
    await Bun.sleep(15);

    expect(statuses).toEqual(["disconnected", "connecting", "disconnected"]);
    expect(bridge.status).toBe("disconnected");
  });

  test("retries after a timed-out WebSocket handshake", async () => {
    class RecoveringWebSocket extends HangingWebSocket {
      static instances = 0;

      constructor() {
        super();
        RecoveringWebSocket.instances += 1;
        if (RecoveringWebSocket.instances === 2) {
          queueMicrotask(() => {
            this.readyState = RecoveringWebSocket.OPEN;
            this.onopen?.();
            sendHello(this);
          });
        }
      }
    }
    installBrowserGlobals(RecoveringWebSocket as unknown as typeof WebSocket);
    const bridge = createTestBridge(5, 1);
    const connected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for reconnect")),
        100,
      );
      bridge.onStatus((status) => {
        if (status !== "connected") return;
        clearTimeout(timer);
        resolve();
      });
    });

    bridge.connect();
    await connected;

    expect(RecoveringWebSocket.instances).toBe(2);
    expect(bridge.status).toBe("connected");
  });

  test("recovers when opening the WebSocket throws synchronously", () => {
    class ThrowingWebSocket {
      constructor() {
        throw new Error("blocked");
      }
    }
    installBrowserGlobals(ThrowingWebSocket as unknown as typeof WebSocket);
    const bridge = createTestBridge();
    const statuses: ConnectionStatus[] = [];
    bridge.onStatus((status) => statuses.push(status));

    bridge.connect();

    expect(statuses).toEqual(["disconnected", "connecting", "disconnected"]);
    expect(bridge.status).toBe("disconnected");
  });

  test("allows a long-running RPC to rely on connection lifetime", async () => {
    class ManualWebSocket extends HangingWebSocket {
      static instance: ManualWebSocket;
      sent: string[] = [];

      constructor() {
        super();
        ManualWebSocket.instance = this;
        queueMicrotask(() => {
          this.readyState = ManualWebSocket.OPEN;
          this.onopen?.();
        });
      }

      send(raw = "") {
        this.sent.push(raw);
      }
    }
    installBrowserGlobals(ManualWebSocket as unknown as typeof WebSocket);
    const bridge = createTestBridge();
    bridge.connect();
    await Bun.sleep(1);
    sendHello(ManualWebSocket.instance);

    const response = bridge.call(
      "worktree.remove",
      { workspace_id: "w1" },
      null,
    );
    const request = JSON.parse(ManualWebSocket.instance.sent[0]);
    await Bun.sleep(5);
    ManualWebSocket.instance.onmessage?.({
      data: JSON.stringify({
        connection_id: "legacy-default",
        id: request.id,
        result: { ok: true },
      }),
    } as MessageEvent);

    await expect(response).resolves.toEqual({ ok: true });
  });

  test("dispatches terminal clipboard pushes and removes listeners", async () => {
    class ManualWebSocket extends HangingWebSocket {
      static instance: ManualWebSocket;

      constructor() {
        super();
        ManualWebSocket.instance = this;
        queueMicrotask(() => {
          this.readyState = ManualWebSocket.OPEN;
          this.onopen?.();
        });
      }
    }
    installBrowserGlobals(ManualWebSocket as unknown as typeof WebSocket);
    const bridge = createTestBridge();
    const received: Array<{
      connection_id: string;
      terminal_id: string;
      data: string;
    }> = [];
    const remove = bridge.onTerminalClipboard((clipboard) =>
      received.push(clipboard),
    );
    bridge.connect();
    await Bun.sleep(1);
    sendHello(ManualWebSocket.instance);

    const push = { terminal_id: "term_1", data: "Y29weQ==" };
    ManualWebSocket.instance.onmessage?.({
      data: JSON.stringify({
        connection_id: "legacy-default",
        terminal_clipboard: push,
      }),
    } as MessageEvent);
    remove();
    ManualWebSocket.instance.onmessage?.({
      data: JSON.stringify({
        connection_id: "legacy-default",
        terminal_clipboard: push,
      }),
    } as MessageEvent);

    expect(received).toEqual([{ connection_id: "legacy-default", ...push }]);
  });

  test("dispatches agent status events that omit data.type", async () => {
    class ManualWebSocket extends HangingWebSocket {
      static instance: ManualWebSocket;

      constructor() {
        super();
        ManualWebSocket.instance = this;
        queueMicrotask(() => {
          this.readyState = ManualWebSocket.OPEN;
          this.onopen?.();
        });
      }
    }
    installBrowserGlobals(ManualWebSocket as unknown as typeof WebSocket);
    const bridge = createTestBridge();
    const events: unknown[] = [];
    bridge.onEvent((event) => events.push(event));
    bridge.connect();
    await Bun.sleep(1);
    sendHello(ManualWebSocket.instance);

    const statusEvent = {
      event: "pane.agent_status_changed",
      data: {
        pane_id: "w1:p1",
        workspace_id: "w1",
        agent_status: "working",
        agent: "pi",
      },
    };
    ManualWebSocket.instance.onmessage?.({
      data: JSON.stringify({
        connection_id: "legacy-default",
        ...statusEvent,
      }),
    } as MessageEvent);

    expect(events).toEqual([
      { connection_id: "legacy-default", ...statusEvent },
    ]);
  });

  test("routes terminal_closed pushes to closed listeners", async () => {
    class ManualWebSocket extends HangingWebSocket {
      static instance: ManualWebSocket;

      constructor() {
        super();
        ManualWebSocket.instance = this;
        queueMicrotask(() => {
          this.readyState = ManualWebSocket.OPEN;
          this.onopen?.();
        });
      }
    }
    installBrowserGlobals(ManualWebSocket as unknown as typeof WebSocket);
    const bridge = createTestBridge();
    const closed: unknown[] = [];
    const terminals: unknown[] = [];
    bridge.onTerminalClosed((push) => closed.push(push));
    bridge.onTerminal((terminal) => terminals.push(terminal));
    bridge.connect();
    await Bun.sleep(1);
    sendHello(ManualWebSocket.instance);

    ManualWebSocket.instance.onmessage?.({
      data: JSON.stringify({
        connection_id: "legacy-default",
        terminal_closed: { terminal_id: "term_1", reason: "stream_closed" },
      }),
    } as MessageEvent);

    expect(closed).toEqual([
      {
        connection_id: "legacy-default",
        terminal_id: "term_1",
        reason: "stream_closed",
      },
    ]);
    expect(terminals).toEqual([]);
  });

  test("keeps event and terminal listeners compatible with scoped pushes", async () => {
    class ManualWebSocket extends HangingWebSocket {
      static instance: ManualWebSocket;

      constructor() {
        super();
        ManualWebSocket.instance = this;
        queueMicrotask(() => {
          this.readyState = ManualWebSocket.OPEN;
          this.onopen?.();
        });
      }
    }
    installBrowserGlobals(ManualWebSocket as unknown as typeof WebSocket);
    const bridge = createTestBridge();
    const events: unknown[] = [];
    const terminals: unknown[] = [];
    bridge.onEvent((event) => events.push(event));
    bridge.onTerminal((terminal) => terminals.push(terminal));
    bridge.connect();
    await Bun.sleep(1);
    sendHello(ManualWebSocket.instance);

    const event = {
      event: "workspace.updated",
      data: { type: "workspace", workspace_id: "same" },
    };
    const terminal = {
      terminal_id: "same",
      width: 80,
      height: 24,
      full: true,
      bytes: "",
    };
    ManualWebSocket.instance.onmessage?.({
      data: JSON.stringify({ connection_id: "legacy-default", ...event }),
    } as MessageEvent);
    ManualWebSocket.instance.onmessage?.({
      data: JSON.stringify({ connection_id: "legacy-default", terminal }),
    } as MessageEvent);

    expect(events).toEqual([
      {
        connection_id: "legacy-default",
        ...event,
      },
    ]);
    expect(terminals).toEqual([
      { connection_id: "legacy-default", ...terminal },
    ]);
  });

  test("sends explicit identity for downstream calls and none for global calls", async () => {
    class ManualWebSocket extends HangingWebSocket {
      static instance: ManualWebSocket;
      sent: string[] = [];

      constructor() {
        super();
        ManualWebSocket.instance = this;
        queueMicrotask(() => {
          this.readyState = ManualWebSocket.OPEN;
          this.onopen?.();
        });
      }

      send(raw = "") {
        this.sent.push(raw);
      }
    }
    installBrowserGlobals(ManualWebSocket as unknown as typeof WebSocket);
    const bridge = createTestBridge();
    bridge.connect();
    await Bun.sleep(1);
    sendHello(ManualWebSocket.instance);
    bridge.setActiveConnection("alpha");

    const downstream = bridge.call("workspace.list");
    const global = bridge.call("connections.list");
    const [downstreamRequest, globalRequest] =
      ManualWebSocket.instance.sent.map((raw) => JSON.parse(raw));

    expect(downstreamRequest.connection_id).toBe("alpha");
    expect(globalRequest).not.toHaveProperty("connection_id");
    ManualWebSocket.instance.onmessage?.({
      data: JSON.stringify({
        id: downstreamRequest.id,
        connection_id: "alpha",
        result: { workspaces: [] },
      }),
    } as MessageEvent);
    ManualWebSocket.instance.onmessage?.({
      data: JSON.stringify({
        id: globalRequest.id,
        result: { connections: [] },
      }),
    } as MessageEvent);

    await expect(downstream).resolves.toEqual({ workspaces: [] });
    await expect(global).resolves.toEqual({ connections: [] });
  });

  test("binds scoped clients, replies, and pushes to server runtime generation", async () => {
    class ManualWebSocket extends HangingWebSocket {
      static instance: ManualWebSocket;
      sent: string[] = [];

      constructor() {
        super();
        ManualWebSocket.instance = this;
        queueMicrotask(() => {
          this.readyState = ManualWebSocket.OPEN;
          this.onopen?.();
        });
      }

      send(raw = "") {
        this.sent.push(raw);
      }
    }
    installBrowserGlobals(ManualWebSocket as unknown as typeof WebSocket);
    const bridge = createTestBridge();
    const events: unknown[] = [];
    const terminals: unknown[] = [];
    const clipboards: unknown[] = [];
    bridge.onEvent((event) => events.push(event));
    bridge.onTerminal((terminal) => terminals.push(terminal));
    bridge.onTerminalClipboard((clipboard) => clipboards.push(clipboard));
    bridge.connect();
    await Bun.sleep(1);
    bridge.setActiveConnection("alpha");
    const clientCreatedBeforeHello = bridge.connection("alpha", 7);
    await expect(
      clientCreatedBeforeHello.call("workspace.list"),
    ).rejects.toThrow("bridge hello is unavailable");
    ManualWebSocket.instance.onmessage?.({
      data: JSON.stringify({
        connection_id: "alpha",
        event: "workspace.updated",
        data: { type: "workspace" },
      }),
    } as MessageEvent);
    expect(events).toEqual([]);
    ManualWebSocket.instance.onmessage?.({
      data: JSON.stringify({
        hello: true,
        bridge_protocol_version: 2,
        default_connection_id: "alpha",
        capabilities: { connection_runtime_generation: true },
      }),
    } as MessageEvent);

    await expect(
      clientCreatedBeforeHello.call("workspace.list"),
    ).rejects.toThrow("connection runtime generation is unavailable");
    const uncataloged = bridge.connection("alpha", 7);
    await expect(uncataloged.call("workspace.list")).rejects.toThrow(
      "connection runtime generation is unavailable",
    );
    expect(ManualWebSocket.instance.sent).toEqual([]);
    ManualWebSocket.instance.onmessage?.({
      data: JSON.stringify({
        connection_id: "alpha",
        connection_generation: 7,
        event: "workspace.updated",
        data: { type: "workspace" },
      }),
    } as MessageEvent);
    expect(events).toEqual([]);
    bridge.setConnectionRuntimeGenerations([{ id: "alpha", generation: 7 }]);
    const client = bridge.connection("alpha", 7);
    const response = client.call("workspace.list");
    const request = JSON.parse(ManualWebSocket.instance.sent[0]);
    expect(request).toMatchObject({
      connection_id: "alpha",
      connection_generation: 7,
    });
    ManualWebSocket.instance.onmessage?.({
      data: JSON.stringify({
        id: request.id,
        connection_id: "alpha",
        connection_generation: 8,
        result: { workspaces: [] },
      }),
    } as MessageEvent);
    await expect(response).rejects.toThrow(
      "response connection_generation mismatch",
    );

    const compatibilityResponse = bridge.call("workspace.list");
    const compatibilityRequest = JSON.parse(ManualWebSocket.instance.sent[1]);
    expect(compatibilityRequest).toMatchObject({
      connection_id: "alpha",
      connection_generation: 7,
    });
    ManualWebSocket.instance.onmessage?.({
      data: JSON.stringify({
        id: compatibilityRequest.id,
        connection_id: "alpha",
        connection_generation: 7,
        result: { workspaces: [] },
      }),
    } as MessageEvent);
    await expect(compatibilityResponse).resolves.toEqual({ workspaces: [] });

    const push = (connectionGeneration: number | undefined) => {
      const identity = {
        connection_id: "alpha",
        ...(connectionGeneration === undefined
          ? {}
          : { connection_generation: connectionGeneration }),
      };
      ManualWebSocket.instance.onmessage?.({
        data: JSON.stringify({
          ...identity,
          event: "workspace.updated",
          data: { type: "workspace" },
        }),
      } as MessageEvent);
      ManualWebSocket.instance.onmessage?.({
        data: JSON.stringify({
          ...identity,
          terminal: {
            terminal_id: "same",
            width: 80,
            height: 24,
            full: true,
            bytes: "",
          },
        }),
      } as MessageEvent);
      ManualWebSocket.instance.onmessage?.({
        data: JSON.stringify({
          ...identity,
          terminal_clipboard: { terminal_id: "same", data: "YQ==" },
        }),
      } as MessageEvent);
    };
    push(undefined);
    push(6);
    push(7);
    expect(events).toEqual([
      expect.objectContaining({
        connection_id: "alpha",
        connection_generation: 7,
      }),
    ]);
    expect(terminals).toEqual([
      expect.objectContaining({
        connection_id: "alpha",
        connection_generation: 7,
        terminal_id: "same",
      }),
    ]);
    expect(clipboards).toEqual([
      expect.objectContaining({
        connection_id: "alpha",
        connection_generation: 7,
        terminal_id: "same",
      }),
    ]);
    expect(client.acceptsServerGeneration(6)).toBe(false);
    expect(client.acceptsServerGeneration(7)).toBe(true);
  });

  test("rejects mismatched scoped replies", async () => {
    class ManualWebSocket extends HangingWebSocket {
      static instance: ManualWebSocket;
      sent: string[] = [];

      constructor() {
        super();
        ManualWebSocket.instance = this;
        queueMicrotask(() => {
          this.readyState = ManualWebSocket.OPEN;
          this.onopen?.();
        });
      }

      send(raw = "") {
        this.sent.push(raw);
      }
    }
    installBrowserGlobals(ManualWebSocket as unknown as typeof WebSocket);
    const bridge = createTestBridge();
    bridge.connect();
    await Bun.sleep(1);
    sendHello(ManualWebSocket.instance);
    bridge.setActiveConnection("alpha");

    const response = bridge.call("workspace.list");
    const request = JSON.parse(ManualWebSocket.instance.sent[0]);
    ManualWebSocket.instance.onmessage?.({
      data: JSON.stringify({
        id: request.id,
        connection_id: "beta",
        result: { workspaces: [] },
      }),
    } as MessageEvent);

    await expect(response).rejects.toThrow("response connection_id mismatch");
  });

  test("invalidates pending scoped clients across an active switch", async () => {
    class ManualWebSocket extends HangingWebSocket {
      static instance: ManualWebSocket;
      sent: string[] = [];

      constructor() {
        super();
        ManualWebSocket.instance = this;
        queueMicrotask(() => {
          this.readyState = ManualWebSocket.OPEN;
          this.onopen?.();
        });
      }

      send(raw = "") {
        this.sent.push(raw);
      }
    }
    installBrowserGlobals(ManualWebSocket as unknown as typeof WebSocket);
    const bridge = createTestBridge();
    bridge.connect();
    await Bun.sleep(1);
    sendHello(ManualWebSocket.instance);
    bridge.setActiveConnection("alpha");
    const alpha = bridge.connection();

    const pending = alpha.call("workspace.list");
    bridge.setActiveConnection("beta");

    await expect(pending).rejects.toThrow("connection changed during request");
    await expect(alpha.call("workspace.list")).rejects.toThrow(
      "connection changed during request",
    );
  });

  test("invalidates pending work across a same-ID client generation change", async () => {
    class ManualWebSocket extends HangingWebSocket {
      static instance: ManualWebSocket;
      sent: string[] = [];

      constructor() {
        super();
        ManualWebSocket.instance = this;
        queueMicrotask(() => {
          this.readyState = ManualWebSocket.OPEN;
          this.onopen?.();
        });
      }

      send(raw = "") {
        this.sent.push(raw);
      }
    }
    installBrowserGlobals(ManualWebSocket as unknown as typeof WebSocket);
    const bridge = createTestBridge();
    bridge.connect();
    await Bun.sleep(1);
    sendHello(ManualWebSocket.instance);
    bridge.setActiveConnection("alpha");
    const alpha = bridge.connection();

    const pending = alpha.call("workspace.list");
    bridge.advanceActiveConnectionGeneration();

    await expect(pending).rejects.toThrow("connection changed during request");
    expect(alpha.isCurrent()).toBe(false);
  });

  test("exposes hello metadata and preserves identities on all scoped pushes", async () => {
    class ManualWebSocket extends HangingWebSocket {
      static instance: ManualWebSocket;

      constructor() {
        super();
        ManualWebSocket.instance = this;
        queueMicrotask(() => {
          this.readyState = ManualWebSocket.OPEN;
          this.onopen?.();
        });
      }
    }
    installBrowserGlobals(ManualWebSocket as unknown as typeof WebSocket);
    const bridge = createTestBridge();
    const hellos: unknown[] = [];
    const events: unknown[] = [];
    const terminals: unknown[] = [];
    const clipboards: unknown[] = [];
    bridge.onHello((hello) => hellos.push(hello));
    bridge.onEvent((event) => events.push(event));
    bridge.onTerminal((terminal) => terminals.push(terminal));
    bridge.onTerminalClipboard((clipboard) => clipboards.push(clipboard));
    bridge.connect();
    await Bun.sleep(1);

    const hello = {
      hello: true,
      bridge_protocol_version: 2,
      default_connection_id: "alpha",
      capabilities: { connection_id: true, connection_scoped_http: true },
    };
    ManualWebSocket.instance.onmessage?.({
      data: JSON.stringify(hello),
    } as MessageEvent);
    ManualWebSocket.instance.onmessage?.({
      data: JSON.stringify({
        connection_id: "beta",
        event: "workspace.updated",
        data: { type: "workspace" },
      }),
    } as MessageEvent);
    ManualWebSocket.instance.onmessage?.({
      data: JSON.stringify({
        connection_id: "beta",
        terminal: {
          terminal_id: "same",
          width: 80,
          height: 24,
          full: true,
          bytes: "",
        },
      }),
    } as MessageEvent);
    ManualWebSocket.instance.onmessage?.({
      data: JSON.stringify({
        connection_id: "beta",
        terminal_clipboard: { terminal_id: "same", data: "YQ==" },
      }),
    } as MessageEvent);
    ManualWebSocket.instance.onmessage?.({
      data: JSON.stringify({
        connection_id: "beta",
        terminal: { width: 80, height: 24, full: true, bytes: "ignored" },
        terminal_clipboard: { data: "aWdub3JlZA==" },
      }),
    } as MessageEvent);
    ManualWebSocket.instance.onmessage?.({
      data: JSON.stringify({
        connection_id: "beta",
        event: "workspace.updated",
        data: null,
      }),
    } as MessageEvent);
    ManualWebSocket.instance.onmessage?.({
      data: JSON.stringify({
        connection_id: "beta",
        terminal: {
          terminal_id: "same",
          width: "80",
          height: 24,
          full: true,
          bytes: 7,
        },
      }),
    } as MessageEvent);
    ManualWebSocket.instance.onmessage?.({
      data: JSON.stringify({
        connection_id: "beta",
        terminal_clipboard: { terminal_id: "same", data: 7 },
      }),
    } as MessageEvent);

    expect(hellos).toEqual([hello]);
    expect(bridge.activeConnectionId).toBe("alpha");
    expect(events).toEqual([
      {
        connection_id: "beta",
        event: "workspace.updated",
        data: { type: "workspace" },
      },
    ]);
    expect(terminals).toEqual([
      {
        connection_id: "beta",
        terminal_id: "same",
        width: 80,
        height: 24,
        full: true,
        bytes: "",
      },
    ]);
    expect(clipboards).toEqual([
      { connection_id: "beta", terminal_id: "same", data: "YQ==" },
    ]);
  });

  test("rejects overlapping wire envelopes before they can spoof hello or RPC replies", async () => {
    class ManualWebSocket extends HangingWebSocket {
      static instance: ManualWebSocket;
      sent: string[] = [];

      constructor() {
        super();
        ManualWebSocket.instance = this;
        queueMicrotask(() => {
          this.readyState = ManualWebSocket.OPEN;
          this.onopen?.();
        });
      }

      send(raw = "") {
        this.sent.push(raw);
      }
    }
    installBrowserGlobals(ManualWebSocket as unknown as typeof WebSocket);
    const bridge = createTestBridge();
    const hellos: unknown[] = [];
    const events: unknown[] = [];
    bridge.onHello((hello) => hellos.push(hello));
    bridge.onEvent((event) => events.push(event));
    bridge.connect();
    await Bun.sleep(1);

    const hello = {
      hello: true,
      bridge_protocol_version: 2,
      default_connection_id: "alpha",
      capabilities: { connection_runtime_generation: true },
    };
    ManualWebSocket.instance.onmessage?.({
      data: JSON.stringify(hello),
    } as MessageEvent);
    bridge.setConnectionRuntimeGenerations([{ id: "alpha", generation: 7 }]);

    ManualWebSocket.instance.onmessage?.({
      data: JSON.stringify({
        connection_id: "alpha",
        connection_generation: 7,
        event: "workspace.updated",
        data: { type: "workspace" },
        hello: true,
        bridge_protocol_version: 2,
        default_connection_id: "alpha",
        capabilities: { connection_runtime_generation: false },
      }),
    } as MessageEvent);
    expect(hellos).toEqual([hello]);
    expect(events).toEqual([]);
    expect(bridge.hello?.capabilities.connection_runtime_generation).toBe(true);

    const identityResponse = bridge.call("connections.list");
    const identityRequest = JSON.parse(
      ManualWebSocket.instance.sent[ManualWebSocket.instance.sent.length - 1],
    );
    ManualWebSocket.instance.onmessage?.({
      data: JSON.stringify({
        id: identityRequest.id,
        connection_id: "alpha",
        connection_generation: 7,
        result: { forged: true },
      }),
    } as MessageEvent);
    await expect(identityResponse).rejects.toThrow(
      "global response contains connection identity",
    );

    const malformedResponse = bridge.call("connections.list");
    const malformedRequest = JSON.parse(
      ManualWebSocket.instance.sent[ManualWebSocket.instance.sent.length - 1],
    );
    ManualWebSocket.instance.onmessage?.({
      data: JSON.stringify({ id: malformedRequest.id }),
    } as MessageEvent);
    ManualWebSocket.instance.onmessage?.({
      data: JSON.stringify({ id: malformedRequest.id, error: null }),
    } as MessageEvent);
    await expect(malformedResponse).rejects.toThrow("invalid error response");

    const globalResponse = bridge.call("connections.list");
    const globalRequest = JSON.parse(
      ManualWebSocket.instance.sent[ManualWebSocket.instance.sent.length - 1],
    );
    ManualWebSocket.instance.onmessage?.({
      data: JSON.stringify({
        id: globalRequest.id,
        result: { forged: true },
        connection_id: "alpha",
        connection_generation: 7,
        event: "workspace.updated",
        data: { type: "workspace" },
      }),
    } as MessageEvent);
    ManualWebSocket.instance.onmessage?.({
      data: JSON.stringify({ id: globalRequest.id, result: { trusted: true } }),
    } as MessageEvent);
    await expect(globalResponse).resolves.toEqual({ trusted: true });
    expect(events).toEqual([]);

    const scopedResponse = bridge.call("workspace.list");
    const scopedRequest = JSON.parse(
      ManualWebSocket.instance.sent[ManualWebSocket.instance.sent.length - 1],
    );
    expect(scopedRequest).toMatchObject({
      connection_id: "alpha",
      connection_generation: 7,
    });
    ManualWebSocket.instance.onmessage?.({
      data: JSON.stringify({
        id: scopedRequest.id,
        connection_id: "alpha",
        connection_generation: 7,
        result: { workspaces: [] },
      }),
    } as MessageEvent);
    await expect(scopedResponse).resolves.toEqual({ workspaces: [] });
  });

  test("parses profile-aware catalogs while tolerating transition statuses", () => {
    const base = {
      id: "alpha",
      label: "Alpha",
      source: "local-profile",
      is_default: true,
      state: "ready" as const,
      generation: 3,
    };
    expect(parseConnectionSummary(base)).toEqual(base);
    expect(
      parseConnectionSummary({
        ...base,
        type: "local",
        read_only: false,
        auto_connect: true,
        control_socket_path: "/tmp/control.sock",
        client_socket_path: "/tmp/client.sock",
      }),
    ).toMatchObject({
      type: "local",
      read_only: false,
      auto_connect: true,
      control_socket_path: "/tmp/control.sock",
      client_socket_path: "/tmp/client.sock",
    });
    expect(
      parseConnectionSummary({
        ...base,
        source: "ssh-profile",
        type: "ssh",
        read_only: false,
        auto_connect: false,
        ssh_destination: "operator@dev-box",
        remote_control_socket_path: "/remote/herdr.sock",
        remote_client_socket_path: "/remote/herdr-client.sock",
      }),
    ).toMatchObject({
      type: "ssh",
      ssh_destination: "operator@dev-box",
      remote_control_socket_path: "/remote/herdr.sock",
      remote_client_socket_path: "/remote/herdr-client.sock",
    });
    expect(
      parseConnectionSummary({
        ...base,
        source: "ssh-profile",
        type: "ssh",
        read_only: false,
        auto_connect: false,
        ssh_destination: "operator@dev-box",
        remote_control_socket_path: "",
        remote_client_socket_path: "",
      }),
    ).toMatchObject({
      type: "ssh",
      remote_control_socket_path: "",
      remote_client_socket_path: "",
    });
    for (const invalidSsh of [
      {
        type: "ssh",
        ssh_destination: "operator@dev-box",
      },
      {
        type: "ssh",
        read_only: false,
        auto_connect: false,
        ssh_destination: "@dev-box",
        remote_control_socket_path: "/remote/herdr.sock",
        remote_client_socket_path: "/remote/herdr-client.sock",
      },
      {
        type: "ssh",
        read_only: false,
        auto_connect: false,
        ssh_destination: "operator@dev-box",
        remote_control_socket_path: "/remote/herdr.sock",
        remote_client_socket_path: "/remote/herdr.sock",
      },
      {
        type: "ssh",
        read_only: false,
        auto_connect: false,
        ssh_destination: "operator@dev-box",
        remote_control_socket_path: "/remote/herdr.sock",
        remote_client_socket_path: "/remote/herdr-client.sock",
        control_socket_path: "/tmp/forged.sock",
      },
    ]) {
      expect(parseConnectionSummary({ ...base, ...invalidSsh })).toBeNull();
    }
    expect(parseConnectionSummary({ ...base, type: "unknown" })).toBeNull();
    expect(parseConnectionSummary({ ...base, state: "bogus" })).toBeNull();
  });

  test("probeConnectionNow is a no-op while disconnected", () => {
    installBrowserGlobals(HangingWebSocket as unknown as typeof WebSocket);
    const bridge = createTestBridge();
    expect(() => bridge.probeConnectionNow()).not.toThrow();
    expect(bridge.status).toBe("disconnected");
  });

  test("probeConnectionNow drops a socket that closed without a close event", async () => {
    class FrozenWebSocket extends HangingWebSocket {
      static instances: FrozenWebSocket[] = [];

      constructor() {
        super();
        FrozenWebSocket.instances.push(this);
        queueMicrotask(() => {
          this.readyState = FrozenWebSocket.OPEN;
          this.onopen?.();
        });
      }

      // Simulates the OS killing the socket while the page was frozen: the
      // readyState moves on but no close event is ever delivered.
      closeSilently() {
        this.readyState = FrozenWebSocket.CLOSED;
      }
    }
    installBrowserGlobals(FrozenWebSocket as unknown as typeof WebSocket);
    const bridge = createTestBridge(50, 1);
    bridge.connect();
    await Bun.sleep(1);
    sendHello(FrozenWebSocket.instances[0]);
    expect(bridge.status).toBe("connected");

    FrozenWebSocket.instances[0].closeSilently();
    bridge.probeConnectionNow();
    expect(bridge.status).toBe("disconnected");

    await Bun.sleep(10);
    expect(FrozenWebSocket.instances.length).toBe(2);
  });

  test("does not advance the client generation twice when a probe rejects during teardown", async () => {
    class ProbedWebSocket extends HangingWebSocket {
      static instance: ProbedWebSocket;
      sent: string[] = [];

      constructor() {
        super();
        ProbedWebSocket.instance = this;
        queueMicrotask(() => {
          this.readyState = ProbedWebSocket.OPEN;
          this.onopen?.();
        });
      }

      send(raw = "") {
        this.sent.push(raw);
      }
    }
    installBrowserGlobals(ProbedWebSocket as unknown as typeof WebSocket);
    const bridge = createTestBridge(50);
    bridge.connect();
    await Bun.sleep(1);
    sendHello(ProbedWebSocket.instance);
    const generation = bridge.clientGeneration;

    // Simulate the frozen-page resume burst: a heartbeat probe goes out on
    // the zombie socket, then the delayed close event arrives. rejectPending
    // rejects the probe, whose handler must not force a second teardown.
    bridge.probeConnectionNow();
    expect(ProbedWebSocket.instance.sent.length).toBe(1);
    ProbedWebSocket.instance.onclose?.();
    await Bun.sleep(1);

    expect(bridge.clientGeneration).toBe(generation + 1);
  });

  test("handleDisconnect stays idempotent once the socket is fully torn down", async () => {
    class OpeningWebSocket extends HangingWebSocket {
      static instance: OpeningWebSocket;

      constructor() {
        super();
        OpeningWebSocket.instance = this;
        queueMicrotask(() => {
          this.readyState = OpeningWebSocket.OPEN;
          this.onopen?.();
        });
      }
    }
    installBrowserGlobals(OpeningWebSocket as unknown as typeof WebSocket);
    const bridge = createTestBridge(50);
    bridge.connect();
    await Bun.sleep(1);
    sendHello(OpeningWebSocket.instance);
    const generation = bridge.clientGeneration;

    OpeningWebSocket.instance.onclose?.();
    expect(bridge.clientGeneration).toBe(generation + 1);

    // A repeated teardown with no live socket must not advance the client
    // generation again: status handlers only fire on transitions, so
    // generation-scoped clients captured the first advance and would never
    // learn a second one.
    const internals = bridge as unknown as {
      handleDisconnect(ws: WebSocket | null, reason: string): void;
    };
    internals.handleDisconnect(null, "stale repeated teardown");
    expect(bridge.clientGeneration).toBe(generation + 1);
  });

  test("probeConnectionNow pings an open socket and stays connected on reply", async () => {
    class ProbedWebSocket extends HangingWebSocket {
      static instance: ProbedWebSocket;
      sent: string[] = [];

      constructor() {
        super();
        ProbedWebSocket.instance = this;
        queueMicrotask(() => {
          this.readyState = ProbedWebSocket.OPEN;
          this.onopen?.();
        });
      }

      send(raw = "") {
        this.sent.push(raw);
      }
    }
    installBrowserGlobals(ProbedWebSocket as unknown as typeof WebSocket);
    const bridge = createTestBridge(50);
    bridge.connect();
    await Bun.sleep(1);
    sendHello(ProbedWebSocket.instance);

    bridge.probeConnectionNow();
    expect(ProbedWebSocket.instance.sent.length).toBe(1);
    const ping = JSON.parse(ProbedWebSocket.instance.sent[0]);
    expect(ping.method).toBe("bridge.ping");

    ProbedWebSocket.instance.onmessage?.({
      data: JSON.stringify({ id: ping.id, result: { ok: true } }),
    } as MessageEvent);
    await Bun.sleep(5);
    expect(bridge.status).toBe("connected");
  });
});

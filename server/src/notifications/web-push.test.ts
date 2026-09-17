import { expect, mock, test } from "bun:test";
import { createECDH, randomBytes } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import webpush from "web-push";
import {
  createWebPushService,
  validatePushDevice,
  validatePushEndpoint,
  type PushTask,
} from "./web-push";
import { createAuthHandlers } from "../http/auth";
import { createLegacyConnectionRuntime } from "../connections/runtime";

function device(id = "device-1") {
  const key = createECDH("prime256v1");
  key.generateKeys();
  return {
    subscription: {
      endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
      keys: {
        p256dh: key.getPublicKey().toString("base64url"),
        auth: randomBytes(16).toString("base64url"),
      },
    },
    preferences: { completed: true, blocked: true },
  };
}
const task: PushTask = {
  kind: "blocked",
  connectionId: "alpha",
  runtimeGeneration: 3,
  workspaceId: "w1",
  paneId: "p1",
  agent: "Example agent",
};
function request(
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new Request("https://roamgate.example/api/notifications/push", {
    method,
    headers: {
      "content-type": "application/json",
      "x-roamgate-push": "1",
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function fixture(
  send: typeof webpush.sendNotification = mock(async () => ({
    statusCode: 201,
    body: "",
    headers: {},
  })),
) {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-push-"));
  const path = join(dir, "web-push.json");
  const warn = mock();
  const options = { path, subject: "mailto:operator@example.com", send, warn };
  const service = createWebPushService(options);
  return {
    service,
    options,
    path,
    warn,
    cleanup() {
      service.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("rejects SSRF destinations, credentials, malformed keys and oversized endpoints", () => {
  const authenticated = new URL("https://fcm.googleapis.com/a");
  authenticated.username = "example-user";
  authenticated.password = randomBytes(16).toString("hex");
  for (const endpoint of [
    "http://fcm.googleapis.com/a",
    "https://127.0.0.1/a",
    "https://localhost/a",
    "https://fcm.googleapis.com.evil.example/a",
    "https://fcm.googleapis.com:8443/a",
    authenticated.href,
    "https://fcm.googleapis.com/" + "a".repeat(4096),
    "https://fcm.googleapis.com/a#x",
    "https://push.apple.com.evil.example/a",
  ])
    expect(() => validatePushEndpoint(endpoint)).toThrow();
  for (const endpoint of [
    "https://web.push.apple.com/a",
    "https://updates.push.services.mozilla.com/wpush/v2/a",
    "https://wns.notify.windows.com/a",
  ])
    expect(validatePushEndpoint(endpoint)).toBe(endpoint);
  const input = device();
  expect(validatePushDevice(input)).toEqual(input);
  expect(() =>
    validatePushDevice({ ...input, preferences: { completed: true } }),
  ).toThrow();
  expect(() =>
    validatePushDevice({
      ...input,
      subscription: {
        ...input.subscription,
        keys: { p256dh: "A".repeat(87), auth: input.subscription.keys.auth },
      },
    }),
  ).toThrow();
});

test("authenticated, non-CSRF device mutations persist privately across restart and revoke independently", async () => {
  const f = fixture();
  try {
    const auth = createAuthHandlers({
      authRequired: true,
      password: randomBytes(32).toString("hex"),
    });
    const handle = (req: Request) =>
      auth.isAuthed(req)
        ? f.service.handle(req)
        : Promise.resolve(new Response("unauthorized", { status: 401 }));
    expect((await handle(request())).status).toBe(401);
    const first = device("first"),
      second = device("second");
    expect(
      (
        await f.service.handle(
          request("POST", first, { "x-roamgate-push": "" }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await f.service.handle(
          request("POST", first, { "sec-fetch-site": "cross-site" }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await f.service.handle(request("POST", "x".repeat(17000)))).status,
    ).toBe(400);
    expect((await f.service.handle(request("POST", first))).status).toBe(200);
    expect((await f.service.handle(request("POST", second))).status).toBe(200);
    const before = await (await f.service.handle(request())).json();
    expect(before.available).toBe(true);
    expect(Object.keys(before).sort()).toEqual(["available", "publicKey"]);
    if (process.platform !== "win32")
      expect(statSync(f.path).mode & 0o777).toBe(0o600);
    const reloaded = createWebPushService(f.options);
    expect(await (await reloaded.handle(request())).json()).toEqual(before);
    expect(
      (
        await reloaded.handle(
          request("DELETE", { endpoint: first.subscription.endpoint }),
        )
      ).status,
    ).toBe(200);
    const data = JSON.parse(readFileSync(f.path, "utf8"));
    expect(data.devices).toEqual([second]);
    expect(data.publicKey).toBe(before.publicKey);
    reloaded.stop();
  } finally {
    f.cleanup();
  }
});

test("completion and blocked preferences, stale runtimes and expired endpoints are isolated", async () => {
  const calls: Array<{ endpoint: string; payload: string }> = [];
  const expired = Promise.withResolvers<void>();
  const f = fixture(async (subscription, payload, options) => {
    calls.push({ endpoint: subscription.endpoint, payload: String(payload) });
    expect(options).toMatchObject({
      TTL: 300,
      timeout: 10000,
      urgency: "high",
    });
    const details = webpush.generateRequestDetails(
      subscription,
      payload ?? undefined,
      options,
    );
    expect(details.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(details.headers.Authorization).toContain("vapid ");
    if (subscription.endpoint.endsWith("expired")) {
      expired.resolve();
      throw { statusCode: 410 };
    }
    return { statusCode: 201, body: "", headers: {} };
  });
  try {
    const completed = device("completed");
    completed.preferences.blocked = false;
    const blocked = device("blocked");
    blocked.preferences.completed = false;
    for (const item of [completed, blocked, device("expired")])
      await f.service.handle(request("POST", item));
    f.service.notify(task, () => false);
    expect(calls).toHaveLength(0);
    f.service.notify(task, () => true);
    await expired.promise;
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(calls.map((call) => call.endpoint.split("/").at(-1))).toEqual([
      "blocked",
      "expired",
    ]);
    const payload = JSON.parse(calls[0]!.payload);
    expect(payload.title).toContain("needs input");
    expect(payload.target).toEqual({
      connectionId: "alpha",
      runtimeGeneration: 3,
      workspaceId: "w1",
      paneId: "p1",
    });
    expect(JSON.parse(readFileSync(f.path, "utf8")).devices).toHaveLength(2);
    f.service.notify({ ...task, kind: "completed" }, () => true);
    expect(calls.at(-1)?.endpoint).toBe(completed.subscription.endpoint);
    await f.service.handle(
      request("DELETE", { endpoint: completed.subscription.endpoint }),
    );
    f.service.notify({ ...task, kind: "completed" }, () => true);
    expect(calls).toHaveLength(3);
  } finally {
    f.cleanup();
  }
});

test("native delivery uses encrypted fetch with a hard deadline and no redirects", async () => {
  const f = fixture();
  const originalFetch = globalThis.fetch;
  const delivered = Promise.withResolvers<void>();
  let captured: RequestInit | undefined;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (_url: string, init: RequestInit) => {
      captured = init;
      delivered.resolve();
      return new Response(null, { status: 201 });
    },
  });
  const service = createWebPushService({ ...f.options, send: undefined });
  try {
    await service.handle(request("POST", device()));
    service.notify(task, () => true);
    await delivered.promise;
    expect(captured?.redirect).toBe("error");
    expect(captured?.signal).toBeInstanceOf(AbortSignal);
    expect(captured?.headers).toMatchObject({
      "Content-Encoding": "aes128gcm",
    });
    expect(captured?.body).toBeInstanceOf(Uint8Array);
    expect(
      Buffer.from(captured?.body as Uint8Array).includes(
        Buffer.from("Example agent"),
      ),
    ).toBe(false);
  } finally {
    service.stop();
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
    f.cleanup();
  }
});

test("bounded delivery concurrency discards revoked and stale queued tasks", async () => {
  const gate = Promise.withResolvers<void>();
  const send = mock(async () => {
    await gate.promise;
    return { statusCode: 201, body: "", headers: {} };
  });
  const f = fixture(send);
  let current = true;
  try {
    const devices = Array.from({ length: 6 }, (_, index) =>
      device(String(index)),
    );
    for (const item of devices) await f.service.handle(request("POST", item));
    f.service.notify(task, () => current);
    expect(send).toHaveBeenCalledTimes(4);
    await f.service.handle(
      request("DELETE", { endpoint: devices[4]!.subscription.endpoint }),
    );
    current = false;
    gate.resolve();
    for (let index = 0; index < 20; index++) await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(4);
    f.service.stop();
    f.service.notify(task, () => true);
    expect(send).toHaveBeenCalledTimes(4);
  } finally {
    gate.resolve();
    f.cleanup();
  }
});

test("corrupt private data is preserved and disables push instead of rotating keys", async () => {
  const f = fixture();
  try {
    f.service.stop();
    writeFileSync(f.path, "invalid registry");
    const failed = createWebPushService(f.options);
    expect(await (await failed.handle(request())).json()).toEqual({
      available: false,
      publicKey: null,
    });
    expect(readFileSync(f.path, "utf8")).toBe("invalid registry");
    expect(f.warn).toHaveBeenCalled();
    expect((await failed.handle(request("POST", device()))).status).toBe(503);
    failed.stop();
  } finally {
    f.cleanup();
  }
});

test("runtime agent subscriptions deliver without any browser clients and stop with the runtime", async () => {
  const sent = Promise.withResolvers<string>();
  const f = fixture(async (_subscription, payload) => {
    sent.resolve(String(payload));
    return { statusCode: 201, body: "", headers: {} };
  });
  const pane = {
    pane_id: "p1",
    workspace_id: "w1",
    agent: "Example agent",
    agent_status: "working",
  };
  const subscribed = Promise.withResolvers<void>();
  const runtime = createLegacyConnectionRuntime({
    config: {
      socketPath: join(dirname(f.path), "control.sock"),
      clientSocketPath: join(dirname(f.path), "client.sock"),
      hasExplicitSocketPath: true,
      hasExplicitClientSocketPath: true,
    },
    safeSend: () => {
      throw new Error("No browser clients expected");
    },
    clientLabel: () => "test",
    markRpcError() {},
    onEvent() {},
    onTaskEvent: (event) =>
      f.service.notify(
        { ...event, connectionId: "alpha", runtimeGeneration: 3 },
        () => true,
      ),
  });
  runtime.workspaceAutoSync.start = () => {};
  runtime.herdr.call = async () => ({ panes: [pane] });
  runtime.herdr.subscribe = (types) => {
    const closed = Promise.withResolvers<void>();
    if (
      types.some(
        (value) =>
          typeof value === "object" &&
          value.type === "pane.agent_status_changed",
      )
    )
      subscribed.resolve();
    return {
      ready: Promise.resolve(),
      closed: closed.promise,
      close: () => closed.resolve(),
    };
  };
  try {
    await f.service.handle(request("POST", device()));
    runtime.startBackground();
    await subscribed.promise;
    runtime.herdr.emit("event", {
      event: "pane.agent_status_changed",
      data: { ...pane, agent_status: "blocked" },
    });
    expect(JSON.parse(await sent.promise).title).toBe(
      "Roamgate agent needs input",
    );
    await runtime.stop();
    f.service.stop();
  } finally {
    await runtime.stop();
    f.cleanup();
  }
});

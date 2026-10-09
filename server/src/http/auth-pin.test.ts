import { describe, expect, jest, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createAuthHandlers } from "./auth";

const PASSWORD = "strong-test-password";
const PIN = "123456";
const SESSION_SECRET = "a".repeat(64);
const URL_TOKEN = "b".repeat(64);
const NOW = 1_700_000_000_000;
const BASE_CONFIG = {
  password: PASSWORD,
  sessionSecret: SESSION_SECRET,
  pin: PIN,
  urlLoginToken: URL_TOKEN,
};
type AuthHandlers = ReturnType<typeof createAuthHandlers>;

function request(body: unknown, path = "/api/login/pin", cookie = "") {
  return new Request(`https://example.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

function pinLogin(handlers: AuthHandlers, ip = "192.0.2.1", pin = PIN) {
  return handlers.handlePinLogin(request({ pin }), ip);
}

function passwordLogin(handlers: AuthHandlers, ip = "192.0.2.1") {
  return handlers.handleLogin(
    request({ password: PASSWORD }, "/api/login"),
    ip,
  );
}

function tokenLogin(handlers: AuthHandlers, ip = "192.0.2.1") {
  return handlers.handleTokenLogin(
    new Request(`https://example.test/?token=${URL_TOKEN}`),
    ip,
  )!;
}

function cookieHeader(response: Response): string {
  const cookie = response.headers.get("set-cookie");
  if (!cookie) throw new Error("Missing authentication cookie");
  return cookie.split(";", 1)[0]!;
}

function authenticatedRequest(cookie: string) {
  return new Request("https://example.test/", { headers: { cookie } });
}

function slowRequest() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  return {
    request: new Request("https://example.test/api/login/pin", {
      method: "POST",
      body,
    }),
    finish(body: string) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  };
}

async function failPins(handlers: AuthHandlers, count: number, prefix = "bad") {
  for (let i = 0; i < count; i++) {
    const response = await pinLogin(handlers, `${prefix}-${i}`, "000000");
    expect(response.status).toBe(401);
    expect(response.headers.has("set-cookie")).toBe(false);
  }
}

describe("optional PIN authentication boundaries", () => {
  test("PIN is disabled by default and does not consume the recovery budget", async () => {
    const handlers = createAuthHandlers({
      password: PASSWORD,
      sessionSecret: SESSION_SECRET,
    });
    for (let i = 0; i < 25; i++) {
      const response = await pinLogin(handlers);
      expect(response.status).toBe(404);
      expect(response.headers.has("set-cookie")).toBe(false);
    }
    expect((await passwordLogin(handlers)).status).toBe(200);
  });

  test.each(["123456", "000001", "123456789012"])(
    "accepts an explicitly configured PIN with valid digits: %s",
    async (pin) => {
      const handlers = createAuthHandlers({ ...BASE_CONFIG, pin });
      const response = await pinLogin(handlers, "192.0.2.1", pin);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(
        handlers.isAuthed(authenticatedRequest(cookieHeader(response))),
      ).toBe(true);
    },
  );

  test.each([
    "",
    "12345",
    "1234567890123",
    "abcdef",
    " 123456",
    "123456 ",
    "123456\n",
    "123.45",
    "\u0661\u0662\u0663\u0664\u0665\u0666",
  ])("rejects invalid configured PIN %j", (pin) => {
    expect(() => createAuthHandlers({ ...BASE_CONFIG, pin })).toThrow(
      "6 to 12 ASCII digits",
    );
  });

  test.each(
    [123456, null, true, [PIN], { value: PIN }, "123456 ", "12345"].map(
      (pin) => ({ pin }),
    ),
  )("requires an exact string PIN, rejecting $pin", async ({ pin }) => {
    const handlers = createAuthHandlers(BASE_CONFIG);
    const response = await handlers.handlePinLogin(request({ pin }), "client");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "wrong PIN" });
    expect(response.headers.has("set-cookie")).toBe(false);
  });

  test("password, URL token, and PIN cannot substitute for each other", async () => {
    const handlers = createAuthHandlers(BASE_CONFIG);
    for (const body of [{ password: PIN }, { pin: PIN }]) {
      const response = await handlers.handleLogin(
        request(body, "/api/login"),
        "password",
      );
      expect(response.status).toBe(401);
      expect(response.headers.has("set-cookie")).toBe(false);
    }
    for (const body of [
      { pin: PASSWORD },
      { password: PASSWORD },
      { pin: URL_TOKEN },
    ]) {
      const response = await handlers.handlePinLogin(request(body), "pin");
      expect(response.status).toBe(401);
      expect(response.headers.has("set-cookie")).toBe(false);
    }
    const token = handlers.handleTokenLogin(
      new Request(`https://example.test/?token=${PIN}`),
      "token",
    )!;
    expect(token.status).toBe(303);
    expect(token.headers.get("location")).toBe("/login");
    expect(token.headers.has("set-cookie")).toBe(false);
    expect((await passwordLogin(handlers)).status).toBe(200);
    expect((await pinLogin(handlers)).status).toBe(200);
    expect(tokenLogin(handlers).headers.has("set-cookie")).toBe(true);
  });

  test.each([false, true])(
    "PIN issues a verified session with correct cookie attributes (TLS %s)",
    async (secureCookies) => {
      const handlers = createAuthHandlers({ ...BASE_CONFIG, secureCookies });
      const response = await pinLogin(handlers);
      const cookie = cookieHeader(response);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("set-cookie")).toContain(
        "; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000",
      );
      expect(response.headers.get("set-cookie")!.includes("; Secure")).toBe(
        secureCookies,
      );
      expect(handlers.isAuthed(authenticatedRequest(cookie))).toBe(true);
      const [payload, signature] = cookie
        .slice("herdr_auth=".length)
        .split(".");
      expect(signature).toBe(
        createHmac("sha256", Buffer.from(SESSION_SECRET, "hex"))
          .update(payload!)
          .digest("hex"),
      );
      const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString());
      expect(decoded.exp - decoded.iat).toBe(30 * 24 * 60 * 60);
      expect(decoded.nonce).toMatch(/^[a-f0-9]{32}$/);
      expect(Object.keys(decoded).sort()).toEqual(["exp", "iat", "nonce"]);
    },
  );

  test("changing either credential preserves sessions; changing signing secret invalidates them", async () => {
    const handlers = createAuthHandlers(BASE_CONFIG);
    const cookie = cookieHeader(await pinLogin(handlers));
    for (const config of [
      { ...BASE_CONFIG, pin: "654321" },
      { ...BASE_CONFIG, pin: undefined },
      { ...BASE_CONFIG, password: "a-different-strong-password" },
      { ...BASE_CONFIG, urlLoginToken: "c".repeat(64) },
    ]) {
      expect(
        createAuthHandlers(config).isAuthed(authenticatedRequest(cookie)),
      ).toBe(true);
    }
    const changedSecret = createAuthHandlers({
      ...BASE_CONFIG,
      sessionSecret: "d".repeat(64),
    });
    expect(changedSecret.isAuthed(authenticatedRequest(cookie))).toBe(false);
    const [payload] = cookie.slice("herdr_auth=".length).split(".");
    for (const key of [PIN, PASSWORD, URL_TOKEN]) {
      const forgedSignature = createHmac("sha256", key)
        .update(payload!)
        .digest("hex");
      expect(
        handlers.isAuthed(
          authenticatedRequest(`herdr_auth=${payload}.${forgedSignature}`),
        ),
      ).toBe(false);
    }
  });

  test("PIN reauthentication preserves an existing session and original expiry", async () => {
    jest.useFakeTimers({ now: NOW });
    try {
      const handlers = createAuthHandlers(BASE_CONFIG);
      const cookie = cookieHeader(await pinLogin(handlers));
      jest.advanceTimersByTime(60_000);
      const response = await handlers.handlePinLogin(
        request({ pin: PIN }, "/api/login/pin", cookie),
        "client",
      );
      expect(response.status).toBe(200);
      expect(response.headers.has("set-cookie")).toBe(false);
      expect(cookieHeader(await pinLogin(handlers))).not.toBe(cookie);
      jest.advanceTimersByTime(30 * 24 * 60 * 60_000 - 60_000);
      expect(handlers.isAuthed(authenticatedRequest(cookie))).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("PIN failure and recovery limits", () => {
  test("five failures block only that PIN client and cannot consume password or token recovery", async () => {
    jest.useFakeTimers({ now: NOW });
    try {
      const handlers = createAuthHandlers(BASE_CONFIG);
      for (let i = 0; i < 5; i++) {
        expect((await pinLogin(handlers, "blocked", "000000")).status).toBe(
          401,
        );
      }
      const blocked = await pinLogin(handlers, "blocked");
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("retry-after")).toBe("300");
      expect(blocked.headers.has("set-cookie")).toBe(false);
      expect((await passwordLogin(handlers, "blocked")).status).toBe(200);
      expect(tokenLogin(handlers, "blocked").headers.has("set-cookie")).toBe(
        true,
      );
      expect((await pinLogin(handlers, "other")).status).toBe(200);
      // Success on another client must not clear the blocked client's cooldown.
      expect((await pinLogin(handlers, "blocked")).status).toBe(429);
      jest.advanceTimersByTime(299_999);
      expect(
        (await pinLogin(handlers, "blocked")).headers.get("retry-after"),
      ).toBe("1");
      jest.advanceTimersByTime(1);
      expect((await pinLogin(handlers, "blocked")).status).toBe(200);
    } finally {
      jest.useRealTimers();
    }
  });

  test("password cooldowns do not block PIN and PIN success cannot clear strong recovery cooldowns", async () => {
    const handlers = createAuthHandlers(BASE_CONFIG);
    for (let i = 0; i < 5; i++) {
      const response = await handlers.handleLogin(
        request({ password: "wrong" }, "/api/login"),
        "client",
      );
      expect(response.status).toBe(401);
    }
    expect((await passwordLogin(handlers, "client")).status).toBe(429);
    expect((await pinLogin(handlers, "client")).status).toBe(200);
    expect((await passwordLogin(handlers, "client")).status).toBe(429);
    expect(tokenLogin(handlers, "client").status).toBe(429);
  });

  test.each(["password", "URL token"])(
    "%s recovery works during PIN lockout without clearing PIN failures or cooldown",
    async (mode) => {
      jest.useFakeTimers({ now: NOW });
      try {
        const handlers = createAuthHandlers(BASE_CONFIG);
        const recover = () =>
          mode === "password"
            ? passwordLogin(handlers, "bad-0")
            : Promise.resolve(tokenLogin(handlers, "bad-0"));
        await failPins(handlers, 9);
        const before = await recover();
        expect(before.status).toBe(mode === "password" ? 200 : 303);
        expect(
          handlers.isAuthed(authenticatedRequest(cookieHeader(before))),
        ).toBe(true);
        expect((await pinLogin(handlers, "tenth", "000000")).status).toBe(401);
        const blocked = await pinLogin(handlers, "new-client");
        expect(blocked.status).toBe(429);
        expect(blocked.headers.get("retry-after")).toBe("3600");
        expect(blocked.headers.get("cache-control")).toBe("no-store");
        expect(blocked.headers.get("referrer-policy")).toBe("no-referrer");
        expect(blocked.headers.has("set-cookie")).toBe(false);
        const during = await recover();
        expect(during.status).toBe(mode === "password" ? 200 : 303);
        expect(
          handlers.isAuthed(authenticatedRequest(cookieHeader(during))),
        ).toBe(true);
        expect((await pinLogin(handlers, "bad-0")).status).toBe(429);
        expect(
          handlers.isAuthed(authenticatedRequest(cookieHeader(before))),
        ).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  test("successful PIN authentication resets consecutive global and per-IP failures", async () => {
    const handlers = createAuthHandlers(BASE_CONFIG);
    await failPins(handlers, 5);
    for (let i = 0; i < 4; i++) {
      expect((await pinLogin(handlers, "client", "000000")).status).toBe(401);
    }
    expect((await pinLogin(handlers, "client")).status).toBe(200);
    for (let i = 0; i < 4; i++) {
      expect((await pinLogin(handlers, "client", "000000")).status).toBe(401);
    }
    await failPins(handlers, 5, "after-success");
    expect((await pinLogin(handlers, "fresh-client")).status).toBe(200);
  });

  test("global cooldown expires after an hour, is not extended by blocked requests, and resets failures", async () => {
    jest.useFakeTimers({ now: NOW });
    try {
      const handlers = createAuthHandlers(BASE_CONFIG);
      const session = cookieHeader(await pinLogin(handlers));
      await failPins(handlers, 10);
      jest.advanceTimersByTime(3_599_999);
      const blocked = await pinLogin(handlers, "new-client");
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("retry-after")).toBe("1");
      expect(handlers.isAuthed(authenticatedRequest(session))).toBe(true);
      jest.advanceTimersByTime(1);
      // Nine new failures must be allowed even before any successful recovery.
      await failPins(handlers, 9, "recovered");
      expect((await pinLogin(handlers, "new-client")).status).toBe(200);
    } finally {
      jest.useRealTimers();
    }
  });

  test("successful PIN attempts have a separate 20-per-minute IP budget", async () => {
    jest.useFakeTimers({ now: NOW });
    try {
      const handlers = createAuthHandlers(BASE_CONFIG);
      const responses = await Promise.all(
        Array.from({ length: 25 }, () => pinLogin(handlers, "client")),
      );
      expect(
        responses.filter((response) => response.status === 200),
      ).toHaveLength(20);
      expect(
        responses.filter((response) => response.status === 429),
      ).toHaveLength(5);
      expect(
        (await pinLogin(handlers, "client")).headers.get("retry-after"),
      ).toBe("60");
      expect((await passwordLogin(handlers, "client")).status).toBe(200);
      expect(tokenLogin(handlers, "client").headers.has("set-cookie")).toBe(
        true,
      );
      jest.advanceTimersByTime(59_999);
      expect((await pinLogin(handlers, "client")).status).toBe(429);
      jest.advanceTimersByTime(1);
      expect((await pinLogin(handlers, "client")).status).toBe(200);
    } finally {
      jest.useRealTimers();
    }
  });

  test("global consecutive failures survive per-IP window and record expiry", async () => {
    jest.useFakeTimers({ now: NOW });
    try {
      const handlers = createAuthHandlers(BASE_CONFIG);
      for (let i = 0; i < 10; i++) {
        expect((await pinLogin(handlers, "client", "000000")).status).toBe(401);
        if (i < 9) jest.advanceTimersByTime(300_000);
      }
      const blocked = await pinLogin(handlers, "fresh-client");
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("retry-after")).toBe("3600");
    } finally {
      jest.useRealTimers();
    }
  });

  test.each(["one client", "distributed clients"])(
    "parallel failures from %s cannot overrun the failure threshold",
    async (mode) => {
      const handlers = createAuthHandlers(BASE_CONFIG);
      const responses = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          pinLogin(
            handlers,
            mode === "one client" ? "client" : `client-${i}`,
            "000000",
          ),
        ),
      );
      const acceptedFailures = mode === "one client" ? 5 : 10;
      expect(
        responses.filter((response) => response.status === 401),
      ).toHaveLength(acceptedFailures);
      expect(
        responses.filter((response) => response.status === 429),
      ).toHaveLength(30 - acceptedFailures);
      expect(
        responses.every((response) => !response.headers.has("set-cookie")),
      ).toBe(true);
    },
  );

  test("bounded PIN IP state fails closed, preserves cooldowns, and recovers expired capacity", async () => {
    jest.useFakeTimers({ now: NOW });
    try {
      const handlers = createAuthHandlers(BASE_CONFIG);
      for (let i = 0; i < 5; i++) {
        expect((await pinLogin(handlers, "blocked", "000000")).status).toBe(
          401,
        );
      }
      // Valid PINs avoid the global failure threshold while filling the IP map.
      for (let i = 1; i < 4096; i++) {
        expect((await pinLogin(handlers, `client-${i}`)).status).toBe(200);
      }
      const overflow = await pinLogin(handlers, "new-client");
      expect(overflow.status).toBe(429);
      expect(overflow.headers.has("set-cookie")).toBe(false);
      expect((await pinLogin(handlers, "blocked")).status).toBe(429);
      expect((await passwordLogin(handlers, "new-client")).status).toBe(200);
      expect(tokenLogin(handlers, "new-client").headers.has("set-cookie")).toBe(
        true,
      );
      jest.advanceTimersByTime(300_000);
      expect((await pinLogin(handlers, "new-client")).status).toBe(200);
      expect((await pinLogin(handlers, "blocked")).status).toBe(200);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("PIN body limits and in-flight races", () => {
  test("accepts JSON exactly at the byte limit and rejects the next byte", async () => {
    const handlers = createAuthHandlers(BASE_CONFIG);
    const empty = JSON.stringify({ pin: PIN, extra: "" });
    const body = JSON.stringify({
      pin: PIN,
      extra: "x".repeat(16 * 1024 - Buffer.byteLength(empty)),
    });
    expect(Buffer.byteLength(body)).toBe(16 * 1024);
    const login = (value: string) =>
      handlers.handlePinLogin(
        new Request("https://example.test/api/login/pin", {
          method: "POST",
          body: value,
        }),
        "client",
      );
    expect((await login(body)).status).toBe(200);
    const oversized = await login(`${body} `);
    expect(oversized.status).toBe(413);
    expect(oversized.headers.has("set-cookie")).toBe(false);
  });

  test.each([
    { name: "missing body", body: undefined, status: 400 },
    { name: "malformed JSON", body: "{", status: 400 },
    {
      name: "oversized JSON",
      body: JSON.stringify({ pin: PIN, extra: "x".repeat(16 * 1024) }),
      status: 413,
    },
    { name: "null JSON", body: "null", status: 401 },
    { name: "array JSON", body: JSON.stringify([PIN]), status: 401 },
    { name: "missing PIN", body: "{}", status: 401 },
  ])(
    "$name consumes global and per-IP PIN failure budgets",
    async ({ body, status }) => {
      const handlers = createAuthHandlers(BASE_CONFIG);
      const invalid = (ip: string) =>
        handlers.handlePinLogin(
          new Request("https://example.test/api/login/pin", {
            method: "POST",
            body,
          }),
          ip,
        );
      for (let i = 0; i < 5; i++) {
        const response = await invalid("client");
        expect(response.status).toBe(status);
        expect(response.headers.has("set-cookie")).toBe(false);
      }
      expect((await pinLogin(handlers, "client")).status).toBe(429);
      for (let i = 0; i < 5; i++)
        expect((await invalid(`other-${i}`)).status).toBe(status);
      expect((await pinLogin(handlers, "new-client")).status).toBe(429);
      expect((await passwordLogin(handlers, "client")).status).toBe(200);
    },
  );

  test("oversized streams are cancelled without trusting Content-Length", async () => {
    const handlers = createAuthHandlers(BASE_CONFIG);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`{"pin":"${PIN}","extra":"`),
        );
        controller.enqueue(new Uint8Array(16 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await handlers.handlePinLogin(
      new Request("https://example.test/api/login/pin", {
        method: "POST",
        body,
      }),
      "client",
    );
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(response.headers.has("set-cookie")).toBe(false);
    await failPins(handlers, 9);
    expect((await pinLogin(handlers, "new-client")).status).toBe(429);
  });

  test.each(["correct PIN", "wrong PIN", "malformed JSON"])(
    "a slow %s cannot bypass or extend global cooldown after its body resolves",
    async (mode) => {
      jest.useFakeTimers({ now: NOW });
      try {
        const handlers = createAuthHandlers(BASE_CONFIG);
        const slow = slowRequest();
        const pending = handlers.handlePinLogin(slow.request, "slow-client");
        await failPins(handlers, 10);
        jest.advanceTimersByTime(1_000);
        slow.finish(
          mode === "malformed JSON"
            ? "{"
            : JSON.stringify({ pin: mode === "correct PIN" ? PIN : "000000" }),
        );
        const response = await pending;
        expect(response.status).toBe(429);
        expect(response.headers.get("retry-after")).toBe("3599");
        expect(response.headers.has("set-cookie")).toBe(false);
        expect((await passwordLogin(handlers, "slow-client")).status).toBe(200);
        expect(
          (await pinLogin(handlers, "fresh-client")).headers.get("retry-after"),
        ).toBe("3599");
      } finally {
        jest.useRealTimers();
      }
    },
  );

  test("an in-flight correct PIN cannot bypass a new per-IP cooldown", async () => {
    const handlers = createAuthHandlers(BASE_CONFIG);
    const slow = slowRequest();
    const pending = handlers.handlePinLogin(slow.request, "client");
    for (let i = 0; i < 5; i++)
      expect((await pinLogin(handlers, "client", "000000")).status).toBe(401);
    slow.finish(JSON.stringify({ pin: PIN }));
    const response = await pending;
    expect(response.status).toBe(429);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect((await pinLogin(handlers, "other-client")).status).toBe(200);
  });

  test.each([false, true])(
    "a slow PIN cannot authenticate with an expired IP record (replaced: %s)",
    async (replace) => {
      jest.useFakeTimers({ now: NOW });
      try {
        const handlers = createAuthHandlers(BASE_CONFIG);
        const slow = slowRequest();
        const pending = handlers.handlePinLogin(slow.request, "client");
        jest.advanceTimersByTime(300_000);
        if (replace) {
          for (let i = 0; i < 5; i++)
            expect((await pinLogin(handlers, "client", "000000")).status).toBe(
              401,
            );
        }
        slow.finish(JSON.stringify({ pin: PIN }));
        const response = await pending;
        expect(response.status).toBe(429);
        expect(response.headers.has("set-cookie")).toBe(false);
        expect((await passwordLogin(handlers, "client")).status).toBe(200);
      } finally {
        jest.useRealTimers();
      }
    },
  );
});

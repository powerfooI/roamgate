import { describe, expect, jest, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { createHmac } from "node:crypto";
import { Window } from "happy-dom";
import { createAuthHandlers, unauthenticatedLoginRedirect } from "./auth";
import { browserUrlFor, withLoginToken } from "../config/server-config";

const parserWindow = new Window({
  settings: {
    disableJavaScriptEvaluation: true,
    disableJavaScriptFileLoading: true,
    disableCSSFileLoading: true,
  },
});

function loginScript(markup: string): string {
  const document = new parserWindow.DOMParser().parseFromString(
    markup,
    "text/html",
  );
  const scripts = document.querySelectorAll("script:not([src])");
  if (scripts.length !== 1) throw new Error("Expected one inline login script");
  return scripts[0]!.textContent;
}

function cookieHeader(response: Response): string {
  const cookie = response.headers.get("set-cookie");
  if (!cookie) throw new Error("missing authentication cookie");
  return cookie.split(";", 1)[0];
}

describe("request authentication boundaries", () => {
  test("login script extraction is inert and respects HTML structure", () => {
    const source = 'throw new Error("keep < &amp; > as script text");';
    expect(
      loginScript(`
        <!-- <script>commented out</script> -->
        <script src="/external.js">external fallback</script>
        <SCRIPT data-note=">">${source}</SCRIPT>
      `),
    ).toBe(source);
    expect(() => loginScript("<p>No script</p>")).toThrow(
      "Expected one inline login script",
    );
    expect(() => loginScript("<script></script><script></script>")).toThrow(
      "Expected one inline login script",
    );
  });

  test("requires authentication by default", () => {
    const handlers = createAuthHandlers({ password: "test-login-secret" });
    expect(handlers.isAuthed(new Request("http://localhost/"))).toBe(false);
  });

  test("explicitly disabled development authentication needs no password or cookie", async () => {
    const handlers = createAuthHandlers({
      authRequired: false,
      password: "",
      urlLoginToken: "ignored-token",
    });
    expect(handlers.isAuthed(new Request("http://localhost/"))).toBe(true);
    const page = handlers.loginPage();
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/");
    expect(page.headers.get("cache-control")).toBe("no-store");
    const response = await handlers.handleLogin(
      new Request("http://localhost/api/login", { method: "POST" }),
      "127.0.0.1",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(
      handlers.handleTokenLogin(
        new Request("http://localhost/?token=ignored-token"),
        "127.0.0.1",
      ),
    ).toBeNull();
  });

  test("brands the login page as Roamgate", async () => {
    const handlers = createAuthHandlers({
      password: "fixed-test-password",
    });
    const html = await handlers.loginPage().text();

    expect(html).toContain("<title>Roamgate login</title>");
    expect(html).toContain('src="/roamgate-icon-192.png"');
    expect(html).toContain('<label for="pw">Password or token</label>');
    expect(html).toContain('autocomplete="current-password"');
    expect(html).toContain('role="alert"');
    expect(handlers.loginPage().headers.get("cache-control")).toBe("no-store");
    expect(html).not.toContain("herdr-gui");
  });

  test("login preserves same-origin notification launch fragments", async () => {
    const handlers = createAuthHandlers({
      password: "test-login-secret",
    });
    const html = await handlers.loginPage().text();
    const elements: Record<string, any> = {
      login: {},
      pw: { value: "test-login-secret", removeAttribute() {} },
      btn: {},
      err: {},
      reveal: {},
    };
    const location = {
      href: "/login",
      hash: "#roamgate-task=example-target",
      replace(value: string) {
        this.href = value;
      },
    };
    runInNewContext(loginScript(html), {
      document: { getElementById: (id: string) => elements[id] },
      location,
      fetch: async () => ({ ok: true }),
    });
    await elements.login.onsubmit({ preventDefault() {} });
    expect(location.href).toBe("/#roamgate-task=example-target");
  });

  test.each(["credentials", "server", "network", "throttle"])(
    "login recovers from %s failures and prevents duplicate submissions",
    async (failure) => {
      const handlers = createAuthHandlers({
        password: "test-login-secret",
      });
      const html = await handlers.loginPage().text();
      let focused = false;
      const attributes: Record<string, string> = {};
      const elements: Record<string, any> = {
        login: {},
        pw: {
          value: "test-login-secret",
          type: "password",
          focus() {
            focused = true;
          },
          removeAttribute(name: string) {
            delete attributes[name];
          },
          setAttribute(name: string, value: string) {
            attributes[name] = value;
          },
        },
        btn: {},
        err: {},
        reveal: { setAttribute() {} },
      };
      let calls = 0;
      const pending = Promise.withResolvers<Response>();
      runInNewContext(loginScript(html), {
        document: { getElementById: (id: string) => elements[id] },
        fetch: () => {
          calls++;
          return pending.promise;
        },
      });
      elements.reveal.onclick();
      expect(elements.pw.type).toBe("text");
      elements.reveal.onclick();
      expect(elements.pw.type).toBe("password");
      const submission = elements.login.onsubmit({ preventDefault() {} });
      expect(elements.btn.disabled).toBe(true);
      await elements.login.onsubmit({ preventDefault() {} });
      expect(calls).toBe(1);
      if (failure === "network") pending.reject(new Error("offline"));
      else
        pending.resolve(
          new Response(null, {
            status:
              failure === "credentials"
                ? 401
                : failure === "throttle"
                  ? 429
                  : 500,
            headers: { "retry-after": "300" },
          }),
        );
      await submission;
      expect(elements.btn.disabled).toBe(false);
      expect(elements.btn.textContent).toBe("Log in");
      expect(elements.err.textContent).toContain(
        failure === "network"
          ? "Cannot reach"
          : failure === "throttle"
            ? "Try again in 300 seconds"
            : failure === "server"
              ? "Unable to log in"
              : "Wrong password",
      );
      expect(elements.pw.value).toBe(
        failure === "credentials" ? "" : "test-login-secret",
      );
      expect(focused).toBe(failure === "credentials");
      if (failure === "credentials")
        expect(attributes["aria-invalid"]).toBe("true");
      else expect(attributes["aria-invalid"]).toBeUndefined();
    },
  );

  test("does not derive authorization from reverse-proxy authorities", async () => {
    const handlers = createAuthHandlers({
      password: "fixed-test-password",
    });
    const login = await handlers.handleLogin(
      new Request("http://upstream.example/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "fixed-test-password" }),
      }),
      "127.0.0.1",
    );
    const proxiedRequest = new Request("http://upstream.example/ws", {
      headers: {
        cookie: cookieHeader(login),
        origin: "https://dashboard.example.com",
      },
    });

    expect(handlers.isAuthed(proxiedRequest)).toBe(true);
  });

  test.each([false, true])(
    "sets Secure for both login paths only with native TLS (%s)",
    async (secureCookies) => {
      const handlers = createAuthHandlers({
        password: "test-login-secret",
        urlLoginToken: "test-login-secret",
        secureCookies,
      });
      const login = await handlers.handleLogin(
        new Request("https://example.test/api/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: "test-login-secret" }),
        }),
        "127.0.0.1",
      );
      const token = handlers.handleTokenLogin(
        new Request("https://example.test/?token=test-login-secret"),
        "127.0.0.1",
      )!;
      for (const response of [login, token]) {
        const cookie = response.headers.get("set-cookie")!;
        expect(cookie.includes("; Secure")).toBe(secureCookies);
        expect(cookie).toContain("HttpOnly; SameSite=Lax");
        expect(
          handlers.isAuthed(
            new Request("https://example.test/", {
              headers: { cookie: cookieHeader(response) },
            }),
          ),
        ).toBe(true);
      }
    },
  );

  test("redirects unauthenticated HTML requests with a relative location", () => {
    const response = unauthenticatedLoginRedirect();

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login");
  });
});

describe("login attempt limits", () => {
  test.each(["password", "URL token"])(
    "%s shares IP rate limits, clears failures on success and expires cooldowns",
    async (mode) => {
      jest.useFakeTimers({ now: 1_700_000_000_000 });
      try {
        const handlers = createAuthHandlers({
          password: "test-login-secret",
          urlLoginToken: "test-login-secret",
        });
        const login = async (
          credential = "test-login-secret",
          ip = "192.0.2.1",
        ) =>
          mode === "password"
            ? handlers.handleLogin(
                new Request("http://example.test/api/login", {
                  method: "POST",
                  body: JSON.stringify({ password: credential }),
                }),
                ip,
              )
            : handlers.handleTokenLogin(
                new Request(`http://example.test/?token=${credential}`),
                ip,
              )!;
        const invalidStatus = mode === "password" ? 401 : 303;
        for (let i = 0; i < 4; i++)
          expect((await login("wrong")).status).toBe(invalidStatus);
        const authenticated = cookieHeader(await login());
        for (let i = 0; i < 5; i++)
          expect((await login("wrong")).status).toBe(invalidStatus);
        const blocked = await login();
        expect(blocked.status).toBe(429);
        expect(blocked.headers.get("retry-after")).toBe("300");
        expect(blocked.headers.get("cache-control")).toBe("no-store");
        expect(blocked.headers.has("set-cookie")).toBe(false);
        expect(
          handlers.isAuthed(
            new Request("http://example.test/", {
              headers: { cookie: authenticated },
            }),
          ),
        ).toBe(true);
        expect((await login("test-login-secret", "192.0.2.2")).status).toBe(
          mode === "password" ? 200 : 303,
        );
        // Password and URL-token entry points cannot bypass each other's cooldown.
        const otherEntry =
          mode === "password"
            ? handlers.handleTokenLogin(
                new Request("http://example.test/?token=test-login-secret"),
                "192.0.2.1",
              )!
            : await handlers.handleLogin(
                new Request("http://example.test/api/login", {
                  method: "POST",
                  body: JSON.stringify({ password: "test-login-secret" }),
                }),
                "192.0.2.1",
              );
        expect(otherEntry.status).toBe(429);
        jest.advanceTimersByTime(299_999);
        expect((await login()).headers.get("retry-after")).toBe("1");
        jest.advanceTimersByTime(1);
        expect((await login()).status).toBe(mode === "password" ? 200 : 303);

        for (let i = 0; i < 20; i++)
          expect((await login("test-login-secret", "192.0.2.3")).status).toBe(
            mode === "password" ? 200 : 303,
          );
        expect(
          (await login("test-login-secret", "192.0.2.3")).headers.get(
            "retry-after",
          ),
        ).toBe("60");
        jest.advanceTimersByTime(59_999);
        expect((await login("test-login-secret", "192.0.2.3")).status).toBe(
          429,
        );
        jest.advanceTimersByTime(1);
        expect((await login("test-login-secret", "192.0.2.3")).status).toBe(
          mode === "password" ? 200 : 303,
        );
      } finally {
        jest.useRealTimers();
      }
    },
  );

  test("reserves concurrent attempts before reading JSON and counts malformed failures", async () => {
    const handlers = createAuthHandlers({ password: "test-login-secret" });
    const request = (body: string, ip: string) =>
      handlers.handleLogin(
        new Request("http://example.test/api/login", { method: "POST", body }),
        ip,
      );
    const statuses = await Promise.all(
      Array.from({ length: 25 }, () =>
        request(
          JSON.stringify({ password: "test-login-secret" }),
          "192.0.2.1",
        ).then((r) => r.status),
      ),
    );
    expect(statuses.filter((status) => status === 200)).toHaveLength(20);
    expect(statuses.filter((status) => status === 429)).toHaveLength(5);
    for (let i = 0; i < 5; i++)
      expect((await request("invalid json", "192.0.2.2")).status).toBe(400);
    expect(
      (
        await request(
          JSON.stringify({ password: "test-login-secret" }),
          "192.0.2.2",
        )
      ).status,
    ).toBe(429);
  });

  test("bounds IP state without evicting cooldowns and reclaims expired entries", async () => {
    jest.useFakeTimers({ now: 1_700_000_000_000 });
    try {
      const handlers = createAuthHandlers({
        password: "test-login-secret",
        urlLoginToken: "test-login-secret",
      });
      const login = (ip: string) =>
        handlers.handleTokenLogin(
          new Request("http://example.test/?token=wrong"),
          ip,
        )!;
      for (let i = 0; i < 5; i++) expect(login("blocked").status).toBe(303);
      for (let i = 1; i < 4096; i++) expect(login(`ip-${i}`).status).toBe(303);
      expect(login("new-ip").status).toBe(429);
      expect(login("blocked").status).toBe(429);
      jest.advanceTimersByTime(300_000);
      expect(login("new-ip").status).toBe(303);
    } finally {
      jest.useRealTimers();
    }
  });

  test("rejects oversized streamed JSON and cancels reading without Content-Length", async () => {
    const handlers = createAuthHandlers({ password: "test-login-secret" });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"password":"'));
        controller.enqueue(new Uint8Array(16 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await handlers.handleLogin(
      new Request("http://example.test/api/login", { method: "POST", body }),
      "192.0.2.1",
    );
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(response.headers.has("set-cookie")).toBe(false);
  });

  test("slow login bodies cannot bypass a replaced IP record's cooldown", async () => {
    jest.useFakeTimers({ now: 1_700_000_000_000 });
    try {
      const handlers = createAuthHandlers({ password: "test-login-secret" });
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
      });
      const pending = handlers.handleLogin(
        new Request("http://example.test/api/login", { method: "POST", body }),
        "192.0.2.1",
      );
      jest.advanceTimersByTime(300_000);
      for (let i = 0; i < 5; i++) {
        expect(
          (
            await handlers.handleLogin(
              new Request("http://example.test/api/login", {
                method: "POST",
                body: JSON.stringify({ password: "wrong" }),
              }),
              "192.0.2.1",
            )
          ).status,
        ).toBe(401);
      }
      controller.enqueue(
        new TextEncoder().encode(
          JSON.stringify({ password: "test-login-secret" }),
        ),
      );
      controller.close();
      const response = await pending;
      expect(response.status).toBe(429);
      expect(response.headers.has("set-cookie")).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test.each(["wrong password", "malformed JSON"])(
    "a slow %s finishing after cooldown starts a fresh failure count",
    async (failure) => {
      jest.useFakeTimers({ now: 1_700_000_000_000 });
      try {
        const handlers = createAuthHandlers({ password: "test-login-secret" });
        const login = (body: string | ReadableStream<Uint8Array>) =>
          handlers.handleLogin(
            new Request("http://example.test/api/login", {
              method: "POST",
              body,
            }),
            "192.0.2.1",
          );
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const pending = login(
          new ReadableStream<Uint8Array>({
            start(value) {
              controller = value;
            },
          }),
        );
        for (let i = 0; i < 5; i++)
          expect(
            (await login(JSON.stringify({ password: "wrong" }))).status,
          ).toBe(401);
        // Keep the same IP record alive without moving its cooldown deadline.
        jest.advanceTimersByTime(299_999);
        expect(
          (await login(JSON.stringify({ password: "test-login-secret" })))
            .status,
        ).toBe(429);
        jest.advanceTimersByTime(1);
        controller.enqueue(
          new TextEncoder().encode(
            failure === "wrong password"
              ? JSON.stringify({ password: "wrong" })
              : "invalid json",
          ),
        );
        controller.close();
        const response = await pending;
        expect(response.status).toBe(failure === "wrong password" ? 401 : 400);
        expect(response.headers.has("set-cookie")).toBe(false);
        expect(
          (await login(JSON.stringify({ password: "test-login-secret" })))
            .status,
        ).toBe(200);
      } finally {
        jest.useRealTimers();
      }
    },
  );
});

describe("browser logout", () => {
  test.each(["password", "URL token"])(
    "%s reauthentication preserves the current cookie and its expiry",
    async (mode) => {
      const handlers = createAuthHandlers({
        password: "test-login-secret",
        urlLoginToken: "test-login-secret",
      });
      const login = async (cookie = "", credential = "test-login-secret") =>
        mode === "password"
          ? handlers.handleLogin(
              new Request("http://example.test/api/login", {
                method: "POST",
                headers: { cookie },
                body: JSON.stringify({ password: credential }),
              }),
              "127.0.0.1",
            )
          : handlers.handleTokenLogin(
              new Request(`http://example.test/?token=${credential}`, {
                headers: { cookie },
              }),
              "127.0.0.1",
            )!;
      const first = cookieHeader(await login());
      const otherBrowser = cookieHeader(await login());
      expect(otherBrowser).not.toBe(first);
      // No Set-Cookie means the browser retains both the token and original TTL.
      expect((await login(first)).headers.has("set-cookie")).toBe(false);
      expect((await login(first)).headers.has("set-cookie")).toBe(false);
      expect(
        handlers.isAuthed(
          new Request("http://example.test/", { headers: { cookie: first } }),
        ),
      ).toBe(true);
      const invalid = await login(first, "wrong");
      expect(invalid.headers.has("set-cookie")).toBe(false);
      if (mode === "password") expect(invalid.status).toBe(401);
      else expect(invalid.headers.get("location")).toBe("/login");
      const expiredPayload = Buffer.from(JSON.stringify({ exp: 0 })).toString(
        "base64url",
      );
      const expiredSignature = createHmac("sha256", "test-login-secret")
        .update(expiredPayload)
        .digest("hex");
      for (const cookie of [
        "herdr_auth=invalid",
        `herdr_auth=${expiredPayload}.${expiredSignature}`,
      ]) {
        const replaced = cookieHeader(await login(cookie));
        expect(replaced).not.toBe(cookie);
        expect(
          handlers.isAuthed(
            new Request("http://example.test/", {
              headers: { cookie: replaced },
            }),
          ),
        ).toBe(true);
      }
    },
  );

  test.each([false, true])(
    "expires the cookie with matching attributes (TLS %s)",
    async (secureCookies) => {
      const handlers = createAuthHandlers({
        password: "test-login-secret",
        secureCookies,
      });
      const login = () =>
        handlers.handleLogin(
          new Request("http://example.test/api/login", {
            method: "POST",
            body: JSON.stringify({ password: "test-login-secret" }),
          }),
          "127.0.0.1",
        );
      const first = cookieHeader(await login());
      const second = cookieHeader(await login());
      const logout = handlers.handleLogout(
        new Request("http://example.test/api/logout", {
          method: "POST",
          headers: { cookie: first, "x-roamgate-logout": "1" },
        }),
      );
      expect(logout.status).toBe(204);
      expect(logout.headers.get("cache-control")).toBe("no-store");
      expect(logout.headers.get("set-cookie")).toBe(
        `herdr_auth=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureCookies ? "; Secure" : ""}`,
      );
      expect(
        handlers.isAuthed(
          new Request("http://example.test/", {
            headers: { cookie: cookieHeader(logout) },
          }),
        ),
      ).toBe(false);
      expect(
        handlers.isAuthed(
          new Request("http://example.test/", { headers: { cookie: second } }),
        ),
      ).toBe(true);
      expect((await login()).status).toBe(200);
    },
  );

  test("rejects GET and cross-site logout, but allows retry without a cookie", () => {
    const handlers = createAuthHandlers({
      password: "test-login-secret",
    });
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const response = handlers.handleLogout(
        new Request("http://example.test/api/logout", { method }),
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      expect(response.headers.has("set-cookie")).toBe(false);
    }
    for (const headers of [
      new Headers(),
      new Headers({ "x-roamgate-logout": "1", "sec-fetch-site": "cross-site" }),
    ]) {
      const response = handlers.handleLogout(
        new Request("http://example.test/api/logout", {
          method: "POST",
          headers,
        }),
      );
      expect(response.status).toBe(403);
      expect(response.headers.has("set-cookie")).toBe(false);
    }
    const request = new Request("http://upstream.example/api/logout", {
      method: "POST",
      headers: { "x-roamgate-logout": "1", origin: "https://proxy.example" },
    });
    expect(handlers.handleLogout(request).status).toBe(204);
    expect(handlers.handleLogout(request).status).toBe(204);
  });
});

describe("generated token login", () => {
  test("exchanges a URL token for a signed cookie and strips it", () => {
    const handlers = createAuthHandlers({
      password: "generated-secret",
      urlLoginToken: "generated-secret",
    });
    const response = handlers.handleTokenLogin(
      new Request(
        "http://example.test/workspace?view=terminal&token=generated-secret",
      ),
      "127.0.0.1",
    );

    expect(response?.status).toBe(303);
    expect(response?.headers.get("location")).toBe("/workspace?view=terminal");
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(response?.headers.get("referrer-policy")).toBe("no-referrer");
    expect(
      handlers.isAuthed(
        new Request("http://example.test/", {
          headers: { cookie: cookieHeader(response!) },
        }),
      ),
    ).toBe(true);
  });

  test("removes an invalid token without creating a session", () => {
    const handlers = createAuthHandlers({
      password: "generated-secret",
      urlLoginToken: "generated-secret",
    });
    const response = handlers.handleTokenLogin(
      new Request("http://example.test/?token=wrong"),
      "127.0.0.1",
    );

    expect(response?.status).toBe(303);
    expect(response?.headers.get("location")).toBe("/login");
    expect(response?.headers.has("set-cookie")).toBe(false);
  });

  test("ignores token parameters when URL login is not enabled", () => {
    const handlers = createAuthHandlers({
      password: "fixed-test-password",
    });

    expect(
      handlers.handleTokenLogin(
        new Request("http://example.test/?token=fixed-test-password"),
        "127.0.0.1",
      ),
    ).toBeNull();
  });

  test("preserves fixed-test-password login behavior", async () => {
    const handlers = createAuthHandlers({
      password: "fixed-test-password",
    });
    const response = await handlers.handleLogin(
      new Request("http://example.test/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "fixed-test-password" }),
      }),
      "127.0.0.1",
    );

    expect(response.status).toBe(200);
    expect(
      handlers.isAuthed(
        new Request("http://example.test/", {
          headers: { cookie: cookieHeader(response) },
        }),
      ),
    ).toBe(true);
  });

  test("builds an encoded token URL for browser launch", () => {
    expect(withLoginToken(browserUrlFor("0.0.0.0", 8787), "secret token")).toBe(
      "http://localhost:8787/?token=secret+token",
    );
  });

  test("rejects an empty authentication secret", () => {
    expect(() =>
      createAuthHandlers({
        password: "",
      }),
    ).toThrow("at least 15 characters");
  });
});

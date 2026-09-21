import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { createHmac } from "node:crypto";
import { createAuthHandlers, unauthenticatedLoginRedirect } from "./auth";
import { browserUrlFor, withLoginToken } from "../config/server-config";

function cookieHeader(response: Response): string {
  const cookie = response.headers.get("set-cookie");
  if (!cookie) throw new Error("missing authentication cookie");
  return cookie.split(";", 1)[0];
}

describe("request authentication boundaries", () => {
  test("brands the login page as Roamgate", async () => {
    const handlers = createAuthHandlers({
      authRequired: true,
      password: "fixed-password",
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
      authRequired: true,
      password: "test-secret",
    });
    const html = await handlers.loginPage().text();
    const elements: Record<string, any> = {
      login: {},
      pw: { value: "test-secret", removeAttribute() {} },
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
    runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1]!, {
      document: { getElementById: (id: string) => elements[id] },
      location,
      fetch: async () => ({ ok: true }),
    });
    await elements.login.onsubmit({ preventDefault() {} });
    expect(location.href).toBe("/#roamgate-task=example-target");
  });

  test.each(["credentials", "server", "network"])(
    "login recovers from %s failures and prevents duplicate submissions",
    async (failure) => {
      const handlers = createAuthHandlers({
        authRequired: true,
        password: "secret",
      });
      const html = await handlers.loginPage().text();
      let focused = false;
      const attributes: Record<string, string> = {};
      const elements: Record<string, any> = {
        login: {},
        pw: {
          value: "secret",
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
      runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1]!, {
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
          new Response(null, { status: failure === "credentials" ? 401 : 500 }),
        );
      await submission;
      expect(elements.btn.disabled).toBe(false);
      expect(elements.btn.textContent).toBe("Log in");
      expect(elements.err.textContent).toContain(
        failure === "network"
          ? "Cannot reach"
          : failure === "server"
            ? "Unable to log in"
            : "Wrong password",
      );
      expect(elements.pw.value).toBe(failure === "credentials" ? "" : "secret");
      expect(focused).toBe(failure === "credentials");
      if (failure === "credentials")
        expect(attributes["aria-invalid"]).toBe("true");
      else expect(attributes["aria-invalid"]).toBeUndefined();
    },
  );

  test("does not derive authorization from reverse-proxy authorities", async () => {
    const handlers = createAuthHandlers({
      authRequired: true,
      password: "fixed-password",
    });
    const login = await handlers.handleLogin(
      new Request("http://upstream.example/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "fixed-password" }),
      }),
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
        authRequired: true,
        password: "test-secret",
        urlLoginToken: "test-secret",
        secureCookies,
      });
      const login = await handlers.handleLogin(
        new Request("https://example.test/api/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: "test-secret" }),
        }),
      );
      const token = handlers.handleTokenLogin(
        new Request("https://example.test/?token=test-secret"),
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

describe("browser logout", () => {
  test.each(["password", "URL token"])(
    "%s reauthentication preserves the current cookie and its expiry",
    async (mode) => {
      const handlers = createAuthHandlers({
        authRequired: true,
        password: "secret",
        urlLoginToken: "secret",
      });
      const login = async (cookie = "", credential = "secret") =>
        mode === "password"
          ? handlers.handleLogin(
              new Request("http://example.test/api/login", {
                method: "POST",
                headers: { cookie },
                body: JSON.stringify({ password: credential }),
              }),
            )
          : handlers.handleTokenLogin(
              new Request(`http://example.test/?token=${credential}`, {
                headers: { cookie },
              }),
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
      const expiredSignature = createHmac("sha256", "secret")
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
        authRequired: true,
        password: "secret",
        secureCookies,
      });
      const login = () =>
        handlers.handleLogin(
          new Request("http://example.test/api/login", {
            method: "POST",
            body: JSON.stringify({ password: "secret" }),
          }),
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
      authRequired: true,
      password: "secret",
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
      authRequired: true,
      password: "generated-secret",
      urlLoginToken: "generated-secret",
    });
    const response = handlers.handleTokenLogin(
      new Request(
        "http://example.test/workspace?view=terminal&token=generated-secret",
      ),
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
      authRequired: true,
      password: "generated-secret",
      urlLoginToken: "generated-secret",
    });
    const response = handlers.handleTokenLogin(
      new Request("http://example.test/?token=wrong"),
    );

    expect(response?.status).toBe(303);
    expect(response?.headers.get("location")).toBe("/login");
    expect(response?.headers.has("set-cookie")).toBe(false);
  });

  test("ignores token parameters when URL login is not enabled", () => {
    const handlers = createAuthHandlers({
      authRequired: true,
      password: "fixed-password",
    });

    expect(
      handlers.handleTokenLogin(
        new Request("http://example.test/?token=fixed-password"),
      ),
    ).toBeNull();
  });

  test("preserves fixed-password login behavior", async () => {
    const handlers = createAuthHandlers({
      authRequired: true,
      password: "fixed-password",
    });
    const response = await handlers.handleLogin(
      new Request("http://example.test/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "fixed-password" }),
      }),
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
        authRequired: true,
        password: "",
      }),
    ).toThrow("authentication requires a non-empty signing secret");
  });
});

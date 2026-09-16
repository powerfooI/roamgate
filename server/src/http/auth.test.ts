import { describe, expect, test } from "bun:test";
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
    expect(html).toContain("<h2>▦ Roamgate</h2>");
    expect(html).not.toContain("herdr-gui");
  });

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

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { LOGIN_HTML } from "./login-page";

const AUTH_COOKIE = "herdr_auth";
const AUTH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value: string) {
  const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  return Buffer.from(
    padded.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  ).toString("utf8");
}

export function createAuthHandlers(args: {
  authRequired: boolean;
  password: string;
  urlLoginToken?: string;
  secureCookies?: boolean;
}) {
  if (args.authRequired && !args.password) {
    throw new Error("authentication requires a non-empty signing secret");
  }

  function parseCookie(header: string | null, name: string): string | null {
    if (!header) return null;
    for (const part of header.split(";")) {
      const [key, ...rest] = part.trim().split("=");
      if (key !== name) continue;
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return null;
      }
    }
    return null;
  }

  function sign(payload: string): string {
    return createHmac("sha256", args.password).update(payload).digest("hex");
  }

  function signedToken(): string {
    const now = Math.floor(Date.now() / 1000);
    const payload = base64UrlEncode(
      JSON.stringify({
        iat: now,
        exp: now + AUTH_TOKEN_TTL_SECONDS,
        nonce: randomBytes(16).toString("hex"),
      }),
    );
    return `${payload}.${sign(payload)}`;
  }

  function authCookieHeaders(req: Request): Record<string, string> {
    // Keep live tabs on the same session token without extending its expiry.
    if (isAuthed(req)) return {};
    return {
      "set-cookie": `${AUTH_COOKIE}=${signedToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${AUTH_TOKEN_TTL_SECONDS}${args.secureCookies ? "; Secure" : ""}`,
    };
  }

  function secretsEqual(actual: string, expected: string): boolean {
    const actualBuffer = Buffer.from(actual, "utf8");
    const expectedBuffer = Buffer.from(expected, "utf8");
    return (
      actualBuffer.length === expectedBuffer.length &&
      timingSafeEqual(actualBuffer, expectedBuffer)
    );
  }

  function isValidSignedToken(token: string): boolean {
    const [payload, signature, ...extra] = token.split(".");
    if (!payload || !signature || extra.length > 0) return false;
    const expected = sign(payload);
    const actualBuffer = Buffer.from(signature, "hex");
    const expectedBuffer = Buffer.from(expected, "hex");
    if (actualBuffer.length !== expectedBuffer.length) return false;
    if (!timingSafeEqual(actualBuffer, expectedBuffer)) return false;
    try {
      const decoded = JSON.parse(base64UrlDecode(payload)) as { exp?: unknown };
      return (
        typeof decoded.exp === "number" &&
        decoded.exp > Math.floor(Date.now() / 1000)
      );
    } catch {
      return false;
    }
  }

  function sessionToken(req: Request): string | null {
    return parseCookie(req.headers.get("cookie"), AUTH_COOKIE);
  }

  function isAuthed(req: Request): boolean {
    if (!args.authRequired) return true;
    const token = sessionToken(req);
    return token !== null && isValidSignedToken(token);
  }

  function handleLogout(req: Request): Response {
    if (req.method !== "POST") {
      return new Response("method not allowed", {
        status: 405,
        headers: { allow: "POST" },
      });
    }
    // Custom headers require a CORS preflight; the bridge grants no CORS access.
    // Unlike an Origin comparison, this also works behind reverse proxies.
    if (
      req.headers.get("x-roamgate-logout") !== "1" ||
      req.headers.get("sec-fetch-site") === "cross-site"
    ) {
      return new Response("forbidden", { status: 403 });
    }
    return new Response(null, {
      status: 204,
      headers: {
        "set-cookie": `${AUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${args.secureCookies ? "; Secure" : ""}`,
        "cache-control": "no-store",
      },
    });
  }

  function handleTokenLogin(req: Request): Response | null {
    if (!args.authRequired || !args.urlLoginToken || req.method !== "GET") {
      return null;
    }
    // pi-lens-ignore: unchecked-throwing-call
    const url = new URL(req.url);
    const suppliedToken = url.searchParams.get("token");
    if (suppliedToken === null) return null;
    url.searchParams.delete("token");

    const valid = secretsEqual(suppliedToken, args.urlLoginToken);
    const location = valid ? `${url.pathname}${url.search}` : "/login";
    return new Response(null, {
      status: 303,
      headers: {
        location,
        ...(valid ? authCookieHeaders(req) : {}),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }

  async function handleLogin(req: Request): Promise<Response> {
    if (!args.authRequired) {
      return Response.json({ ok: true, note: "auth not required" });
    }
    let body: any;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "bad request" }, { status: 400 });
    }
    if (
      typeof body?.password !== "string" ||
      !secretsEqual(body.password, args.password)
    ) {
      return Response.json({ error: "wrong password" }, { status: 401 });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...authCookieHeaders(req),
      },
    });
  }

  function loginPage(): Response {
    return new Response(LOGIN_HTML, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }

  return {
    isAuthed,
    sessionToken,
    handleTokenLogin,
    handleLogin,
    handleLogout,
    loginPage,
  };
}

export function unauthenticatedLoginRedirect(): Response {
  // Use a relative Location so reverse proxies preserve the public origin
  // instead of leaking the internal upstream host. Intentionally ignores
  // request URLs and forwarded headers.
  return new Response(null, {
    status: 302,
    headers: { location: "/login" },
  });
}

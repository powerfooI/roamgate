import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  assertValidAuthPassword,
  assertValidAuthPin,
} from "../config/auth-token";
import { readJsonBody } from "./json-body";
import { renderLoginPage } from "./login-page";

const AUTH_COOKIE = "herdr_auth";
const AUTH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 20;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_COOLDOWN_MS = 5 * 60_000;
const LOGIN_MAX_IPS = 4096;
const LOGIN_MAX_BODY_BYTES = 16 * 1024;
const PIN_MAX_FAILURES = 10;
const PIN_COOLDOWN_MS = 60 * 60_000;

interface LoginAttempts {
  count: number;
  failures: number;
  windowEndsAt: number;
  blockedUntil: number;
  expiresAt: number;
}

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
  authRequired?: boolean;
  password: string;
  sessionSecret: string;
  pin?: string;
  urlLoginToken?: string;
  secureCookies?: boolean;
}) {
  const authRequired = args.authRequired ?? true;
  if (authRequired) {
    assertValidAuthPassword(args.password);
    if (!/^[a-f0-9]{64}$/.test(args.sessionSecret)) {
      throw new Error(
        "Authentication requires a 256-bit session signing secret.",
      );
    }
  }
  if (args.pin !== undefined) assertValidAuthPin(args.pin);
  // ponytail: process-local IP limits; use shared storage for multiple replicas.
  const loginAttempts = new Map<string, LoginAttempts>();
  // PIN throttling must never consume the password/token recovery budget.
  const pinAttempts = new Map<string, LoginAttempts>();
  let pinFailures = 0;
  let pinBlockedUntil = 0;

  function checkPinCooldown(): Response | null {
    const now = Date.now();
    if (pinBlockedUntil > now) return tooManyAttempts(pinBlockedUntil - now);
    if (pinBlockedUntil) {
      pinFailures = 0;
      pinBlockedUntil = 0;
    }
    return null;
  }

  function failPinLogin() {
    if (++pinFailures >= PIN_MAX_FAILURES) {
      pinBlockedUntil = Date.now() + PIN_COOLDOWN_MS;
    }
  }

  function tooManyAttempts(waitMs: number): Response {
    return Response.json(
      { error: "too many login attempts" },
      {
        status: 429,
        headers: {
          "retry-after": String(Math.max(1, Math.ceil(waitMs / 1000))),
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        },
      },
    );
  }

  function checkCooldown(
    attempts: LoginAttempts,
    now: number,
  ): Response | null {
    if (attempts.blockedUntil > now) {
      return tooManyAttempts(attempts.blockedUntil - now);
    }
    if (attempts.blockedUntil) {
      attempts.failures = 0;
      attempts.blockedUntil = 0;
    }
    return null;
  }

  function beginLogin(
    ip: string,
    records = loginAttempts,
  ): LoginAttempts | Response {
    const now = Date.now();
    for (const [address, attempts] of records) {
      if (attempts.expiresAt <= now) records.delete(address);
    }
    let attempts = records.get(ip);
    if (!attempts) {
      // Fail closed rather than evicting an IP's active cooldown.
      if (records.size >= LOGIN_MAX_IPS) {
        return tooManyAttempts(LOGIN_WINDOW_MS);
      }
      attempts = {
        count: 0,
        failures: 0,
        windowEndsAt: now + LOGIN_WINDOW_MS,
        blockedUntil: 0,
        expiresAt: now + LOGIN_COOLDOWN_MS,
      };
      records.set(ip, attempts);
    }
    attempts.expiresAt = now + LOGIN_COOLDOWN_MS;
    const cooldown = checkCooldown(attempts, now);
    if (cooldown) return cooldown;
    if (attempts.windowEndsAt <= now) {
      attempts.count = 0;
      attempts.windowEndsAt = now + LOGIN_WINDOW_MS;
    }
    if (attempts.count >= LOGIN_MAX_ATTEMPTS) {
      return tooManyAttempts(attempts.windowEndsAt - now);
    }
    attempts.count++;
    return attempts;
  }

  function failLogin(attempts: LoginAttempts) {
    attempts.failures++;
    if (attempts.failures >= LOGIN_MAX_FAILURES) {
      attempts.blockedUntil = Date.now() + LOGIN_COOLDOWN_MS;
      attempts.expiresAt = attempts.blockedUntil;
    }
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
    return createHmac("sha256", Buffer.from(args.sessionSecret, "hex"))
      .update(payload)
      .digest("hex");
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
    if (!authRequired) return true;
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

  function handleTokenLogin(req: Request, ip: string): Response | null {
    if (!authRequired || !args.urlLoginToken || req.method !== "GET") {
      return null;
    }
    // pi-lens-ignore: unchecked-throwing-call
    const url = new URL(req.url);
    const suppliedToken = url.searchParams.get("token");
    if (suppliedToken === null) return null;
    const attempts = beginLogin(ip);
    if (attempts instanceof Response) return attempts;
    url.searchParams.delete("token");

    const valid = secretsEqual(suppliedToken, args.urlLoginToken);
    if (valid) attempts.failures = 0;
    else failLogin(attempts);
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

  async function handleCredentialLogin(
    req: Request,
    ip: string,
    usePin: boolean,
  ): Promise<Response> {
    if (usePin && !args.pin) return new Response("not found", { status: 404 });
    if (!authRequired) return Response.json({ ok: true });
    if (usePin) {
      const cooldown = checkPinCooldown();
      if (cooldown) return cooldown;
    }
    const records = usePin ? pinAttempts : loginAttempts;
    const attempts = beginLogin(ip, records);
    if (attempts instanceof Response) return attempts;
    let body: any;
    let invalidBodyStatus = 0;
    try {
      body = await readJsonBody(req, LOGIN_MAX_BODY_BYTES);
    } catch (error) {
      invalidBodyStatus = error instanceof RangeError ? 413 : 400;
    }
    // A slow body must not authorize using an expired or replaced IP record.
    if (records.get(ip) !== attempts || attempts.expiresAt <= Date.now()) {
      return tooManyAttempts(LOGIN_WINDOW_MS);
    }
    const cooldown = checkCooldown(attempts, Date.now());
    if (cooldown) return cooldown;
    if (usePin) {
      const cooldown = checkPinCooldown();
      if (cooldown) return cooldown;
    }
    if (invalidBodyStatus) {
      failLogin(attempts);
      if (usePin) failPinLogin();
      return Response.json(
        {
          error:
            invalidBodyStatus === 413
              ? "request body too large"
              : "bad request",
        },
        { status: invalidBodyStatus },
      );
    }
    const supplied = usePin ? body?.pin : body?.password;
    const expected = usePin ? args.pin! : args.password;
    if (typeof supplied !== "string" || !secretsEqual(supplied, expected)) {
      failLogin(attempts);
      if (usePin) failPinLogin();
      return Response.json(
        { error: usePin ? "wrong PIN" : "wrong password" },
        { status: 401 },
      );
    }
    attempts.failures = 0;
    if (usePin) pinFailures = 0;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...authCookieHeaders(req),
      },
    });
  }

  function handleLogin(req: Request, ip: string): Promise<Response> {
    return handleCredentialLogin(req, ip, false);
  }

  function handlePinLogin(req: Request, ip: string): Promise<Response> {
    return handleCredentialLogin(req, ip, true);
  }

  function loginPage(): Response {
    if (!authRequired) {
      return new Response(null, {
        status: 302,
        headers: { location: "/", "cache-control": "no-store" },
      });
    }
    return new Response(renderLoginPage(Boolean(args.pin)), {
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
    handlePinLogin,
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

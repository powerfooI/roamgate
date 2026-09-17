import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const LOGIN_HTML = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Roamgate login</title>
<style>
  body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0f1115;color:#e6e8ee;font-family:-apple-system,Segoe UI,Roboto,sans-serif}
  .box{background:#171a21;border:1px solid #2a2f3a;border-radius:14px;padding:28px;width:300px}
  h2{margin:0 0 16px;font-size:16px}
  input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;
    border:1px solid #2a2f3a;background:#0c0e13;color:#e6e8ee;font-size:14px;outline:none}
  input:focus{border-color:#6ea8ff}
  button{margin-top:12px;width:100%;padding:10px;border-radius:8px;border:none;
    background:#3d7dff;color:#fff;font-size:14px;font-weight:600;cursor:pointer}
  .err{color:#ff9a9a;font-size:13px;margin-top:10px;min-height:18px}
</style></head>
<body><div class="box">
  <h2>▦ Roamgate</h2>
  <input id="pw" type="password" placeholder="password or token" autofocus />
  <button id="btn">Log in</button>
  <div class="err" id="err"></div>
</div>
<script>
  const pw=document.getElementById('pw'),btn=document.getElementById('btn'),err=document.getElementById('err');
  async function go(){
    err.textContent='';
    const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:pw.value})});
    if(r.ok){location.href='/'+location.hash;}else{err.textContent='Wrong password or token';pw.value='';pw.focus();}
  }
  btn.onclick=go; pw.onkeydown=e=>{if(e.key==='Enter')go()};
</script></body></html>`;

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

  function authCookie(): string {
    return `${AUTH_COOKIE}=${signedToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${AUTH_TOKEN_TTL_SECONDS}${args.secureCookies ? "; Secure" : ""}`;
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

  function isAuthed(req: Request): boolean {
    if (!args.authRequired) return true;
    const token = parseCookie(req.headers.get("cookie"), AUTH_COOKIE);
    return token !== null && isValidSignedToken(token);
  }

  function handleTokenLogin(req: Request): Response | null {
    if (!args.authRequired || !args.urlLoginToken || req.method !== "GET") {
      return null;
    }
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
        ...(valid ? { "set-cookie": authCookie() } : {}),
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
        "set-cookie": authCookie(),
      },
    });
  }

  function loginPage(): Response {
    return new Response(LOGIN_HTML, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  return { isAuthed, handleTokenLogin, handleLogin, loginPage };
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

import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const password = "logout-test-secret";

// Exercise the real HTTP router and socket cleanup, not a second test router.
async function withAuthServer(
  run: (base: string, sockets: WebSocket[]) => Promise<void>,
  environment: NodeJS.ProcessEnv = {},
) {
  const root = await mkdtemp(join(tmpdir(), "roamgate-logout-"));
  const sockets: WebSocket[] = [];
  const child = Bun.spawn([process.execPath, "server/src/index.ts"], {
    cwd: join(import.meta.dir, "../../.."),
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOME: root,
      APPDATA: root,
      XDG_CONFIG_HOME: root,
      HOST: "127.0.0.1",
      PORT: "0",
      OPEN_BROWSER: "0",
      ROAMGATE_PASSWORD: password,
      ROAMGATE_CONNECTIONS_PATH: join(root, "connections.json"),
      HERDR_SOCKET_PATH: join(root, "missing-control.sock"),
      HERDR_CLIENT_SOCKET_PATH: join(root, "missing-render.sock"),
      HERDR_SSH_HOST: "",
      HERDR_SESSION: "",
      ROAMGATE_TLS_CERT: "",
      ROAMGATE_TLS_KEY: "",
      ...environment,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const errors = new Response(child.stderr).text();
  const ready = Promise.withResolvers<string>();
  const output = (async () => {
    let text = "";
    for await (const chunk of child.stdout) {
      text += new TextDecoder().decode(chunk);
      const port = text.match(/\bINFO bridge listening\b[^\r\n]*:(\d+)\b/)?.[1];
      if (port) ready.resolve(`http://127.0.0.1:${port}`);
    }
    ready.reject(
      new Error(`Server exited before listening: ${text}\n${await errors}`),
    );
  })();
  const deadline = setTimeout(
    () => ready.reject(new Error("Server startup timed out")),
    10_000,
  );
  try {
    const base = await ready.promise;
    clearTimeout(deadline);
    await run(base, sockets);
  } finally {
    clearTimeout(deadline);
    for (const socket of sockets) socket.close();
    child.kill();
    await child.exited;
    await output;
    await rm(root, { recursive: true, force: true });
  }
}

test("logout after reauthentication closes earlier and later tabs, not other browsers", async () => {
  await withAuthServer(async (base, sockets) => {
    const request = (path: string, init?: RequestInit) =>
      fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(5000) });
    const login = async (cookie = "") => {
      const response = await request("/api/login", {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify({ password }),
      });
      expect(response.status).toBe(200);
      return response.headers.get("set-cookie")?.split(";", 1)[0] ?? cookie;
    };
    const first = await login();
    const second = await login();
    const connect = async (cookie: string) => {
      // Bun accepts custom handshake headers; lib.dom's constructor does not.
      const Socket = WebSocket as unknown as new (
        url: string,
        options: Bun.WebSocketOptions,
      ) => WebSocket;
      const ws = new Socket(base.replace("http:", "ws:") + "/ws", {
        headers: { cookie },
      });
      sockets.push(ws);
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("WebSocket hello timed out")),
          5000,
        );
        ws.onmessage = (event) => {
          if (!JSON.parse(String(event.data)).hello) return;
          clearTimeout(timeout);
          resolve();
        };
        ws.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("WebSocket failed"));
        };
      });
      return ws;
    };
    const a = await connect(first);
    const reauthenticated = await login(first);
    expect(reauthenticated).toBe(first);
    const sameBrowserTab = await connect(reauthenticated);
    const otherBrowser = await connect(second);
    const currentCookie = await login(reauthenticated);
    expect(currentCookie).toBe(first);
    const closures = [a, sameBrowserTab].map(
      (ws) =>
        new Promise<number>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Logout did not close socket")),
            5000,
          );
          ws.onclose = (event) => {
            clearTimeout(timeout);
            resolve(event.code);
          };
        }),
    );
    expect(
      (await request("/api/health", { headers: { cookie: first } })).status,
    ).toBe(200);
    expect(
      await (
        await request("/api/health", { headers: { cookie: first } })
      ).json(),
    ).toMatchObject({ auth_required: true });
    const page = await request("/login");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(await page.text()).toContain("/roamgate-icon-192.png");
    const logo = await request("/roamgate-icon-192.png");
    expect(logo.status).toBe(200);
    expect(logo.headers.get("content-type")).toBe("image/png");
    expect(
      (await request("/api/logout", { headers: { cookie: first } })).status,
    ).toBe(405);
    expect(
      (
        await request("/api/logout", {
          method: "POST",
          headers: { cookie: first },
        })
      ).status,
    ).toBe(403);
    expect(a.readyState).toBe(WebSocket.OPEN);
    const logout = await request("/api/logout", {
      method: "POST",
      headers: { cookie: currentCookie, "x-roamgate-logout": "1" },
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await Promise.all(closures)).toEqual([4001, 4001]);
    expect(otherBrowser.readyState).toBe(WebSocket.OPEN);
    expect((await request("/api/health")).status).toBe(401);
    expect(
      (await request("/api/health", { headers: { cookie: second } })).status,
    ).toBe(200);
    const redirect = await request("/", {
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    expect(redirect.headers.get("location")).toBe("/login");
    expect(await login()).not.toBe(first);
  });
}, 20_000);

test("loopback requires login and forged forwarding headers cannot evade login cooldown", async () => {
  await withAuthServer(async (base) => {
    expect(
      (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) }))
        .status,
    ).toBe(401);
    const redirect = await fetch(base, {
      signal: AbortSignal.timeout(5000),
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/login");
    for (let attempt = 0; attempt < 7; attempt++) {
      const response = await fetch(`${base}/api/login`, {
        signal: AbortSignal.timeout(5000),
        method: "POST",
        headers: {
          "x-forwarded-for": `192.0.2.${attempt + 1}`,
          "x-real-ip": `198.51.100.${attempt + 1}`,
        },
        body: JSON.stringify({ password: attempt === 6 ? password : "wrong" }),
      });
      expect(response.status).toBe(attempt < 5 ? 401 : 429);
      if (attempt >= 5) {
        expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
        expect(response.headers.get("set-cookie")).toBeNull();
      }
    }
  });
}, 20_000);

test("development loopback serves HTTP and WebSocket without credentials", async () => {
  await withAuthServer(
    async (base, sockets) => {
      const health = await fetch(`${base}/api/health`, {
        signal: AbortSignal.timeout(5000),
      });
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ auth_required: false });
      const page = await fetch(`${base}/login`, {
        signal: AbortSignal.timeout(5000),
        redirect: "manual",
      });
      expect(page.status).toBe(302);
      expect(page.headers.get("location")).toBe("/");
      expect(page.headers.get("cache-control")).toBe("no-store");
      const ws = new WebSocket(base.replace("http:", "ws:") + "/ws");
      sockets.push(ws);
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("WebSocket hello timed out")),
          5000,
        );
        ws.onmessage = (event) => {
          if (!JSON.parse(String(event.data)).hello) return;
          clearTimeout(timeout);
          resolve();
        };
        ws.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("WebSocket failed"));
        };
      });
    },
    { NODE_ENV: "development", ROAMGATE_PASSWORD: "" },
  );
}, 20_000);

test("development non-loopback binding still requires login", async () => {
  await withAuthServer(
    async (base) => {
      expect(
        (
          await fetch(`${base}/api/health`, {
            signal: AbortSignal.timeout(5000),
          })
        ).status,
      ).toBe(401);
    },
    { NODE_ENV: "development", HOST: "0.0.0.0" },
  );
}, 20_000);

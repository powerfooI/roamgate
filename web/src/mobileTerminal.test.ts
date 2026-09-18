import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  stopChrome,
  waitForChromePort,
  withBrowserDeadline,
} from "./browserChrome";

const chrome =
  Bun.env.CHROME_BIN ||
  (process.platform === "darwin" &&
  existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : Bun.which("google-chrome") || Bun.which("chromium"));

test.skipIf(!chrome).each([390, 320])(
  "mobile terminal trusted long press, endpoint handles, explicit input and frozen output (%dpx)",
  async (width) => {
    const dir = await mkdtemp(join(tmpdir(), "mobile-terminal-test-"));
    const assets = new Map<string, Blob>();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/")
          return new Response(
            '<head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/mobileTerminal.browser.css"></head><body><script type="module" src="/mobileTerminal.browser.js"></script></body>',
            { headers: { "Content-Type": "text/html" } },
          );
        const asset = assets.get(path);
        return asset
          ? new Response(asset)
          : new Response("Not found", { status: 404 });
      },
    });
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let socket: WebSocket | undefined;
    try {
      const build = await Bun.build({
        entrypoints: [join(import.meta.dir, "mobileTerminal.browser.tsx")],
        outdir: dir,
        target: "browser",
      });
      expect(build.success).toBe(true);
      for (const asset of build.outputs)
        assets.set(`/${basename(asset.path)}`, asset);
      child = Bun.spawn(
        [
          chrome!,
          "--headless",
          "--disable-gpu",
          "--remote-debugging-port=0",
          "--window-size=500,800",
          "--no-first-run",
          "--no-default-browser-check",
          `--user-data-dir=${join(dir, "profile")}`,
          "about:blank",
        ],
        { stdout: "ignore", stderr: Bun.file(join(dir, "browser.log")) },
      );
      const port = await waitForChromePort(
        child,
        join(dir, "profile"),
        join(dir, "browser.log"),
      );
      const targets = (await withBrowserDeadline(
        fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.timeout(10_000),
        }).then((response) => response.json()),
        "Chrome debugger discovery",
      )) as { type: string; webSocketDebuggerUrl: string }[];
      socket = new WebSocket(
        targets.find((target) => target.type === "page")!.webSocketDebuggerUrl,
      );
      await withBrowserDeadline(
        new Promise<void>((resolve, reject) => {
          socket!.onopen = () => resolve();
          socket!.onerror = () => reject(new Error("CDP connection failed"));
          socket!.onclose = () => reject(new Error("CDP connection closed"));
        }),
        "CDP connection",
      );
      let id = 0;
      const pending = new Map<
        number,
        { resolve: (value: any) => void; reject: (error: Error) => void }
      >();
      socket.onclose = socket.onerror = () => {
        for (const request of pending.values())
          request.reject(new Error("CDP connection closed"));
        pending.clear();
      };
      socket.onmessage = (event) => {
        const response = JSON.parse(String(event.data));
        if (
          response.method === "Runtime.consoleAPICalled" &&
          response.params.type === "error"
        )
          console.error(JSON.stringify(response.params.args));
        if (response.method === "Runtime.exceptionThrown")
          console.error(JSON.stringify(response.params));
        const request = pending.get(response.id);
        if (!request) return;
        pending.delete(response.id);
        if (response.error)
          request.reject(new Error(JSON.stringify(response.error)));
        else request.resolve(response.result);
      };
      const cdp = (
        method: string,
        params: Record<string, unknown> = {},
      ): Promise<any> => {
        const requestId = ++id;
        return withBrowserDeadline(
          new Promise((resolve, reject) => {
            pending.set(requestId, { resolve, reject });
            socket!.send(JSON.stringify({ id: requestId, method, params }));
          }),
          `CDP ${method}`,
        ).finally(() => pending.delete(requestId));
      };
      const evaluate = async (expression: string) => {
        const result = await cdp("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        if (result.exceptionDetails)
          throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
      };
      await cdp("Emulation.setDeviceMetricsOverride", {
        width,
        height: 800,
        deviceScaleFactor: 2,
        mobile: true,
      });
      await cdp("Emulation.setTouchEmulationEnabled", {
        enabled: true,
        maxTouchPoints: 1,
      });
      await cdp("Runtime.enable");
      if (width === 320) {
        await cdp("Emulation.setUserAgentOverride", {
          userAgent:
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
          platform: "Linux x86_64",
        });
      }
      await cdp("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
      for (let i = 0; i < 200; i++) {
        if (await evaluate("!!window.mobileTerminalTest")) break;
        await Bun.sleep(25);
      }
      const run = (method: string) =>
        evaluate(`mobileTerminalTest.${method}()`);
      await run("ready");
      const point = (selector: string) =>
        evaluate(`mobileTerminalTest.point(${JSON.stringify(selector)})`);
      const touch = async (type: string, x: number, y: number) =>
        cdp("Input.dispatchTouchEvent", {
          type,
          touchPoints:
            type === "touchEnd"
              ? []
              : [{ x, y, radiusX: 1, radiusY: 1, force: 1, id: 1 }],
        });
      const tap = async (selector: string) => {
        const { x, y } = await point(selector);
        await touch("touchStart", x, y);
        await touch("touchEnd", x, y);
      };
      await tap(".xterm-screen");
      await run("reading");
      await cdp("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        deltaX: 0,
        deltaY: 100,
        modifiers: 6,
        ...(await point(".xterm-screen")),
      });
      await run("readingWheel");
      await tap('button[aria-label="Open device keyboard"]');
      await run("typing");
      await cdp("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        deltaX: 0,
        deltaY: 100,
        modifiers: 6,
        ...(await point(".xterm-screen")),
      });
      await run("inputWheel");
      const { x, y } = await point(".xterm-screen");
      await touch("touchStart", x, y + 120);
      await touch("touchMove", x, y + 80);
      await touch("touchMove", x, y + 20);
      await touch("touchEnd", x, y + 20);
      await run("scrolled");
      await tap(".xterm-screen");
      await run("dismissed");
      await tap('button[aria-label="Open device keyboard"]');
      const word = await evaluate("mobileTerminalTest.cell(4, 0)");
      await touch("touchStart", word.x, word.y);
      await run("activate");
      await touch("touchEnd", word.x, word.y);
      await run("selection");
      for (const theme of ["light", "dark"]) {
        await evaluate(
          `document.documentElement.dataset.theme = ${JSON.stringify(theme)}`,
        );
        await evaluate("new Promise(resolve => setTimeout(resolve, 180))");
        const screenshot = await cdp("Page.captureScreenshot", {
          format: "png",
        });
        await Bun.write(
          join(dir, `selection-${theme}.png`),
          Buffer.from(screenshot.data, "base64"),
        );
      }
      await tap(".terminal-touch-selection-actions button");
      await run("copied");
      const drag = async (
        label: string,
        fromCol: number,
        col: number,
        expected: string,
      ) => {
        const start = await point(`button[aria-label="${label}"]`);
        const end = await evaluate(`mobileTerminalTest.cell(${col}, 0)`);
        end.y = start.y;
        const from = await evaluate(`mobileTerminalTest.cell(${fromCol}, 0)`);
        end.x += start.x - from.x;
        await touch("touchStart", start.x, start.y);
        await touch("touchMove", end.x, end.y);
        await touch("touchEnd", end.x, end.y);
        await evaluate(
          `mobileTerminalTest.dragged(${JSON.stringify(expected)})`,
        );
      };
      await drag("Selection start", 2, 0, "$ stable");
      await drag("Selection end", 8, 15, "$ stable output");
      await drag("Selection start", 0, 16, "");
      await drag("Selection start", 15, 9, "output");
      await run("comment");
      await run("regressions");
      await run("hybrid");
      await tap(".xterm-screen");
      await run("compatibilityMouse");
      await tap('button[aria-label="Open device keyboard"]');
      await tap(".xterm-screen");
      await run("compatibilityMouse");
      const mousePoint = await point(".xterm-screen");
      await cdp("Input.dispatchMouseEvent", {
        type: "mousePressed",
        button: "left",
        clickCount: 1,
        ...mousePoint,
      });
      await cdp("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        button: "left",
        clickCount: 1,
        ...mousePoint,
      });
      await run("fineMouse");
      await run("restoreMedia");
      await cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
      await cdp("Emulation.setDeviceMetricsOverride", {
        width: 1300,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
      expect(await run("desktop")).toEqual([]);
    } finally {
      socket?.close();
      server.stop(true);
      await stopChrome(child);
      console.log(`Mobile terminal browser artifacts: ${dir}`);
    }
  },
  45_000,
);

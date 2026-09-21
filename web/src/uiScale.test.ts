import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

test.skipIf(!chrome).each([
  [1300, 1, "uiScale", 800, 100],
  [500, 1.25, "uiScale", 800, 100],
  [1300, 1, "paneJump", 800, 100],
  [390, 1, "paneJump", 800, 100],
  [1300, 1, "taskPush", 800, 100],
  [390, 1, "taskPush", 800, 100],
  [1300, 1, "connectionProfiles", 800, 100],
  [390, 1, "connectionProfiles", 800, 100],
  [1300, 1, "configuration", 800, 100],
  [390, 1.25, "configuration", 800, 100],
  [320, 1.5, "configuration", 800, 100],
  [320, 1.5, "configuration", 800, 150],
  [740, 1, "configuration", 360, 100],
  [1300, 1, "terminalLinks", 800, 100],
  [500, 1.25, "terminalLinks", 800, 100],
  [390, 1, "terminalLinks", 800, 100],
  [320, 1.5, "terminalLinks", 800, 100],
  [1300, 1, "terminalLinkProvider", 800, 100],
  [1300, 1, "diffViewer", 800, 100],
  [390, 1, "diffViewer", 800, 100],
])(
  "browser interactions preserve layout and input (width %d, DPR %d, %s, height %d, UI %d%%)",
  async (width, deviceScale, fixture, height, scale) => {
    const menuOnly =
      fixture === "configuration" && (height < 800 || scale > 100);
    const dir = await mkdtemp(join(tmpdir(), "ui-scale-test-"));
    const { promise, resolve } = Promise.withResolvers<unknown>();
    const assets = new Map<string, Blob>();
    const heldChunks = new Map<
      string,
      ReturnType<typeof Promise.withResolvers<void>>
    >();
    let cdp: (method: string, params?: Record<string, unknown>) => Promise<any>;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/result" && request.method === "POST") {
          resolve(await request.json());
          return new Response("ok");
        }
        if (path === "/input" && request.method === "POST") {
          const { method, params } = await request.json();
          await cdp(method, params);
          return new Response("ok");
        }
        const asset = assets.get(path);
        if (asset) {
          await heldChunks.get(path)?.promise;
          return new Response(asset);
        }
        if (path === "/")
          return new Response(
            `<head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/${fixture}.browser.css"></head><body><script type="module" src="/${fixture}.browser.js"></script></body>`,
            { headers: { "Content-Type": "text/html" } },
          );
        return new Response("Not found", { status: 404 });
      },
    });
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let socket: WebSocket | undefined;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    try {
      const build = await Bun.build({
        entrypoints: [
          join(
            import.meta.dir,
            `${fixture}.browser.${fixture === "terminalLinkProvider" ? "ts" : "tsx"}`,
          ),
        ],
        outdir: dir,
        target: "browser",
        splitting: true,
        plugins: [
          {
            name: "vite-raw-test-assets",
            setup(build) {
              build.onResolve({ filter: /\?raw$/ }, (args) => ({
                path: Bun.resolveSync(args.path.slice(0, -4), args.resolveDir),
                namespace: "raw-text",
              }));
              build.onLoad(
                { filter: /.*/, namespace: "raw-text" },
                async (args) => ({
                  contents: await readFile(args.path, "utf8"),
                  loader: "text",
                }),
              );
            },
          },
        ],
      });
      expect(build.success).toBe(true);
      for (const asset of build.outputs) {
        const path = `/${basename(asset.path)}`;
        assets.set(path, asset);
        if (
          fixture === "configuration" &&
          !menuOnly &&
          asset.kind === "chunk" &&
          /function (ConfigurationDialog|MobileLayoutDialog)\(/.test(
            await asset.text(),
          )
        )
          heldChunks.set(path, Promise.withResolvers<void>());
      }
      const errorOutput = join(dir, "browser.log");
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
        { stdout: "ignore", stderr: Bun.file(errorOutput) },
      );
      const port = await waitForChromePort(
        child,
        join(dir, "profile"),
        errorOutput,
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
        const request = pending.get(response.id);
        if (!request) return;
        pending.delete(response.id);
        if (response.error)
          request.reject(new Error(JSON.stringify(response.error)));
        else request.resolve(response.result);
      };
      cdp = (method, params = {}) => {
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
          returnByValue: true,
          awaitPromise: true,
        });
        if (result.exceptionDetails)
          throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
      };
      const waitFor = async (expression: string) => {
        for (let i = 0; i < 800; i++) {
          if (await evaluate(expression)) return;
          await Bun.sleep(25);
        }
        throw new Error(`Browser condition timed out: ${expression}`);
      };
      const key = async (value: string, code: number, shift = false) => {
        for (const type of ["keyDown", "keyUp"])
          await cdp("Input.dispatchKeyEvent", {
            type,
            key: value,
            windowsVirtualKeyCode: code,
            modifiers: shift ? 8 : 0,
          });
      };
      await cdp("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: deviceScale,
        mobile: fixture === "terminalLinks" && width < 400,
      });
      if (
        (fixture === "terminalLinks" && width < 400) ||
        (fixture === "configuration" && width <= 768)
      )
        await cdp("Emulation.setTouchEmulationEnabled", {
          enabled: true,
          maxTouchPoints: 5,
        });
      const url = new URL(server.url);
      if (menuOnly) {
        url.searchParams.set("menuOnly", "1");
        url.searchParams.set("scale", String(scale));
      }
      await cdp("Page.navigate", { url: url.href });
      // Navigation can acknowledge before the new document's viewport is parsed.
      await waitFor(
        `location.href === ${JSON.stringify(url.href)} && document.readyState !== "loading"`,
      );
      expect(await evaluate("innerWidth")).toBe(width);
      if (fixture === "configuration" && !menuOnly) {
        expect(heldChunks.size).toBe(2);
        for (const detail of [false, true]) {
          const selector = '[aria-label="Loading Configuration"]';
          await waitFor(`!!document.querySelector('${selector}')`);
          await waitFor(
            `document.querySelector('${selector}').contains(document.activeElement)`,
          );
          await key("Tab", 9);
          expect(
            await evaluate(
              `document.querySelector('${selector}').contains(document.activeElement)`,
            ),
          ).toBe(true);
          await key("Tab", 9, true);
          expect(
            await evaluate(
              `document.querySelector('${selector}').contains(document.activeElement)`,
            ),
          ).toBe(true);
          await key("Escape", 27);
          await waitFor(`!document.querySelector('${selector}')`);
          if (detail) {
            expect(
              await evaluate(
                'document.activeElement.textContent.includes("Layout")',
              ),
            ).toBe(true);
            await evaluate('configurationTest.click("Layout")');
          } else {
            await waitFor(
              'document.activeElement.getAttribute("aria-label") === "Menu"',
            );
            await evaluate(
              'configurationTest.click("Menu"); configurationTest.click("Configuration")',
            );
          }
          await waitFor(`!!document.querySelector('${selector}')`);
          const raceDismissal = width === 390;
          if (raceDismissal) {
            await evaluate("configurationTest.loadingRace = true");
            await evaluate(
              `Promise.all(document.querySelector('${selector}').getAnimations().map(a => a.finished))`,
            );
            const { x, y } = await evaluate(`(() => {
              const r = document.querySelector('${selector} .mobile-sheet-handle').getBoundingClientRect();
              return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            })()`);
            await cdp("Input.dispatchTouchEvent", {
              type: "touchStart",
              touchPoints: [{ x, y }],
            });
            for (let step = 1; step <= 4; step++) {
              await cdp("Input.dispatchTouchEvent", {
                type: "touchMove",
                touchPoints: [{ x, y: y + step * 16 }],
              });
              await evaluate(
                "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
              );
            }
            await cdp("Input.dispatchTouchEvent", {
              type: "touchEnd",
              touchPoints: [],
            });
            // Hold the accepted exit open until lazy resolution replaces its fallback.
            expect(
              await evaluate(`(() => {
              const exit = document.querySelector('${selector}').getAnimations().find(a => a.constructor.name === 'Animation');
              exit?.pause();
              return !!exit;
            })()`),
            ).toBe(true);
          }
          // Release the requested dialog only; its nested editor remains delayed.
          for (const [path, gate] of heldChunks) {
            const source = await assets.get(path)!.text();
            if (
              source.includes(
                `function ${detail ? "MobileLayoutDialog" : "ConfigurationDialog"}(`,
              )
            ) {
              gate.resolve();
              heldChunks.delete(path);
              break;
            }
          }
          await waitFor(`!document.querySelector('${selector}')`);
          if (raceDismissal) {
            const loadedSelector = detail
              ? '[aria-label="Layout Preferences"]'
              : ".configuration-modal";
            await waitFor(`!document.querySelector('${loadedSelector}')`);
            await waitFor(
              detail
                ? 'document.activeElement.textContent.includes("Layout")'
                : 'document.activeElement.getAttribute("aria-label") === "Menu"',
            );
            await evaluate(
              detail
                ? 'configurationTest.click("Layout")'
                : 'configurationTest.click("Menu"); configurationTest.click("Configuration")',
            );
            await waitFor(`!!document.querySelector('${loadedSelector}')`);
            await evaluate("configurationTest.loadingRace = false");
          }
        }
      }
      const deadline = new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Browser regression checks timed out")),
          fixture === "terminalLinks" && width < 400 ? 40000 : 30000,
        );
        timers.add(timer);
      });
      const failures = await Promise.race([
        promise,
        deadline,
        child.exited.then(async (code) => {
          throw new Error(
            `Browser exited (${code}): ${await readFile(errorOutput, "utf8")}`,
          );
        }),
      ]);
      expect(failures).toEqual([]);
    } finally {
      for (const timer of timers) clearTimeout(timer);
      for (const gate of heldChunks.values()) gate.resolve();
      socket?.close();
      server.stop(true);
      await stopChrome(child);
      await rm(dir, { recursive: true, force: true });
    }
  },
  45000,
);

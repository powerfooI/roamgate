import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const chrome =
  Bun.env.CHROME_BIN ||
  (process.platform === "darwin" &&
  existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : Bun.which("google-chrome") || Bun.which("chromium"));

for (const narrow of [false, true])
  test.skipIf(!chrome)(
    narrow
      ? "Terminal annotations preserve drafts and focus in a narrow viewport"
      : "App file preview navigation and terminal annotation UX preserve scoped drafts and focus",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "file-preview-navigation-"));
      const { promise, resolve } = Promise.withResolvers<unknown>();
      const assets = new Map<string, Blob>();
      const events: string[] = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const path = new URL(request.url).pathname;
          events.push(
            `${request.headers.has("x-fixture-self-check") ? "host" : "browser"} ${request.method} ${path}`,
          );
          if (path === "/result" && request.method === "POST") {
            resolve(await request.json());
            return new Response("ok");
          }
          if (path === "/event" && request.method === "POST") {
            events.push(await request.text());
            return new Response("ok");
          }
          const asset = assets.get(path);
          if (asset) return new Response(asset);
          if (path === "/") {
            return new Response(
              `<head><link rel="stylesheet" href="/filePreviewNavigation.browser.css"></head><body><script>
              const report = message => fetch('/event', {method: 'POST', body: message});
              report('page loaded');
              window.addEventListener('error', event => report('error: ' + event.message));
              window.addEventListener('unhandledrejection', event => report('rejection: ' + event.reason));
              </script><script type="module" src="/filePreviewNavigation.browser.js"></script></body>`,
              { headers: { "Content-Type": "text/html" } },
            );
          }
          return new Response("Not found", { status: 404 });
        },
      });
      let child: ReturnType<typeof Bun.spawn> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const build = await Bun.build({
          entrypoints: [
            join(import.meta.dir, "filePreviewNavigation.browser.tsx"),
          ],
          outdir: dir,
          target: "browser",
          plugins: [
            {
              name: "vite-raw-test-assets",
              setup(build) {
                build.onResolve({ filter: /\?raw$/ }, (args) => ({
                  path: Bun.resolveSync(
                    args.path.slice(0, -4),
                    args.resolveDir,
                  ),
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
        for (const asset of build.outputs)
          assets.set(`/${basename(asset.path)}`, asset);
        const errorOutput = join(dir, "browser.log");
        const browserUrl = `http://127.0.0.1:${server.port}/${narrow ? "?annotations-only" : ""}`;
        events.push(`server.url=${server.url.href}; browserUrl=${browserUrl}`);
        const selfCheck = await fetch(browserUrl, {
          headers: { "x-fixture-self-check": "1" },
        });
        events.push(`self-check status=${selfCheck.status}`);
        expect(selfCheck.status).toBe(200);
        child = Bun.spawn(
          [
            chrome!,
            "--headless=new",
            narrow ? "--window-size=390,844" : "--window-size=1280,900",
            "--disable-gpu",
            "--disable-background-networking",
            "--disable-component-update",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-sync",
            "--disable-default-apps",
            "--disable-extensions",
            "--metrics-recording-only",
            "--no-proxy-server",
            `--user-data-dir=${join(dir, "profile")}`,
            "--enable-logging=stderr",
            "--v=1",
            `--log-net-log=${join(dir, "netlog.json")}`,
            browserUrl,
          ],
          { stdout: "ignore", stderr: Bun.file(errorOutput) },
        );
        const failures = await Promise.race([
          promise,
          child.exited.then(async (code) => {
            throw new Error(
              `Browser exited (${code}): ${await readFile(errorOutput, "utf8")}`,
            );
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `File preview navigation checks timed out: ${events.join("; ")}`,
                  ),
                ),
              30_000,
            );
          }),
        ]);
        expect(failures).toEqual([]);
      } catch (error) {
        console.error(`Browser fixture evidence: ${dir}\n${events.join("\n")}`);
        throw error;
      } finally {
        clearTimeout(timer);
        if (child) {
          child.kill("SIGKILL");
          await Promise.race([
            child.exited,
            new Promise<never>((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    new Error("Fixture browser did not exit after SIGKILL"),
                  ),
                2_000,
              ),
            ),
          ]);
        }
        server.stop(true);
        await writeFile(join(dir, "events.log"), events.join("\n"));
        console.info(`Browser fixture evidence: ${dir}`);
      }
    },
    45_000,
  );

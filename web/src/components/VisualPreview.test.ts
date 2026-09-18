import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { stopChrome } from "../browserChrome";

const chrome =
  Bun.env.CHROME_BIN ||
  (process.platform === "darwin" &&
  existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : Bun.which("google-chrome") || Bun.which("chromium"));

for (const fixture of [
  "VisualPreview",
  "AgentHistoryDrawer",
  "OverlayScrollbarLayer",
  "ShellStyles",
]) {
  test.skipIf(!chrome)(
    `${fixture} browser layout and interaction regressions`,
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "visual-preview-test-"));
      const { promise, resolve } = Promise.withResolvers<unknown>();
      const assets = new Map<string, Blob>();
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const path = new URL(request.url).pathname;
          if (path === "/result" && request.method === "POST") {
            resolve(await request.json());
            return new Response("ok");
          }
          const asset = assets.get(path);
          if (asset) return new Response(asset);
          if (path === "/") {
            return new Response(
              `<head><link rel="stylesheet" href="/${fixture}.browser.css"></head><body><script src="/${fixture}.browser.js"></script></body>`,
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
          entrypoints: [join(import.meta.dir, `${fixture}.browser.tsx`)],
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
        child = Bun.spawn(
          [
            chrome!,
            "--headless",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            `--user-data-dir=${join(dir, "profile")}`,
            server.url.href,
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
              () => reject(new Error("Browser regression checks timed out")),
              30_000,
            );
          }),
        ]);
        expect(failures).toEqual([]);
      } finally {
        clearTimeout(timer);
        server.stop(true);
        await stopChrome(child);
        await rm(dir, { recursive: true, force: true });
      }
    },
    45_000,
  );
}

import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HTML_PREVIEW_MAX_BYTES } from "../../../shared/filePreview";
import { shQuote } from "../utils/process-utils";
import { createFileHandlers } from "./files";
import { readHtmlPreviewFile, HtmlPreviewError } from "./html-preview-files";
import { HTML_PREVIEW_CSP, renderHtmlPreview } from "./html-preview";
import { runBinaryProcessWithTimeout } from "./process";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "roamgate-html-preview-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const runShell = async (argv: string[], timeout: number) => {
  const result = await runBinaryProcessWithTimeout(
    [
      "bash",
      "-c",
      `base64() { if [ "$#" -eq 1 ]; then command base64 < "$1"; else command base64; fi; }; export -f base64; ${argv.at(-1)!}`,
    ],
    timeout,
  );
  return { ...result, stdout: result.stdout.toString("utf8") };
};

for (const remote of [false, true]) {
  describe(`${remote ? "SSH" : "local"} HTML preview`, () => {
    const options = (root: string) => ({
      rootPath: root,
      host: remote ? "example.invalid" : undefined,
      shQuote,
      runProcessWithCodeTimeout: runShell,
    });
    const handlers = (root: string) =>
      createFileHandlers({
        herdr: {
          call: async () => ({
            workspace: { worktree: { checkout_path: root } },
          }),
        } as any,
        sshHost: () => (remote ? "example.invalid" : undefined),
        runProcessWithCodeTimeout: runShell,
        shQuote,
      });

    test("renders bounded UTF-8 HTML with exact policy and leaves ordinary downloads intact", async () => {
      await fixture(async (root) => {
        const html = "<!doctype html><h1>boundary marker</h1>".padEnd(
          HTML_PREVIEW_MAX_BYTES,
          " ",
        );
        await writeFile(join(root, "page.HTM"), html);
        const files = handlers(root);
        const params = { workspace_id: "w1", path: "page.HTM" };
        const response = await files.downloadWorkspaceFile({
          ...params,
          inline: true,
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(
          "text/html; charset=utf-8",
        );
        expect(response.headers.get("content-disposition")).toStartWith(
          "inline;",
        );
        expect(response.headers.get("content-security-policy")).toBe(
          HTML_PREVIEW_CSP,
        );
        expect(HTML_PREVIEW_CSP).toBe(
          "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline' data: https:; img-src data:; font-src data:",
        );
        expect(response.headers.get("referrer-policy")).toBe("no-referrer");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(await response.text()).toContain("boundary marker");
        await writeFile(join(root, "page.HTM"), html + "x");
        expect(
          (await files.downloadWorkspaceFile({ ...params, inline: true }))
            .status,
        ).toBe(413);
        const download = await files.downloadWorkspaceFile(params);
        expect(download.headers.get("content-disposition")).toStartWith(
          "attachment;",
        );
        expect(await download.text()).toBe(html + "x");
      });
    });

    test("rejects binary files, directories, missing files and symlink escapes", async () => {
      await fixture(async (root) => {
        await writeFile(join(root, "binary.html"), Buffer.from([0, 255]));
        await mkdir(join(root, "directory.html"));
        await symlink(join(root, ".."), join(root, "outside"));
        const files = handlers(root);
        for (const path of [
          "binary.html",
          "directory.html",
          "missing.html",
          "outside/missing.html",
        ]) {
          expect(
            (
              await files.downloadWorkspaceFile({
                workspace_id: "w1",
                path,
                inline: true,
              })
            ).status,
          ).toBe(400);
        }
        await expect(
          readHtmlPreviewFile({
            ...options(root),
            path: "outside",
            limit: 100,
          }),
        ).rejects.toThrow();
      });
    });

    test("inlines relative CSS imports, images and fonts without reading external or executable resources", async () => {
      await fixture(async (root) => {
        await mkdir(join(root, "docs", "styles"), { recursive: true });
        await writeFile(
          join(root, "docs", "styles", "main.css"),
          '@import "theme.css"; @import "https://example.invalid/external.css"; h1{background:url(../../pixel.png)} @font-face{font-family:demo;src:url(../../font.woff2)}',
        );
        await writeFile(
          join(root, "docs", "styles", "theme.css"),
          "h1{color:rgb(12,34,56)}",
        );
        await writeFile(join(root, "pixel.png"), png);
        await writeFile(join(root, "font.woff2"), "font-fixture");
        const source =
          '<base href="https://example.invalid/"><link rel="stylesheet" href="styles/main.css"><script src="local.js"></script><script>throw 1</script><style>p{background:url(../pixel.png)}</style><h1 style="background-image:url(../pixel.png)">Hello</h1><img src="../pixel.png"><img srcset="../pixel.png 1x, ../pixel.png 2x"><img src="https://example.invalid/track.png">';
        await writeFile(join(root, "docs", "page.html"), source);
        const response = await handlers(root).downloadWorkspaceFile({
          workspace_id: "w1",
          path: "docs/page.html",
          inline: true,
        });
        expect(response.status).toBe(200);
        const result = await response.text();
        expect(result).not.toContain("<base");
        expect(result).not.toContain("<script");
        expect(result).not.toContain("https://example.invalid");
        expect(result).toContain(
          `data:image/png;base64,${png.toString("base64")}`,
        );
        const encodedCss = result.match(/data:text\/css;base64,([^"]+)/)?.[1];
        expect(encodedCss).toBeDefined();
        const css = Buffer.from(encodedCss!, "base64").toString("utf8");
        expect(css).toContain("data:font/woff2;base64,");
        expect(css).toContain("data:image/png;base64,");
        expect(css).toContain("https://example.invalid/external.css");
        expect(css).toContain("color:");
      });
    });
  });
}

test("HTTPS stylesheet links and imports stay browser-owned without referrer overrides", async () => {
  const html =
    '<meta name="referrer" content="unsafe-url"><link rel="stylesheet" href="https://cdn.example.invalid/main.css" integrity="sha384-example" crossorigin="anonymous" referrerpolicy="unsafe-url"><link rel="stylesheet" href="//cdn.example.invalid/theme.css"><link rel="stylesheet" href="http://cdn.example.invalid/insecure.css"><link rel="stylesheet" href="https://example-user@cdn.example.invalid/private.css"><style>@import "https://cdn.example.invalid/import.css"; @import "//cdn.example.invalid/shared.css"; @import "http://cdn.example.invalid/insecure.css"; p { background:url(https://cdn.example.invalid/image.png) }</style><script src="https://cdn.example.invalid/app.js"></script>';
  const reads: string[] = [];
  const result = await renderHtmlPreview(
    { path: "page.html", bytes: Buffer.from(html) },
    async (path) => {
      reads.push(path);
      throw new Error("Unexpected read");
    },
  );
  expect(reads).toEqual([]);
  for (const file of ["main.css", "theme.css", "import.css", "shared.css"])
    expect(result).toContain(`https://cdn.example.invalid/${file}`);
  expect(result).toContain('referrerpolicy="no-referrer"');
  expect(result).toContain('integrity="sha384-example"');
  expect(result).toContain('crossorigin="anonymous"');
  for (const forbidden of [
    "unsafe-url",
    "insecure.css",
    "private.css",
    "image.png",
    "app.js",
  ])
    expect(result).not.toContain(forbidden);
});

test("local read detects growth after stat and bounds the read", async () => {
  await fixture(async (root) => {
    const path = join(root, "grow.html");
    await writeFile(path, "<h1>small</h1>");
    const handle = await open(path);
    const prototype = Object.getPrototypeOf(handle);
    const original = prototype.stat;
    await handle.close();
    const stat = spyOn(prototype, "stat").mockImplementation(async function (
      this: any,
      ...args: any[]
    ) {
      const result = await original.apply(this, args);
      await writeFile(path, Buffer.alloc(HTML_PREVIEW_MAX_BYTES * 2, 65));
      return result;
    });
    try {
      await expect(
        readHtmlPreviewFile({
          rootPath: root,
          path: "grow.html",
          limit: HTML_PREVIEW_MAX_BYTES,
          shQuote,
          runProcessWithCodeTimeout: runShell,
        }),
      ).rejects.toMatchObject({ status: 413 });
    } finally {
      stat.mockRestore();
    }
  });
});

test("SSH growth is detected after bounded transfer, and stat rejection transfers no body", async () => {
  await fixture(async (root) => {
    const path = join(root, "grow.html");
    await writeFile(path, "small");
    let transferred = 0;
    const options = {
      rootPath: root,
      path: "grow.html",
      limit: HTML_PREVIEW_MAX_BYTES,
      host: "example.invalid",
      shQuote,
      runProcessWithCodeTimeout: async (argv: string[], timeout: number) => {
        const command = `stat() { local result; result="$(command stat "$@")" || return $?; printf '%s\\n' "$result"; head -c ${HTML_PREVIEW_MAX_BYTES * 2} /dev/zero > ${shQuote(path)}; }; export -f stat; ${argv.at(-1)!}`;
        const result = await runBinaryProcessWithTimeout(
          ["bash", "-c", command],
          timeout,
        );
        transferred = result.stdout.length;
        return { ...result, stdout: result.stdout.toString("utf8") };
      },
    };
    await expect(readHtmlPreviewFile(options)).rejects.toMatchObject({
      status: 413,
    });
    expect(transferred).toBeGreaterThan(HTML_PREVIEW_MAX_BYTES);
    expect(transferred).toBeLessThan(
      Math.ceil((HTML_PREVIEW_MAX_BYTES + 1) / 3) * 4 + 100,
    );
    const result = await readHtmlPreviewFile({
      ...options,
      runProcessWithCodeTimeout: runShell,
    }).catch((error) => error);
    expect(result).toBeInstanceOf(HtmlPreviewError);
    expect(result.status).toBe(413);
  });
});

test("resources cannot follow a symlink outside the workspace", async () => {
  await fixture(async (root) => {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(root, "secret.css"), "h1{color:red}");
    await symlink(join(root, "secret.css"), join(workspace, "style.css"));
    for (const host of [undefined, "example.invalid"]) {
      await expect(
        readHtmlPreviewFile({
          rootPath: workspace,
          path: "style.css",
          limit: HTML_PREVIEW_MAX_BYTES,
          host,
          shQuote,
          runProcessWithCodeTimeout: runShell,
        }),
      ).rejects.toThrow();
    }
  });
});

test("CSS resource reads are serialized, cached and limited by the remaining budget", async () => {
  let active = 0;
  let peak = 0;
  const reads: string[] = [];
  await renderHtmlPreview(
    {
      path: "page.html",
      bytes: Buffer.from(
        "<style>a{background:url(a.png)} b{background:url(b.png)} c{background:url(a.png)}</style>",
      ),
    },
    async (path) => {
      active++;
      peak = Math.max(peak, active);
      reads.push(path);
      await Promise.resolve();
      active--;
      return { path, bytes: png };
    },
  );
  expect(peak).toBe(1);
  expect(reads.sort()).toEqual(["a.png", "b.png"]);
  const limits: number[] = [];
  await renderHtmlPreview(
    {
      path: "page.html",
      bytes: Buffer.from('<img src="a.png"><img src="b.png"><img src="c.png">'),
    },
    async (path, limit) => {
      limits.push(limit);
      return { path, bytes: Buffer.alloc(Math.min(4 * 1024 * 1024, limit)) };
    },
  );
  expect(limits).toEqual([5 * 1024 * 1024, 5 * 1024 * 1024, 2 * 1024 * 1024]);
});

test("escaped CSS resource syntax is bundled", async () => {
  const reads: string[] = [];
  const result = await renderHtmlPreview(
    {
      path: "page.html",
      bytes: Buffer.from(String.raw`<style>@\69mport "theme.css";</style>`),
    },
    async (path) => {
      reads.push(path);
      return { path, bytes: Buffer.from("h1{color:red}") };
    },
  );
  expect(reads).toEqual(["theme.css"]);
  expect(result).toContain("color:red");
  expect(result).not.toContain("theme.css");
});

test("plain inline styles do not consume the resource-processing budget", async () => {
  const html = Array.from(
    { length: 300 },
    () => '<p style="color:red">cell</p>',
  ).join("");
  const result = await renderHtmlPreview(
    { path: "report.html", bytes: Buffer.from(html) },
    async () => {
      throw new Error("Unexpected resource read");
    },
  );
  expect(result).toBe(html);
});

test("static resource and output budgets fail closed", async () => {
  const make = (html: string) => ({
    path: "page.html",
    bytes: Buffer.from(html),
  });
  await expect(
    renderHtmlPreview(
      make(
        Array.from({ length: 65 }, (_, i) => `<img src="${i}.png">`).join(""),
      ),
      async (path) => ({ path, bytes: png }),
    ),
  ).rejects.toMatchObject({ status: 413 });
  await expect(
    renderHtmlPreview(
      make('<img src="a.png"><img src="b.png"><img src="c.png">'),
      async (path) => ({ path, bytes: Buffer.alloc(4 * 1024 * 1024) }),
    ),
  ).rejects.toMatchObject({ status: 413 });
  const reads: string[] = [];
  const result = await renderHtmlPreview(
    make(
      '<img src="https://example.invalid/a.png"><link rel="stylesheet" href="//example.invalid/a.css"><img src="local.js"><img src="missing.png">',
    ),
    async (path) => {
      reads.push(path);
      throw new Error("not found");
    },
  );
  expect(reads).toEqual(["missing.png"]);
  expect(result).toContain('href="https://example.invalid/a.css"');
  expect(result).not.toContain("https://example.invalid/a.png");
});

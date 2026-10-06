import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { serveStatic } from "./static-files";

const web = resolve(import.meta.dir, "../../../web");

test("the app links a credentialed standalone manifest with existing install icons", async () => {
  const html = await Bun.file(resolve(web, "index.html")).text();
  const link = html.match(/<link\b[^>]*\brel="manifest"[^>]*>/)?.[0];
  expect(link).toContain('href="/manifest.json"');
  expect(link).toContain('crossorigin="use-credentials"');
  const response = await serveStatic(
    new Request("https://roamgate.example/manifest.json"),
    resolve(web, "public"),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  const manifest = await response.json();
  expect(manifest).toMatchObject({
    id: "/",
    name: "Roamgate",
    short_name: "Roamgate",
    start_url: "/",
    scope: "/",
    display: "standalone",
  });
  expect(manifest.icons.map((icon: { sizes: string }) => icon.sizes)).toEqual([
    "192x192",
    "512x512",
  ]);
  for (const icon of manifest.icons) {
    expect(icon.type).toBe("image/png");
    const bytes = Buffer.from(
      await Bun.file(resolve(web, "public", icon.src.slice(1))).arrayBuffer(),
    );
    expect(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`).toBe(
      icon.sizes,
    );
  }
});

test("source runs fall back to the built public directory", async () => {
  const response = await serveStatic(
    new Request("https://roamgate.example/manifest.json"),
    "/nonexistent-roamgate-static-test",
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual(
    await Bun.file(resolve(web, "public/manifest.json")).json(),
  );
});

test("instance names update both manifest labels without changing installation identity", async () => {
  const original = await Bun.file(resolve(web, "public/manifest.json")).json();
  for (const suffix of ["Home", 'Work "A" & <B>', "\u5bb6\u91cc", ""]) {
    const response = await serveStatic(
      new Request("https://roamgate.example/manifest.json", {
        headers: {
          "if-none-match": '"old-static-file"',
          "if-modified-since": new Date().toUTCString(),
        },
      }),
      resolve(web, "public"),
      suffix,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-cache, must-revalidate",
    );
    expect(response.headers.has("etag")).toBe(false);
    const name = suffix ? `Roamgate \u00b7 ${suffix}` : "Roamgate";
    expect(await response.json()).toEqual({
      ...original,
      name,
      short_name: name,
    });
  }
});

test("entry HTML escapes the name in title and metadata, including SPA routes", async () => {
  const { Window } = await import("happy-dom");
  const window = new Window({
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
    },
  });
  try {
    const suffix = '</title><script>"&';
    for (const path of ["/", "/index.html", "/workspace/example"]) {
      const response = await serveStatic(
        new Request(`https://roamgate.example${path}`, {
          headers: { accept: "text/html" },
        }),
        web,
        suffix,
      );
      expect(response.headers.get("cache-control")).toContain("no-cache");
      const doc = new window.DOMParser().parseFromString(
        await response.text(),
        "text/html",
      );
      expect(doc.title).toBe(`Roamgate \u00b7 ${suffix}`);
      expect(doc.querySelectorAll("title")).toHaveLength(1);
      const original = new window.DOMParser().parseFromString(
        await Bun.file(resolve(web, "index.html")).text(),
        "text/html",
      );
      expect(doc.querySelectorAll("script")).toHaveLength(
        original.querySelectorAll("script").length,
      );
      for (const key of ["application-name", "apple-mobile-web-app-title"])
        expect(
          doc.querySelector(`meta[name="${key}"]`)?.getAttribute("content"),
        ).toBe(`Roamgate \u00b7 ${suffix}`);
      expect(
        doc.querySelector('link[rel="manifest"]')?.getAttribute("href"),
      ).toBe("/manifest.json");
      expect(
        doc.querySelector('link[rel="manifest"]')?.getAttribute("crossorigin"),
      ).toBe("use-credentials");
    }
  } finally {
    await window.happyDOM.close();
  }
});

test("HEAD returns naming response headers without a body", async () => {
  for (const [path, directory] of [
    ["/index.html", web],
    ["/manifest.json", resolve(web, "public")],
  ]) {
    const response = await serveStatic(
      new Request(`https://roamgate.example${path}`, { method: "HEAD" }),
      directory,
      "Work",
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe(
      "private, no-cache, must-revalidate",
    );
  }
});

test("a fresh source build serves instance metadata without generated web assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "roamgate-source-manifest-"));
  try {
    const outdir = join(root, "server/src/http");
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "static-files.ts")],
      target: "bun",
      outdir,
      naming: "static-files.js",
    });
    expect(build.success).toBe(true);
    await writeFile(
      join(root, "index.html"),
      "<title>SPA fallback must not replace manifest</title>",
    );
    const script = `
      import { serveStatic } from ${JSON.stringify(join(outdir, "static-files.js"))};
      const response = await serveStatic(new Request("http://localhost/manifest.json", { headers: { accept: "text/html" } }), ${JSON.stringify(root)}, "Dev");
      console.log(JSON.stringify({ status: response.status, cache: response.headers.get("cache-control"), manifest: await response.json() }));
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      status: 200,
      cache: "private, no-cache, must-revalidate",
      manifest: {
        ...(await Bun.file(resolve(web, "public/manifest.json")).json()),
        name: "Roamgate \u00b7 Dev",
        short_name: "Roamgate \u00b7 Dev",
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

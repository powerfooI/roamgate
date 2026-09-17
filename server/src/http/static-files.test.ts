import { expect, test } from "bun:test";
import { resolve } from "node:path";
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

test("standalone builds embed the install manifest", async () => {
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

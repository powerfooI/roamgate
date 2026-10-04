import { expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import serverPackage from "../server/package.json";

async function checkStandalone(sourceMaps: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "roamgate-standalone-"));
  const runtimeDir = join(dir, "runtime");
  const overrideDir = join(dir, "override");
  let binary = join(
    dir,
    process.platform === "win32" ? "roamgate.exe" : "roamgate",
  );
  async function run(argv: string[], cwd: string) {
    const child = Bun.spawn(argv, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
      killSignal: "SIGKILL",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  }
  try {
    await mkdir(join(dir, "public/assets"), { recursive: true });
    await mkdir(join(dir, "src"));
    await mkdir(runtimeDir);
    await mkdir(overrideDir);
    await Bun.write(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: {
          compile: serverPackage.scripts.compile,
          postcompile: serverPackage.scripts.postcompile,
          "clean:bun-build": serverPackage.scripts["clean:bun-build"],
        },
      }),
    );
    await Bun.write(join(dir, "public/index.html"), "embedded entry");
    await Bun.write(
      join(dir, "public/assets/app-hash.js"),
      "export const value = 42;",
    );
    await Bun.write(
      join(dir, "public/assets/font.woff2"),
      new Uint8Array([0, 1, 128, 255]),
    );
    await Bun.write(
      join(runtimeDir, ".env"),
      "ROAMGATE_STANDALONE_TEST=ambient\n",
    );
    await Bun.write(
      join(runtimeDir, "bunfig.toml"),
      'preload = ["./unexpected.ts"]\n',
    );
    await Bun.write(
      join(runtimeDir, "unexpected.ts"),
      'throw new Error("ambient preload ran");',
    );
    await Bun.write(join(overrideDir, "index.html"), "external entry");
    await Bun.write(
      join(dir, "src/index.ts"),
      `
import { serveStatic } from ${JSON.stringify(fileURLToPath(new URL("../server/src/http/static-files.ts", import.meta.url)))};
if (process.argv.includes("--crash")) throw new Error("source map probe");
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch: request => serveStatic(request, process.argv[2]),
});
const results = [];
try {
  for (const [path, method, accept] of [
    ["/", "GET", "text/html"],
    ["/workspace", "GET", "text/html"],
    ["/assets/app-hash.js", "GET", "*/*"],
    ["/assets/font.woff2", "GET", "*/*"],
    ["/missing.js", "GET", "*/*"],
    ["/", "HEAD", "text/html"],
    ["/", "POST", "text/html"],
    ["/%ZZ", "GET", "text/html"],
    ["/..%2Foutside.txt", "GET", "text/html"],
  ]) {
    const response = await fetch(new URL(path, server.url), { method, headers: { accept } });
    results.push({ status: response.status, type: response.headers.get("content-type"),
      cache: response.headers.get("cache-control"), body: Buffer.from(await response.arrayBuffer()).toString("base64") });
  }
  console.log(JSON.stringify({ standalone: Bun.isStandaloneExecutable,
    ambient: process.env.ROAMGATE_STANDALONE_TEST ?? null, results }));
} finally { server.stop(true); }
`,
    );
    // Exercise the actual release/debug commands, including postcompile cleanup.
    const build = await run(
      [
        process.execPath,
        "run",
        "--cwd",
        dir,
        "compile",
        ...(sourceMaps ? ["--sourcemap"] : []),
      ],
      dir,
    );
    expect(build.code, build.stderr).toBe(0);
    expect(await Bun.file(join(dir, "roamgate.map")).exists()).toBe(sourceMaps);
    if (sourceMaps) {
      const mode = (await stat(binary)).mode & 0o777;
      const archive = join(dir, "debug.tar");
      const packed = await run(
        ["tar", "-C", dir, "-cf", archive, basename(binary), "roamgate.map"],
        dir,
      );
      expect(packed.code, packed.stderr).toBe(0);
      // Artifact downloads normalize the outer file's permissions to 0644.
      await chmod(archive, 0o644);
      const unpackedDir = join(dir, "unpacked-debug");
      await mkdir(unpackedDir);
      const unpacked = await run(
        ["tar", "-C", unpackedDir, "-xf", archive],
        dir,
      );
      expect(unpacked.code, unpacked.stderr).toBe(0);
      binary = join(unpackedDir, basename(binary));
      if (process.platform !== "win32") {
        expect((await stat(binary)).mode & 0o777).toBe(mode);
        expect(mode & 0o111).not.toBe(0);
      }
      expect(await Bun.file(join(unpackedDir, "roamgate.map")).exists()).toBe(
        true,
      );
      await rm(join(unpackedDir, "roamgate.map"));
    }
    await rename(join(dir, "public"), join(dir, "source-public"));
    await rename(join(dir, "src"), join(dir, "source-src"));
    await rm(join(dir, "roamgate.map"), { force: true });
    const embedded = await run(
      [binary, join(dir, "missing-public")],
      runtimeDir,
    );
    expect(embedded.code, embedded.stderr).toBe(0);
    const result = JSON.parse(embedded.stdout);
    expect(result.standalone).toBe(true);
    expect(result.ambient).toBeNull();
    expect(
      result.results.map((item: { status: number }) => item.status),
    ).toEqual([200, 200, 200, 200, 404, 200, 405, 400, 404]);
    expect(result.results[0].cache).toBe("no-cache, must-revalidate");
    expect(Buffer.from(result.results[1].body, "base64").toString()).toBe(
      "embedded entry",
    );
    expect(result.results[2].type).toContain("javascript");
    expect(Buffer.from(result.results[2].body, "base64").toString()).toBe(
      "export const value = 42;",
    );
    expect(result.results[3].type).toBe("font/woff2");
    expect([...Buffer.from(result.results[3].body, "base64")]).toEqual([
      0, 1, 128, 255,
    ]);
    expect(result.results[5].body).toBe("");
    const override = await run([binary, overrideDir], runtimeDir);
    expect(override.code, override.stderr).toBe(0);
    const overridden = JSON.parse(override.stdout).results;
    expect(Buffer.from(overridden[0].body, "base64").toString()).toBe(
      "external entry",
    );
    expect(Buffer.from(overridden[1].body, "base64").toString()).toBe(
      "external entry",
    );
    expect(overridden[2]).toEqual(result.results[2]);
    const crash = await run([binary, overrideDir, "--crash"], runtimeDir);
    expect(crash.code).not.toBe(0);
    expect(crash.stderr).toContain("source map probe");
    if (sourceMaps) {
      expect(crash.stderr).toMatch(/src[\\/]index\.ts:\d+/);
    } else {
      expect(crash.stderr).not.toMatch(/src[\\/]index\.ts:\d+/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test(
  "release standalone serves assets without ambient config or source maps",
  () => checkStandalone(false),
  45_000,
);
test(
  "debug archive retains executable permissions and embedded source maps",
  () => checkStandalone(true),
  45_000,
);

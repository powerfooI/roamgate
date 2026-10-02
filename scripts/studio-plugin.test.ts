import { afterEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeUrl,
  parseSha256File,
  readServiceEnv,
  releaseAssetFor,
  supportsIdentityMigrationPrebuilt,
} from "./studio-plugin";

describe("plugin build commands", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function checkout() {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "studio-plugin-build-test-")),
    );
    roots.push(root);
    for (const dir of ["scripts", "web", "server", "bin"]) {
      mkdirSync(join(root, dir));
    }
    copyFileSync(
      join(import.meta.dir, "studio-plugin.ts"),
      join(root, "scripts/studio-plugin.ts"),
    );
    mkdirSync(join(root, "server/src/config"), { recursive: true });
    copyFileSync(
      join(import.meta.dir, "../server/src/config/data-paths.ts"),
      join(root, "server/src/config/data-paths.ts"),
    );
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ version: "9.8.7" }),
    );
    writeFileSync(
      join(root, "bin/bun"),
      `#!/bin/sh
printf '%s: %s\\n' "$PWD" "$*" >> "$BUILD_LOG"
[ "$PWD" != "$FAIL_DIR" ] || exit 23
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(root, "fetch.js"),
      `import { appendFileSync } from "node:fs";
globalThis.fetch = async (url) => {
  appendFileSync(process.env.FETCH_LOG, url + "\\n");
  if (process.env.HTTP_STATUS === "throw") throw new Error("network unavailable");
  return new Response("missing", { status: Number(process.env.HTTP_STATUS) });
};
`,
    );
    return root;
  }

  test("0.7.0 build refuses downloading legacy identities before mutation", () => {
    const root = checkout();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ version: "0.7.0" }),
    );
    const result = invoke(root, "build");
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("requires a source build");
    expect(existsSync(join(root, "fetch.log"))).toBeFalse();
    expect(existsSync(join(root, "build.log"))).toBeFalse();
  });

  function invoke(
    root: string,
    verb: string,
    env: Record<string, string> = {},
  ) {
    return Bun.spawnSync(
      [
        process.execPath,
        "--preload",
        join(root, "fetch.js"),
        join(root, "scripts/studio-plugin.ts"),
        verb,
      ],
      {
        env: {
          ...process.env,
          PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
          BUILD_LOG: join(root, "build.log"),
          FETCH_LOG: join(root, "fetch.log"),
          HTTP_STATUS: "404",
          FAIL_DIR: "",
          ...env,
        },
      },
    );
  }

  test("build-source installs all dependencies and builds without downloading a release", () => {
    const root = checkout();
    const result = invoke(root, "build-source");
    expect(result.exitCode).toBe(0);
    expect(
      readFileSync(join(root, "build.log"), "utf8").trim().split("\n"),
    ).toEqual([
      `${root}: install`,
      `${root}/web: install`,
      `${root}/server: install`,
      `${root}: run build`,
    ]);
    expect(existsSync(join(root, "fetch.log"))).toBe(false);
  });

  test("build-source stops on dependency installation failure", () => {
    const root = checkout();
    expect(
      invoke(root, "build-source", { FAIL_DIR: join(root, "web") }).exitCode,
    ).toBe(23);
    expect(
      readFileSync(join(root, "build.log"), "utf8").trim().split("\n"),
    ).toHaveLength(2);
    expect(existsSync(join(root, "fetch.log"))).toBe(false);
  });

  test.each(["404", "500", "throw"])(
    "release-only build fails actionably on %s without source or legacy fallback",
    (status) => {
      const root = checkout();
      const result = invoke(root, "build", { HTTP_STATUS: status });
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain(
        "bun scripts/studio-plugin.ts build-source",
      );
      expect(result.stderr.toString()).toContain("herdr plugin link .");
      expect(result.stderr.toString()).toContain("--ref vX.Y.Z");
      expect(existsSync(join(root, "build.log"))).toBe(false);
      const requests = readFileSync(join(root, "fetch.log"), "utf8")
        .trim()
        .split("\n");
      expect(requests).toHaveLength(2);
      for (const url of requests) {
        expect(url).toContain("/releases/download/v9.8.7/roamgate-");
      }
      expect(existsSync(join(root, "server/roamgate"))).toBe(false);
      expect(existsSync(join(root, "server/roamgate.exe"))).toBe(false);
    },
  );
});

test("prebuilt identity floor compares numeric versions", () => {
  for (const version of ["0.6.2", "0.7.0", "0.7.0-beta.1", "unknown"])
    expect(supportsIdentityMigrationPrebuilt(version)).toBeFalse();
  for (const version of ["0.7.1", "0.8.0", "0.10.0", "1.0.0"])
    expect(supportsIdentityMigrationPrebuilt(version)).toBeTrue();
});

describe("releaseAssetFor", () => {
  test("maps every supported platform to an archive and binary name", () => {
    expect(releaseAssetFor("darwin", "arm64")).toEqual({
      asset: "roamgate-darwin-arm64",
      binary: "roamgate",
    });
    expect(releaseAssetFor("linux", "x64")).toEqual({
      asset: "roamgate-linux-x64",
      binary: "roamgate",
    });
    expect(releaseAssetFor("win32", "x64")?.binary).toBe("roamgate.exe");
    expect(releaseAssetFor("win32", "arm64")?.asset).toBe(
      "roamgate-windows-arm64",
    );
  });

  test("returns null for unsupported platforms", () => {
    expect(releaseAssetFor("freebsd", "x64")).toBeNull();
    expect(releaseAssetFor("darwin", "ia32")).toBeNull();
  });
});

describe("parseSha256File", () => {
  test("extracts the digest from shasum output", () => {
    const digest = "a".repeat(64);
    expect(parseSha256File(`${digest}  roamgate-darwin-arm64.tar.xz\n`)).toBe(
      digest,
    );
  });

  test("rejects content without a digest", () => {
    expect(parseSha256File("not a checksum")).toBeNull();
    expect(parseSha256File("zzzz" + "0".repeat(60))).toBeNull();
  });
});

describe("readServiceEnv", () => {
  test("reads plain values", () => {
    expect(readServiceEnv("HOST=0.0.0.0\nPORT=8791\n", "HOST")).toBe("0.0.0.0");
    expect(readServiceEnv("HOST=0.0.0.0\nPORT=8791\n", "PORT")).toBe("8791");
  });

  test("accepts export prefix, whitespace, and quoted values", () => {
    const contents = "export HOST=\"0.0.0.0\"\n  PORT = '8799'\n";
    expect(readServiceEnv(contents, "HOST")).toBe("0.0.0.0");
    expect(readServiceEnv(contents, "PORT")).toBe("8799");
  });

  test("last occurrence wins and missing keys are undefined", () => {
    expect(readServiceEnv("PORT=1\nPORT=2\n", "PORT")).toBe("2");
    expect(readServiceEnv("HOST=x\n", "PORT")).toBeUndefined();
  });

  test("ignores comments and unrelated keys", () => {
    const contents =
      "# HOST=10.0.0.1\nHERDR_GUI_LOG_LEVEL=info\nHOST=127.0.0.1\n";
    expect(readServiceEnv(contents, "HOST")).toBe("127.0.0.1");
  });
});

describe("computeUrl", () => {
  const dirs: string[] = [];
  function fixture(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "studio-plugin-"));
    dirs.push(dir);
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(dir, name), text);
    }
    return dir;
  }
  afterEach(() => {
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  test("defaults to loopback when no env file exists", () => {
    expect(computeUrl(fixture({}))).toBe("http://127.0.0.1:8787");
  });

  test("includes the login token for non-loopback binds", () => {
    const dir = fixture({
      "roamgate.env": "HOST=0.0.0.0\nPORT=8791\n",
      "auth-token": "abc123\n",
    });
    expect(computeUrl(dir)).toBe("http://localhost:8791/?token=abc123");
  });

  test("includes the login token for loopback binds", () => {
    const dir = fixture({
      "roamgate.env": "HOST=127.0.0.1\nPORT=8787\n",
      "auth-token": "abc123\n",
    });
    expect(computeUrl(dir)).toBe("http://127.0.0.1:8787/?token=abc123");
  });

  test("new password values take precedence, including empty values", () => {
    const dir = fixture({
      "roamgate.env":
        "HOST=0.0.0.0\nHERDR_GUI_PASSWORD=old\nROAMGATE_PASSWORD=new\n",
      "auth-token": "saved-token\n",
    });
    expect(computeUrl(dir)).toBe("http://localhost:8787");
    writeFileSync(
      join(dir, "roamgate.env"),
      "HOST=0.0.0.0\nHERDR_GUI_PASSWORD=old\nROAMGATE_PASSWORD=\n",
    );
    expect(computeUrl(dir)).toBe("http://localhost:8787/?token=saved-token");
  });

  test("honors exported and quoted entries without a token file", () => {
    const dir = fixture({
      "roamgate.env": 'export HOST="0.0.0.0"\nPORT = "8799"\n',
    });
    expect(computeUrl(dir)).toBe("http://localhost:8799");
  });
});

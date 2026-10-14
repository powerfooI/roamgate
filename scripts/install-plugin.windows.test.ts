import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.skipIf(process.platform !== "win32")(
  "Windows plugin installer verifies and stages releases without Bun on PATH",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "roamgate plugin installer "));
    let host: ReturnType<typeof Bun.serve> | undefined;
    try {
      for (const dir of ["scripts", "server", "assets"])
        mkdirSync(join(root, dir));
      copyFileSync(
        join(import.meta.dir, "install-plugin.ps1"),
        join(root, "scripts/install-plugin.ps1"),
      );
      writeFileSync(join(root, "herdr-plugin.toml"), 'version = "9.8.7"\n');
      const powershell = join(
        process.env.SystemRoot!,
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      );
      const arch = Bun.spawnSync([
        powershell,
        "-NoProfile",
        "-Command",
        "[Runtime.InteropServices.RuntimeInformation]::OSArchitecture",
      ])
        .stdout.toString()
        .trim();
      const platform = `windows-${arch === "Arm64" ? "arm64" : "x64"}`;
      const packageDir = `roamgate-${platform}`;
      const packagePath = join(root, "assets", packageDir);
      mkdirSync(packagePath);
      const fixture = join(root, "fixture.ts");
      writeFileSync(
        fixture,
        `if (process.argv[2] === "--version" || (process.argv[2] === "plugin" && process.argv[3] === "version" && !process.env.PLUGIN_REJECT_NATIVE)) console.log("roamgate 9.8.7"); else process.exit(2);`,
      );
      expect(
        Bun.spawnSync([
          process.execPath,
          "build",
          "--compile",
          "--no-compile-autoload-dotenv",
          "--no-compile-autoload-bunfig",
          fixture,
          "--outfile",
          join(packagePath, "roamgate.exe"),
        ]).exitCode,
      ).toBe(0);
      const archiveName = `roamgate-v9.8.7-${platform}.tar.xz`;
      const archive = join(root, "assets", archiveName);
      const packageArchive = (version: string) => {
        writeFileSync(
          join(packagePath, "VERSION"),
          `roamgate ${version} ${platform}\n`,
        );
        expect(
          Bun.spawnSync([
            "tar.exe",
            "--options",
            "xz:compression-level=0",
            "-C",
            join(root, "assets"),
            "-cJf",
            archive,
            packageDir,
          ]).exitCode,
        ).toBe(0);
        return readFileSync(archive);
      };
      const validArchive = packageArchive("9.8.7");
      const invalidArchive = packageArchive("9.8.6");
      let failure = "none";
      host = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          if (failure === "download")
            return new Response("unavailable", { status: 503 });
          const name = new URL(request.url).pathname.slice(1);
          return name === archiveName || name === `${archiveName}.sha256`
            ? new Response(Bun.file(join(root, "assets", name)))
            : new Response("missing", { status: 404 });
        },
      });
      const installerEnv = {
        ...process.env,
        PATH: `${join(process.env.SystemRoot!, "System32")};${join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0")}`,
      };
      for (failure of [
        "fresh",
        "none",
        "legacy-mirror",
        "checksum",
        "checksum-name",
        "metadata",
        "native-command",
        "download",
      ]) {
        writeFileSync(
          archive,
          failure === "metadata" ? invalidArchive : validArchive,
        );
        const digest =
          failure === "checksum"
            ? "0".repeat(64)
            : createHash("sha256").update(readFileSync(archive)).digest("hex");
        writeFileSync(
          `${archive}.sha256`,
          `${digest}  ${failure === "checksum-name" ? "../unrelated" : archiveName}\n`,
        );
        const target = join(root, "server/roamgate.exe");
        if (failure !== "fresh") writeFileSync(target, "keep previous binary");
        const child = Bun.spawn(
          [
            powershell,
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            join(root, "scripts/install-plugin.ps1"),
          ],
          {
            env: {
              ...installerEnv,
              ROAMGATE_RELEASE_BASE_URL:
                failure === "legacy-mirror"
                  ? undefined
                  : `http://127.0.0.1:${host.port}`,
              HERDR_GUI_RELEASE_BASE_URL:
                failure === "legacy-mirror"
                  ? `http://127.0.0.1:${host.port}`
                  : "http://legacy.invalid/releases",
              PLUGIN_REJECT_NATIVE: failure === "native-command" ? "1" : "",
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [code, stderr] = await Promise.all([
          child.exited,
          new Response(child.stderr).text(),
        ]);
        if (["fresh", "none", "legacy-mirror"].includes(failure)) {
          expect(code, stderr).toBe(0);
          expect(
            Bun.spawnSync([target, "plugin", "version"])
              .stdout.toString()
              .trim(),
          ).toBe("roamgate 9.8.7");
        } else {
          expect(code, failure).not.toBe(0);
          expect(readFileSync(target, "utf8")).toBe("keep previous binary");
        }
        expect(readdirSync(join(root, "server"))).toEqual(["roamgate.exe"]);
      }
      const script = join(root, "scripts/install-plugin.ps1").replaceAll(
        "'",
        "''",
      );
      const emptyOverride = Bun.spawnSync(
        [
          powershell,
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `function Invoke-WebRequest { param($Uri) throw "Selected release: $Uri" }; & '${script}'`,
        ],
        {
          env: {
            ...installerEnv,
            ROAMGATE_RELEASE_BASE_URL: "",
            HERDR_GUI_RELEASE_BASE_URL: "http://legacy.invalid/releases",
          },
        },
      );
      expect(emptyOverride.exitCode).not.toBe(0);
      expect(emptyOverride.stderr.toString()).toContain(
        "Selected release: https://github.com/powerfooI/roamgate/releases/download/v9.8.7/",
      );
      expect(readdirSync(join(root, "server"))).toEqual(["roamgate.exe"]);
    } finally {
      host?.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  },
  180_000,
);

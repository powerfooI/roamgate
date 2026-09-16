import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  herdrManagedBinaryPath,
  herdrReleaseAssetName,
  herdrReleaseUrl,
  installVerifiedHerdr,
  resolveHerdrReleaseTarget,
  VERIFIED_HERDR_SHA256,
  VERIFIED_HERDR_VERSION,
} from "./release";

const trash: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-herdr-release-"));
  trash.push(dir);
  return dir;
}
afterEach(() => {
  while (trash.length) {
    const dir = trash.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveHerdrReleaseTarget", () => {
  test("maps supported platforms to published assets", () => {
    expect(resolveHerdrReleaseTarget("linux", "x64")).toBe("linux-x86_64");
    expect(resolveHerdrReleaseTarget("linux", "arm64")).toBe("linux-aarch64");
    expect(resolveHerdrReleaseTarget("darwin", "x64")).toBe("macos-x86_64");
    expect(resolveHerdrReleaseTarget("darwin", "arm64")).toBe("macos-aarch64");
    expect(resolveHerdrReleaseTarget("win32", "x64")).toBe("windows-x86_64");
  });

  test("rejects platforms without a verified asset", () => {
    expect(resolveHerdrReleaseTarget("win32", "arm64")).toBeNull();
    expect(resolveHerdrReleaseTarget("freebsd", "x64")).toBeNull();
    expect(resolveHerdrReleaseTarget("linux", "ia32")).toBeNull();
  });
});

describe("verified release metadata", () => {
  test("pins a checksum for every published asset", () => {
    for (const [target, sha256] of Object.entries(VERIFIED_HERDR_SHA256)) {
      expect(sha256, target).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(Object.keys(VERIFIED_HERDR_SHA256)).toHaveLength(5);
  });

  test("builds GitHub release URLs for the verified version", () => {
    expect(herdrReleaseAssetName("macos-aarch64")).toBe("herdr-macos-aarch64");
    expect(herdrReleaseAssetName("windows-x86_64")).toBe(
      "herdr-windows-x86_64.zip",
    );
    expect(herdrReleaseUrl("linux-x86_64")).toBe(
      `https://github.com/herdrdev/herdr/releases/download/v${VERIFIED_HERDR_VERSION}/herdr-linux-x86_64`,
    );
  });
});

describe("installVerifiedHerdr", () => {
  test("rejects unsupported platforms before downloading", async () => {
    let downloads = 0;
    await expect(
      installVerifiedHerdr({
        platform: "freebsd",
        arch: "x64",
        homeDir: scratch(),
        download: async () => {
          downloads += 1;
        },
      }),
    ).rejects.toThrow("no verified Herdr");
    expect(downloads).toBe(0);
  });

  test("keeps an existing managed binary without downloading", async () => {
    const homeDir = scratch();
    const binaryPath = herdrManagedBinaryPath(homeDir, undefined, "linux");
    mkdirSync(join(binaryPath, ".."), { recursive: true });
    writeFileSync(binaryPath, "already-here");
    let downloads = 0;
    const result = await installVerifiedHerdr({
      platform: "linux",
      arch: "x64",
      homeDir,
      download: async () => {
        downloads += 1;
      },
    });
    expect(result).toEqual({
      binaryPath,
      version: VERIFIED_HERDR_VERSION,
      installed: false,
    });
    expect(downloads).toBe(0);
  });

  test("downloads the verified asset and installs it executable", async () => {
    const homeDir = scratch();
    const content = "fake-herdr-binary";
    const expectedSha256 = createHash("sha256").update(content).digest("hex");
    let url = "";
    const result = await installVerifiedHerdr({
      platform: "linux",
      arch: "x64",
      homeDir,
      expectedSha256,
      download: async (downloadUrl, destinationPath) => {
        url = downloadUrl;
        writeFileSync(destinationPath, content);
      },
    });
    expect(url).toBe(
      `https://github.com/herdrdev/herdr/releases/download/v${VERIFIED_HERDR_VERSION}/herdr-linux-x86_64`,
    );
    expect(result.installed).toBe(true);
    expect(await Bun.file(result.binaryPath).text()).toBe(content);
    const mode = statSync(result.binaryPath).mode;
    expect(mode & 0o111).not.toBe(0);
  });

  test("refuses a download whose checksum does not match", async () => {
    const homeDir = scratch();
    await expect(
      installVerifiedHerdr({
        platform: "darwin",
        arch: "arm64",
        homeDir,
        download: async (_url, destinationPath) => {
          writeFileSync(destinationPath, "tampered");
        },
      }),
    ).rejects.toThrow("checksum does not match");
    expect(
      existsSync(herdrManagedBinaryPath(homeDir, undefined, "darwin")),
    ).toBe(false);
  });

  test("extracts the Windows zip layout via PowerShell", async () => {
    const homeDir = scratch();
    const appDataDir = scratch();
    const content = "fake-zip";
    const expectedSha256 = createHash("sha256").update(content).digest("hex");
    const installDir = dirname(
      herdrManagedBinaryPath(homeDir, appDataDir, "win32"),
    );
    const commands: string[][] = [];
    const result = await installVerifiedHerdr({
      platform: "win32",
      arch: "x64",
      homeDir,
      appDataDir,
      expectedSha256,
      download: async (_url, destinationPath) => {
        writeFileSync(destinationPath, content);
      },
      runCommand: (argv) => {
        commands.push(argv);
        expect(existsSync(installDir)).toBe(false);
        // Emulate Expand-Archive by materializing the zip layout.
        const command = argv[argv.length - 1];
        const destination = /-DestinationPath '([^']+)'/.exec(command)?.[1];
        if (!destination) return 1;
        mkdirSync(join(destination, "conpty"), { recursive: true });
        writeFileSync(join(destination, "herdr.exe"), "exe");
        writeFileSync(join(destination, "conpty", "conpty.dll"), "dll");
        mkdirSync(join(destination, "THIRD-PARTY-NOTICES"));
        writeFileSync(
          join(destination, "THIRD-PARTY-NOTICES", "notice.txt"),
          "notice",
        );
        return 0;
      },
    });
    expect(commands).toHaveLength(1);
    expect(commands[0].join(" ")).toContain("Expand-Archive");
    expect(result.installed).toBe(true);
    expect(
      existsSync(join(result.binaryPath, "..", "conpty", "conpty.dll")),
    ).toBe(true);
    expect(await Bun.file(result.binaryPath).text()).toBe("exe");
    expect(
      await Bun.file(
        join(installDir, "THIRD-PARTY-NOTICES", "notice.txt"),
      ).text(),
    ).toBe("notice");
  });

  for (const failure of ["extraction", "missing-executable", "publication"]) {
    test(`Windows ${failure} failure leaves no partial installation and can retry`, async () => {
      const homeDir = scratch();
      const appDataDir = scratch();
      const binaryPath = herdrManagedBinaryPath(homeDir, appDataDir, "win32");
      const installDir = dirname(binaryPath);
      if (failure === "publication") {
        mkdirSync(installDir, { recursive: true });
        writeFileSync(join(installDir, "keep.txt"), "existing contents");
      }
      let fail = true;
      const content = "fake-zip";
      const deps = {
        platform: "win32",
        arch: "x64",
        homeDir,
        appDataDir,
        expectedSha256: createHash("sha256").update(content).digest("hex"),
        download: async (_url: string, path: string) => {
          writeFileSync(path, content);
        },
        runCommand: (argv: string[]) => {
          const destination = /-DestinationPath '([^']+)'/.exec(
            argv.at(-1)!,
          )![1];
          mkdirSync(join(destination, "conpty"), { recursive: true });
          writeFileSync(join(destination, "conpty", "conpty.dll"), "dll");
          if (!fail || failure !== "missing-executable") {
            writeFileSync(join(destination, "herdr.exe"), "exe");
          }
          return fail && failure === "extraction" ? 1 : 0;
        },
      };
      await expect(installVerifiedHerdr(deps)).rejects.toThrow();
      expect(existsSync(binaryPath)).toBe(false);
      expect(
        readdirSync(dirname(installDir)).filter((name) =>
          name.startsWith(".staging-"),
        ),
      ).toEqual([]);
      if (failure === "publication") {
        expect(readdirSync(installDir)).toEqual(["keep.txt"]);
        expect(await Bun.file(join(installDir, "keep.txt")).text()).toBe(
          "existing contents",
        );
        rmSync(installDir, { recursive: true });
      } else {
        expect(existsSync(installDir)).toBe(false);
      }
      fail = false;
      expect((await installVerifiedHerdr(deps)).installed).toBe(true);
      expect(await Bun.file(binaryPath).text()).toBe("exe");
      expect(
        await Bun.file(join(installDir, "conpty", "conpty.dll")).text(),
      ).toBe("dll");
    });
  }
});

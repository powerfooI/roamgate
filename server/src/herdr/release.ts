import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Roamgate only installs this exact Herdr build. The SHA-256 values were
 * recorded from https://herdr.dev/latest.json when this version was verified,
 * so a replaced or tampered release asset fails verification instead of
 * installing. Bump the version and checksums together after verifying a new
 * Herdr release against Roamgate's supported protocol range
 * (server/src/bridge/protocol-compat.ts).
 */
export const VERIFIED_HERDR_VERSION = "0.9.0";
export const VERIFIED_HERDR_PROTOCOL = 22;

export type HerdrReleaseTarget =
  | "linux-x86_64"
  | "linux-aarch64"
  | "macos-x86_64"
  | "macos-aarch64"
  | "windows-x86_64";

export const VERIFIED_HERDR_SHA256: Record<HerdrReleaseTarget, string> = {
  "linux-x86_64":
    "4fa1a01158dd8043da92d31b270780b0dcc10603038d9b61cac4d81ab63fb71f",
  "linux-aarch64":
    "9c8db20fb7e7427b138d5367113f1621ffd319f2f65d6f009e2594029115f0d2",
  "macos-x86_64":
    "d0c920b2a126a74809fa1491411c9a097a44786cac9c2ca51b818a995581cf16",
  "macos-aarch64":
    "32b53df09872628059c789a69f02a6b8e29e14ddf26711421f3463f70c1aef17",
  "windows-x86_64":
    "b4508c445de1c1a68c760a01735da2aba2fa214b2aafd4b07f732e49b2a64b11",
};

export function resolveHerdrReleaseTarget(
  platform: string,
  arch: string,
): HerdrReleaseTarget | null {
  const os =
    platform === "linux"
      ? "linux"
      : platform === "darwin"
        ? "macos"
        : platform === "win32"
          ? "windows"
          : null;
  const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : null;
  if (!os || !cpu) return null;
  const candidate = `${os}-${cpu}` as HerdrReleaseTarget;
  return candidate in VERIFIED_HERDR_SHA256 ? candidate : null;
}

export function herdrReleaseAssetName(target: HerdrReleaseTarget): string {
  const base = `herdr-${target}`;
  // Windows ships a zip (herdr.exe + conpty/); Unix ships a raw binary.
  return target.startsWith("windows") ? `${base}.zip` : base;
}

export function herdrReleaseUrl(
  target: HerdrReleaseTarget,
  version: string = VERIFIED_HERDR_VERSION,
): string {
  return `https://github.com/herdrdev/herdr/releases/download/v${version}/${herdrReleaseAssetName(target)}`;
}

export function herdrInstallRoot(
  homeDir: string,
  appDataDir?: string,
  platform: string = process.platform,
): string {
  if (platform === "win32") {
    // Herdr's official Windows layout is a junctioned release store under
    // %USERPROFILE%\.herdr plus a visible bin shim; Roamgate does not
    // reimplement it and keeps its own managed directory instead.
    return join(
      appDataDir ?? join(homeDir, "AppData", "Roaming"),
      "roamgate",
      "herdr",
    );
  }
  // The official Unix installer location (install.sh): a single binary that
  // `herdr update` can replace in place afterwards.
  return join(homeDir, ".local", "bin");
}

export function herdrManagedBinaryPath(
  homeDir: string,
  appDataDir?: string,
  platform: string = process.platform,
  version: string = VERIFIED_HERDR_VERSION,
): string {
  const base = herdrInstallRoot(homeDir, appDataDir, platform);
  if (platform !== "win32") return join(base, "herdr");
  return join(base, version, "herdr.exe");
}

export interface InstallHerdrDeps {
  platform?: string;
  arch?: string;
  homeDir?: string;
  appDataDir?: string;
  download?: (url: string, destinationPath: string) => Promise<void>;
  runCommand?: (argv: string[]) => number;
  /** Test-only override; production installs always use the verified table. */
  expectedSha256?: string;
}

async function defaultDownload(
  url: string,
  destinationPath: string,
): Promise<void> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`Herdr download failed: HTTP ${response.status}`);
  }
  await Bun.write(destinationPath, response);
}

function powershellSingleQuotedString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Download the verified Herdr release into Roamgate's managed directory and
 * return the binary path. Idempotent: an existing managed binary is kept.
 */
export async function installVerifiedHerdr(
  deps: InstallHerdrDeps = {},
): Promise<{ binaryPath: string; version: string; installed: boolean }> {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const target = resolveHerdrReleaseTarget(platform, arch);
  if (!target) {
    throw new Error(
      `no verified Herdr ${VERIFIED_HERDR_VERSION} release for ${platform}-${arch}`,
    );
  }
  const homeDir = deps.homeDir ?? homedir();
  const appDataDir = deps.appDataDir ?? process.env.APPDATA;
  const binaryPath = herdrManagedBinaryPath(homeDir, appDataDir, platform);
  if (existsSync(binaryPath)) {
    return { binaryPath, version: VERIFIED_HERDR_VERSION, installed: false };
  }

  const download = deps.download ?? defaultDownload;
  const installRoot = herdrInstallRoot(homeDir, appDataDir, platform);
  const installDir =
    platform === "win32"
      ? join(installRoot, VERIFIED_HERDR_VERSION)
      : installRoot;
  mkdirSync(installRoot, { recursive: true });
  // Stage inside the install root so final renames stay on one filesystem.
  const staging = join(installRoot, `.staging-${process.pid}`);
  mkdirSync(staging, { recursive: true });
  try {
    const assetName = herdrReleaseAssetName(target);
    const archivePath = join(staging, assetName);
    await download(herdrReleaseUrl(target), archivePath);
    const actual = createHash("sha256")
      .update(new Uint8Array(await Bun.file(archivePath).arrayBuffer()))
      .digest("hex");
    const expectedSha256 = deps.expectedSha256 ?? VERIFIED_HERDR_SHA256[target];
    if (actual !== expectedSha256) {
      throw new Error(
        "downloaded Herdr checksum does not match the verified release",
      );
    }

    if (platform === "win32") {
      const runCommand =
        deps.runCommand ??
        ((argv: string[]) => Bun.spawnSync(argv).exitCode ?? 1);
      const extractDir = join(staging, "extracted");
      const code = runCommand([
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath ${powershellSingleQuotedString(archivePath)} -DestinationPath ${powershellSingleQuotedString(extractDir)} -Force`,
      ]);
      if (code !== 0) {
        throw new Error("could not extract the downloaded Herdr archive");
      }
      if (!existsSync(join(extractDir, "herdr.exe"))) {
        throw new Error("downloaded Herdr archive does not contain herdr.exe");
      }
      // Publish the complete layout (herdr.exe, conpty/ and notices) at once.
      renameSync(extractDir, installDir);
    } else {
      chmodSync(archivePath, 0o755);
      renameSync(archivePath, binaryPath);
    }
    return { binaryPath, version: VERIFIED_HERDR_VERSION, installed: true };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

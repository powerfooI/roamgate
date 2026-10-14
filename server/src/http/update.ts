import { basename } from "node:path";
import { roamgateEnv } from "../config/environment";

export type RunProcessWithCodeTimeout = (
  argv: string[],
  timeoutMs: number,
) => Promise<{ code: number; stdout: string; stderr: string }>;

const UPDATE_PLATFORMS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
] as const;

type UpdatePlatform = (typeof UPDATE_PLATFORMS)[number];

export interface UpdateTarget {
  platform: UpdatePlatform;
  packageDir: string;
  archiveName: string;
  manifestName: string;
}

export interface UpdateManifest {
  schema: 1;
  name: "roamgate";
  version: string;
  platform: string;
  archive: string;
  sha256: string;
}

interface UpdateRuntime {
  platform: string;
  arch: string;
  execPath: string;
  argv: string[];
}

const DEFAULT_UPDATE_BASE_URL =
  "https://github.com/powerfooI/roamgate/releases/latest/download";
const UPDATE_METADATA_MAX_BYTES = 4096;
const UPDATE_CHECK_CACHE_MS = 5 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 15000;
export const UPDATE_INSTALL_TIMEOUT_MS = 120000;
function hasUpdateConfirmation(req: Request): boolean {
  return (
    (req.headers.get("x-roamgate-update") ??
      req.headers.get("x-herdr-gui-update")) === "1"
  );
}
export const UPDATE_HTTP_IDLE_TIMEOUT_SECONDS =
  Math.ceil((UPDATE_CHECK_TIMEOUT_MS + UPDATE_INSTALL_TIMEOUT_MS) / 1000) + 15;

export function resolveUpdateTarget(
  platform: string,
  arch: string,
): UpdateTarget | null {
  const candidate = `${platform}-${arch}`;
  const updatePlatform = UPDATE_PLATFORMS.find(
    (publishedPlatform) => publishedPlatform === candidate,
  );
  if (updatePlatform === undefined) return null;
  return {
    platform: updatePlatform,
    packageDir: `roamgate-${updatePlatform}`,
    archiveName: `roamgate-${updatePlatform}.tar.xz`,
    manifestName: `roamgate-${updatePlatform}.update.json`,
  };
}

interface ParsedVersion {
  core: bigint[];
  prerelease: string[] | null;
}

function parsedVersion(value: string): ParsedVersion | null {
  const match = value.match(
    /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );
  if (!match) return null;
  return {
    core: match[1].split(".").map((part) => BigInt(part)),
    prerelease: match[2]?.split(".") ?? null,
  };
}

export function parseUpdateManifest(text: string): UpdateManifest {
  if (Buffer.byteLength(text) > UPDATE_METADATA_MAX_BYTES) {
    throw new Error("invalid update manifest");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("invalid update manifest");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid update manifest");
  }
  const manifest = value as Record<string, unknown>;
  if (
    manifest.schema !== 1 ||
    manifest.name !== "roamgate" ||
    typeof manifest.version !== "string" ||
    !parsedVersion(manifest.version) ||
    typeof manifest.platform !== "string" ||
    !/^[a-z0-9]+-[a-z0-9]+$/.test(manifest.platform) ||
    typeof manifest.archive !== "string" ||
    !/^roamgate-[a-z0-9-]+\.tar\.xz$/.test(manifest.archive) ||
    typeof manifest.sha256 !== "string" ||
    !/^[0-9a-fA-F]{64}$/.test(manifest.sha256)
  ) {
    throw new Error("invalid update manifest");
  }
  return {
    schema: 1,
    name: "roamgate",
    version: manifest.version,
    platform: manifest.platform,
    archive: manifest.archive,
    sha256: manifest.sha256.toLowerCase(),
  };
}

export function normalizeUpdateBaseUrl(value?: string): string {
  const candidate = value?.trim() || DEFAULT_UPDATE_BASE_URL;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("ROAMGATE_UPDATE_BASE_URL must be an HTTP(S) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("ROAMGATE_UPDATE_BASE_URL must be an HTTP(S) URL");
  }
  const loopbackHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/.test(url.hostname));
  if (url.protocol !== "https:" && !loopbackHttp) {
    throw new Error(
      "ROAMGATE_UPDATE_BASE_URL must use HTTPS unless the mirror is loopback",
    );
  }
  if (url.username || url.password) {
    throw new Error("ROAMGATE_UPDATE_BASE_URL must not contain credentials");
  }
  if (url.search || url.hash) {
    throw new Error(
      "ROAMGATE_UPDATE_BASE_URL must not contain a query or fragment",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/+$/, "");
}

export function compareVersion(a: string, b: string): number {
  const pa = parsedVersion(a);
  const pb = parsedVersion(b);
  if (!pa || !pb) throw new Error("invalid update version");
  for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i++) {
    const va = pa.core[i] ?? 0n;
    const vb = pb.core[i] ?? 0n;
    if (va !== vb) return va > vb ? 1 : -1;
  }
  if (pa.prerelease === null || pb.prerelease === null) {
    if (pa.prerelease === pb.prerelease) return 0;
    return pa.prerelease === null ? 1 : -1;
  }
  for (
    let i = 0;
    i < Math.max(pa.prerelease.length, pb.prerelease.length);
    i++
  ) {
    const va = pa.prerelease[i];
    const vb = pb.prerelease[i];
    if (va === undefined || vb === undefined) {
      if (va === vb) return 0;
      return va === undefined ? -1 : 1;
    }
    if (va === vb) continue;
    const aNumeric = /^\d+$/.test(va);
    const bNumeric = /^\d+$/.test(vb);
    if (aNumeric && bNumeric) return BigInt(va) > BigInt(vb) ? 1 : -1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return va > vb ? 1 : -1;
  }
  return 0;
}

/**
 * Verify and atomically install a release over targetPath, keeping the old
 * executable as targetPath.previous. Shared by the in-app and CLI updaters.
 */
export function renderUpdateInstallScript({
  targetPath,
  target,
  manifest,
  archiveUrl,
  curlTransport,
  shQuote,
}: {
  targetPath: string;
  target: UpdateTarget;
  manifest: UpdateManifest;
  archiveUrl: string;
  curlTransport: string;
  shQuote: (value: string) => string;
}): string {
  return `
set -eu
tmp="$(mktemp -d "\${TMPDIR:-/tmp}/roamgate-update.XXXXXX")"
target=${shQuote(targetPath)}
target_tmp=""
backup_tmp=""
if [ ! -f "$target" ] || [ -L "$target" ]; then
  echo "running executable is not a regular file" >&2
  exit 1
fi
cleanup() {
  rm -rf "$tmp"
  if [ -n "\${target_tmp:-}" ]; then
    rm -f "$target_tmp"
  fi
  if [ -n "\${backup_tmp:-}" ]; then
    rm -f "$backup_tmp"
  fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
archive="$tmp/${target.archiveName}"
expected_sha256=${shQuote(manifest.sha256)}
curl ${curlTransport} -fsSL ${shQuote(archiveUrl)} -o "$archive"
if command -v shasum >/dev/null 2>&1; then
  actual_sha256="$(shasum -a 256 "$archive" | awk 'NR == 1 { print $1 }')"
elif command -v sha256sum >/dev/null 2>&1; then
  actual_sha256="$(sha256sum "$archive" | awk 'NR == 1 { print $1 }')"
else
  echo "shasum or sha256sum is required to verify updates" >&2
  exit 1
fi
if [ "$actual_sha256" != "$expected_sha256" ]; then
  echo "downloaded archive checksum does not match update manifest" >&2
  exit 1
fi
tar -xJf "$archive" -C "$tmp" \
  ${shQuote(`${target.packageDir}/VERSION`)} \
  ${shQuote(`${target.packageDir}/roamgate`)}
package_dir="$tmp/${target.packageDir}"
version_file="$package_dir/VERSION"
binary="$package_dir/roamgate"
if [ ! -d "$package_dir" ] || [ -L "$package_dir" ] || \
   [ ! -f "$version_file" ] || [ -L "$version_file" ] || \
   [ ! -f "$binary" ] || [ -L "$binary" ] || [ ! -x "$binary" ]; then
  echo "downloaded archive does not contain regular package files" >&2
  exit 1
fi
expected_version=${shQuote(manifest.version)}
package_name=""
actual_version=""
actual_platform=""
extra_version_field=""
read -r package_name actual_version actual_platform extra_version_field < "$version_file"
if [ "$package_name" != "roamgate" ] || \
   [ "$actual_version" != "$expected_version" ] || \
   [ "$actual_platform" != ${shQuote(target.platform)} ] || \
   [ -n "$extra_version_field" ]; then
  echo "downloaded VERSION metadata does not match update manifest" >&2
  exit 1
fi
binary_version="$("$binary" --version)"
if [ "$binary_version" != "roamgate $expected_version" ]; then
  echo "downloaded binary version does not match update manifest" >&2
  exit 1
fi
if [ ! -f "$target" ] || [ -L "$target" ]; then
  echo "running executable changed during update" >&2
  exit 1
fi
target_dir="$(dirname "$target")"
target_base="$(basename "$target")"
target_tmp="$(mktemp "$target_dir/.$target_base.new.XXXXXX")"
install -m 0755 "$binary" "$target_tmp"
if [ -f "$target" ] && [ ! -L "$target" ]; then
  backup="$target.previous"
  backup_tmp="$(mktemp "$target_dir/.$target_base.previous.XXXXXX")"
  install -m 0755 "$target" "$backup_tmp"
  mv -f "$backup_tmp" "$backup"
  backup_tmp=""
fi
mv -f "$target_tmp" "$target"
target_tmp=""
`;
}

export function curlTransportArgs(baseUrl: string): string[] {
  const protocol = new URL(baseUrl).protocol === "https:" ? "=https" : "=http";
  return ["--proto", protocol, "--proto-redir", protocol];
}

/** Download, parse and check the latest manifest for one platform target. */
export async function fetchLatestUpdateManifest({
  baseUrl,
  target,
  runProcessWithCodeTimeout,
}: {
  baseUrl: string;
  target: UpdateTarget;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}): Promise<UpdateManifest> {
  const result = await runProcessWithCodeTimeout(
    [
      "curl",
      ...curlTransportArgs(baseUrl),
      "-fsSL",
      "--max-filesize",
      String(UPDATE_METADATA_MAX_BYTES),
      `${baseUrl}/${target.manifestName}`,
    ],
    UPDATE_CHECK_TIMEOUT_MS,
  );
  // Every Roamgate release has a manifest. Never probe legacy archives.
  if (result.code !== 0) {
    throw new Error(
      (
        result.stderr ||
        result.stdout ||
        `update manifest download exited ${result.code}`
      )
        .trim()
        .slice(0, 500),
    );
  }
  const manifest = parseUpdateManifest(result.stdout);
  if (manifest.platform !== target.platform) {
    throw new Error(
      `latest update platform is ${manifest.platform}, expected ${target.platform}`,
    );
  }
  if (manifest.archive !== target.archiveName) {
    throw new Error(
      `latest update archive is ${manifest.archive}, expected ${target.archiveName}`,
    );
  }
  return manifest;
}

export function isSupervisorManagedEnvironment(
  environment: Record<string, string | undefined>,
): boolean {
  const override = roamgateEnv("RESTART_SUPERVISOR", environment);
  if (override === "1") return true;
  if (override === "0") return false;
  if (environment.INVOCATION_ID) return true;
  const xpcServiceName = environment.XPC_SERVICE_NAME;
  return Boolean(xpcServiceName && xpcServiceName !== "0");
}

function updateJson(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store");
  return Response.json(body, { ...init, headers });
}

export function createUpdateHandlers({
  appVersion,
  runProcessWithCodeTimeout,
  shQuote,
  runtime: runtimeOverride,
  scheduleProcessExit: scheduleProcessExitOverride,
  environment: environmentOverride,
}: {
  appVersion: string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  shQuote: (value: string) => string;
  runtime?: UpdateRuntime;
  scheduleProcessExit?: () => void;
  environment?: Record<string, string | undefined>;
}) {
  const runtime: UpdateRuntime = runtimeOverride ?? {
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
    argv: process.argv,
  };
  const environment = environmentOverride ?? process.env;
  const updateTarget = resolveUpdateTarget(runtime.platform, runtime.arch);
  let updateBaseUrlValue: string | null = null;
  let updateBaseUrlError: Error | null = null;
  try {
    updateBaseUrlValue = normalizeUpdateBaseUrl(
      roamgateEnv("UPDATE_BASE_URL", environment),
    );
  } catch (error) {
    updateBaseUrlError = error as Error;
  }
  let updateInstallInProgress = false;
  let latestManifestCache: {
    expiresAt: number;
    value: UpdateManifest;
  } | null = null;
  let latestManifestRequest: Promise<UpdateManifest> | null = null;

  function updateBaseUrl(): string {
    if (updateBaseUrlError) throw updateBaseUrlError;
    if (!updateBaseUrlValue) throw new Error("invalid update base URL");
    return updateBaseUrlValue;
  }

  function updateArchiveUrl(): string {
    return updateTarget
      ? `${updateBaseUrl()}/${updateTarget.archiveName}`
      : updateBaseUrl();
  }

  function updateManifestUrl(): string {
    return updateTarget
      ? `${updateBaseUrl()}/${updateTarget.manifestName}`
      : updateBaseUrl();
  }

  function sourceDetails(): Record<string, string> {
    if (updateBaseUrlError) return {};
    return {
      source_url: updateArchiveUrl(),
      metadata_url: updateManifestUrl(),
    };
  }

  function curlTransportCommand(): string {
    return curlTransportArgs(updateBaseUrl()).map(shQuote).join(" ");
  }

  function autoUpdateCapability(): {
    canAutoUpdate: boolean;
    reason?: string;
    targetPath?: string;
  } {
    if (!updateTarget) {
      return {
        canAutoUpdate: false,
        reason: `Auto update is not available for ${runtime.platform}-${runtime.arch}.`,
      };
    }
    const invoked = runtime.argv[1] ?? "";
    const exeName = basename(runtime.execPath);
    if (exeName === "bun" || invoked.endsWith("src/index.ts")) {
      return {
        canAutoUpdate: false,
        reason: "Auto update is only available in the standalone binary.",
      };
    }
    if (!isSupervisorManagedEnvironment(environment)) {
      return {
        canAutoUpdate: false,
        reason:
          "Automatic updates require an external process supervisor such as systemd or launchd.",
      };
    }
    return { canAutoUpdate: true, targetPath: runtime.execPath };
  }

  // The updater owns replacement and shutdown only. An external supervisor
  // starts the new process after this response has had time to reach the client.
  function scheduleManagedExit() {
    if (scheduleProcessExitOverride) {
      scheduleProcessExitOverride();
      return;
    }
    const timer = setTimeout(() => {
      process.exit(0);
    }, 1000);
    if ("unref" in timer && typeof timer.unref === "function") {
      timer.unref();
    }
  }

  async function loadLatestUpdateManifest(): Promise<UpdateManifest> {
    if (!updateTarget) {
      throw new Error(
        `no update package is available for ${runtime.platform}-${runtime.arch}`,
      );
    }
    return fetchLatestUpdateManifest({
      baseUrl: updateBaseUrl(),
      target: updateTarget,
      runProcessWithCodeTimeout,
    });
  }

  async function readLatestUpdateManifest(
    forceRefresh = false,
  ): Promise<UpdateManifest> {
    if (
      !forceRefresh &&
      latestManifestCache &&
      latestManifestCache.expiresAt > Date.now()
    ) {
      return latestManifestCache.value;
    }
    if (latestManifestRequest) return latestManifestRequest;

    const request = loadLatestUpdateManifest();
    latestManifestRequest = request;
    try {
      const value = await request;
      latestManifestCache = {
        expiresAt: Date.now() + UPDATE_CHECK_CACHE_MS,
        value,
      };
      return value;
    } finally {
      if (latestManifestRequest === request) latestManifestRequest = null;
    }
  }

  async function updateInfoPayload(): Promise<Record<string, unknown>> {
    const capability = autoUpdateCapability();
    if (!updateTarget) {
      return {
        current_version: appVersion,
        update_available: false,
        can_auto_update: false,
        reason: capability.reason,
        platform: `${runtime.platform}-${runtime.arch}`,
        ...sourceDetails(),
      };
    }
    if (roamgateEnv("DISABLE_UPDATE_CHECK", environment) === "1") {
      return {
        current_version: appVersion,
        update_available: false,
        can_auto_update: false,
        reason:
          "Update checks are disabled by ROAMGATE_DISABLE_UPDATE_CHECK or HERDR_GUI_DISABLE_UPDATE_CHECK.",
        platform: updateTarget.platform,
        ...sourceDetails(),
      };
    }
    const latest = await readLatestUpdateManifest();
    return {
      current_version: appVersion,
      latest_version: latest.version,
      update_available: compareVersion(latest.version, appVersion) > 0,
      can_auto_update: capability.canAutoUpdate,
      reason: capability.reason,
      platform: latest.platform,
      ...sourceDetails(),
    };
  }

  async function handleUpdateCheck(req: Request): Promise<Response> {
    if (!hasUpdateConfirmation(req)) {
      return updateJson(
        { error: "Update confirmation header is required." },
        { status: 403 },
      );
    }
    try {
      return updateJson(await updateInfoPayload());
    } catch (e) {
      return updateJson(
        { error: (e as Error).message, ...sourceDetails() },
        { status: 502 },
      );
    }
  }

  async function handleUpdateInstall(req: Request): Promise<Response> {
    if (!hasUpdateConfirmation(req)) {
      return updateJson(
        { error: "Update confirmation header is required." },
        { status: 403 },
      );
    }

    const capability = autoUpdateCapability();
    if (!updateTarget) {
      return updateJson(
        {
          error: capability.reason ?? "Auto update is not available.",
          current_version: appVersion,
          ...sourceDetails(),
        },
        { status: 409 },
      );
    }
    if (!capability.canAutoUpdate || !capability.targetPath) {
      return updateJson(
        {
          error: capability.reason ?? "Auto update is not available.",
          current_version: appVersion,
          ...sourceDetails(),
        },
        { status: 409 },
      );
    }
    if (updateBaseUrlError) {
      return updateJson(
        { error: updateBaseUrlError.message, current_version: appVersion },
        { status: 500 },
      );
    }
    if (updateInstallInProgress) {
      return updateJson(
        {
          error: "An update installation is already in progress.",
          current_version: appVersion,
        },
        { status: 409 },
      );
    }

    updateInstallInProgress = true;
    let waitingForManagedRestart = false;
    try {
      const latest = await readLatestUpdateManifest(true);
      if (compareVersion(latest.version, appVersion) <= 0) {
        return updateJson({
          ok: true,
          installed: false,
          current_version: appVersion,
          latest_version: latest.version,
          message: "Already up to date.",
        });
      }

      const command = renderUpdateInstallScript({
        targetPath: capability.targetPath,
        target: updateTarget,
        manifest: latest,
        archiveUrl: updateArchiveUrl(),
        curlTransport: curlTransportCommand(),
        shQuote,
      });
      const result = await runProcessWithCodeTimeout(
        ["sh", "-c", command],
        UPDATE_INSTALL_TIMEOUT_MS,
      );
      if (result.code !== 0) {
        return updateJson(
          {
            error: (
              result.stderr ||
              result.stdout ||
              `install exited ${result.code}`
            )
              .trim()
              .slice(0, 1000),
            current_version: appVersion,
            latest_version: latest.version,
          },
          { status: 500 },
        );
      }
      scheduleManagedExit();
      // Keep the lock until this process exits so another connected client
      // cannot start replacing the binary during the restart grace period.
      waitingForManagedRestart = true;
      return updateJson({
        ok: true,
        installed: true,
        current_version: appVersion,
        installed_version: latest.version,
        restart_required: true,
        restart_scheduled: true,
        restart_mode: "supervisor",
        target_path: capability.targetPath,
        backup_path: `${capability.targetPath}.previous`,
      });
    } catch (e) {
      return updateJson(
        { error: (e as Error).message, ...sourceDetails() },
        { status: 500 },
      );
    } finally {
      if (!waitingForManagedRestart) updateInstallInProgress = false;
    }
  }

  return { handleUpdateCheck, handleUpdateInstall };
}

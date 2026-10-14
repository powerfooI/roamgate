import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readAuthToken } from "../config/auth-token";
import {
  assertSafeDataPath,
  dataRoot,
  defaultDataFile,
} from "../config/data-paths";
import { roamgateEnv } from "../config/environment";
import {
  browserUrlFor,
  getLanIPs,
  herdrConfigDir,
  isAnyHost,
  resolveHerdrSocketPaths,
  withLoginToken,
} from "../config/server-config";
import {
  DEFAULT_SERVICE_ENV_FILE,
  resolveLegacyServicePaths,
  resolveServicePaths,
  resolveServicePlatform,
  type ServicePaths,
  type ServicePlatform,
} from "../config/service-definitions";
import {
  parseServiceEnvironment,
  prepareServiceAccess,
  roamgateServiceStatus,
  runServiceCommand,
} from "../config/service-manager";
import type { CliContext, CliRuntime } from "./command";

/** Where the managed service's environment file lives, read but not parsed. */
export interface ServiceConfigFile {
  platform: ServicePlatform;
  paths: ServicePaths;
  /** The herdr-gui layout that the server still reads when files are missing. */
  legacyPaths: ServicePaths;
  /** The environment file in effect: current, else legacy, else current. */
  configPath: string;
  configExists: boolean;
  /** File contents, or the default template when the file does not exist. */
  contents: string;
  homeDir: string;
}

/** The managed service's configuration as the service process will see it. */
export interface ServiceSetup extends ServiceConfigFile {
  env: Record<string, string>;
}

/** The private data directory of the runtime's user, never the test runner's. */
export function runtimeDataRoot(runtime: CliRuntime): string {
  return dataRoot(runtime.homeDir, runtime.platform, runtime.appDataDir);
}

export function connectionRegistryPath(
  runtime: CliRuntime,
  env: Record<string, string>,
): string {
  return (
    roamgateEnv("CONNECTIONS_PATH", env) ??
    defaultDataFile(
      "connections.json",
      runtime.homeDir,
      runtime.platform,
      runtime.appDataDir,
    )
  );
}

/** Herdr sockets the service resolves from its environment file. */
export function serviceHerdrSockets(
  runtime: CliRuntime,
  env: Record<string, string>,
) {
  return resolveHerdrSocketPaths({
    socketPath: env.HERDR_SOCKET_PATH,
    clientSocketPath: env.HERDR_CLIENT_SOCKET_PATH,
    sshHost: env.HERDR_SSH_HOST,
    session: env.HERDR_SESSION,
    herdrDir: herdrConfigDir(
      runtime.platform,
      runtime.appDataDir,
      runtime.homeDir,
    ),
  });
}

export function serviceRuntime(runtime: CliRuntime) {
  return {
    platform: runtime.platform,
    homeDir: runtime.homeDir,
    appDataDir: runtime.appDataDir,
    execPath: runtime.execPath,
    argv: runtime.argv,
    uid: runtime.uid,
  };
}

/**
 * Locate and read the environment file without parsing it, so commands that
 * repair a broken file still work. Throws only for unsupported platforms and
 * unreadable or unsafe paths.
 */
export function locateServiceConfig(runtime: CliRuntime): ServiceConfigFile {
  const platform = resolveServicePlatform(runtime.platform);
  const paths = resolveServicePaths(
    platform,
    runtime.homeDir,
    runtime.appDataDir,
  );
  const legacy = resolveLegacyServicePaths(
    platform,
    runtime.homeDir,
    runtime.appDataDir,
  );
  // Inspection never migrates: prefer the new file, then the legacy one.
  const configPath =
    [paths.config, legacy.config].find((path) => existsSync(path)) ??
    paths.config;
  assertSafeDataPath(configPath);
  const configExists = existsSync(configPath);
  return {
    platform,
    paths,
    legacyPaths: legacy,
    configPath,
    configExists,
    contents: configExists
      ? readFileSync(configPath, "utf8")
      : DEFAULT_SERVICE_ENV_FILE,
    homeDir: runtime.homeDir,
  };
}

/** Also throws when the env file has entries the service could not load. */
export function readServiceSetup(runtime: CliRuntime): ServiceSetup {
  const file = locateServiceConfig(runtime);
  return {
    ...file,
    env: parseServiceEnvironment(
      file.contents,
      file.configPath,
      file.platform,
      file.homeDir,
    ),
  };
}

export interface ServiceAccessInfo {
  host: string;
  port: number;
  tls: boolean;
  auth: "password" | "token";
  /** Present when the generated token file exists and is valid. */
  token?: string;
  /** Why an existing token file is unusable; the server would refuse to start. */
  tokenError?: string;
  tokenPath: string;
  pinEnabled: boolean;
}

/** Like the server: the current token, else a legacy one it would migrate. */
export function generatedTokenPath(setup: ServiceConfigFile): string {
  const current = join(dirname(setup.paths.config), "auth-token");
  const legacy = join(dirname(setup.legacyPaths.config), "auth-token");
  return existsSync(current) || !existsSync(legacy) ? current : legacy;
}

/** Validated access settings plus the existing token; never creates one. */
export function readServiceAccess(setup: ServiceSetup): ServiceAccessInfo {
  const access = prepareServiceAccess(
    setup.configPath,
    setup.contents,
    setup.platform,
    setup.homeDir,
  );
  const tokenPath = generatedTokenPath(setup);
  let token: string | undefined;
  let tokenError: string | undefined;
  if (!access.usesFixedPassword && existsSync(tokenPath)) {
    // Report rather than throw, so `auth rotate` can replace a broken token.
    try {
      assertSafeDataPath(tokenPath);
      token = readAuthToken(tokenPath);
    } catch (error) {
      tokenError = (error as Error).message;
    }
  }
  return {
    host: access.host,
    port: access.port,
    tls: access.tls,
    auth: access.usesFixedPassword ? "password" : "token",
    token,
    tokenError,
    tokenPath,
    pinEnabled: Boolean(roamgateEnv("PIN", setup.env)),
  };
}

export interface AccessUrls {
  local: string;
  lan: string[];
}

/** Login URLs for this machine and, on wildcard binds, every LAN address. */
export function accessUrls(
  access: ServiceAccessInfo,
  lanIPs: () => string[] = getLanIPs,
): AccessUrls {
  const withToken = (url: string) =>
    access.auth === "token" ? withLoginToken(url, access.token) : url;
  return {
    local: withToken(browserUrlFor(access.host, access.port, access.tls)),
    lan: isAnyHost(access.host)
      ? lanIPs().map((ip) =>
          withToken(browserUrlFor(ip, access.port, access.tls)),
        )
      : [],
  };
}

export function serviceStatus(context: CliContext) {
  return roamgateServiceStatus(
    context.runtime,
    context.runCommand,
    context.captureCommand,
  );
}

/**
 * Restart the managed service when it is running so a configuration change
 * takes effect. Returns the exit code, or null when nothing was running.
 */
export function restartRunningService(context: CliContext): number | null {
  const status = serviceStatus(context);
  if (!status.installed || !status.active) return null;
  const code = runServiceCommand(["service", "restart"], {
    runtime: serviceRuntime(context.runtime),
    runCommand: context.runCommand,
    log: context.log,
    error: context.error,
  });
  return typeof code === "number" ? code : 1;
}

/** The address a local client uses to reach the configured listener. */
export function probeUrl(
  access: Pick<ServiceAccessInfo, "host" | "port" | "tls">,
) {
  const host = isAnyHost(access.host)
    ? access.host === "::"
      ? "[::1]"
      : "127.0.0.1"
    : access.host.includes(":") && !access.host.startsWith("[")
      ? `[${access.host}]`
      : access.host;
  return `${access.tls ? "https" : "http"}://${host}:${access.port}/healthz`;
}

export type ListenerProbe = (
  access: Pick<ServiceAccessInfo, "host" | "port" | "tls">,
) => Promise<boolean>;

/** Whether a Roamgate listener answers its unauthenticated health check. */
export const probeListener: ListenerProbe = async (access) => {
  try {
    const response = await fetch(probeUrl(access), {
      redirect: "manual",
      signal: AbortSignal.timeout(2_000),
      // Health checks only identify the listener; self-signed local
      // certificates are common, and no credentials are sent.
      tls: { rejectUnauthorized: false },
    });
    const body = await response.text();
    return response.status === 200 && body === "Ok";
  } catch {
    return false;
  }
};

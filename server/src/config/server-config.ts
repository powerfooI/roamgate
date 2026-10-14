import { homedir, networkInterfaces, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createSecureContext } from "node:tls";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { validateSshDestination } from "../bridge/ssh-command";
import { assertSshTunnelPlatformSupported } from "../bridge/ssh-tunnel";
import {
  assertValidAuthPassword,
  assertValidAuthPin,
  defaultAuthTokenPath,
  loadOrCreateAuthToken,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from "./auth-token";
import { roamgateEnv } from "./environment";
import { dataRoot } from "./data-paths";
import { type LogLevel, parseLogLevel, serverLogger } from "../utils/logger";
import {
  parseTaskNotificationSource,
  type TaskNotificationSource,
} from "../notifications/herdr-notification-listener";

type CliArgs = Partial<{
  host: string;
  port: string;
  password: string;
  "tls-cert": string;
  "tls-key": string;
  "socket-path": string;
  "client-socket-path": string;
  "ssh-host": string;
  session: string;
  "public-dir": string;
  "log-level": string;
  "notification-source": string;
  profile: boolean;
  "profile-duration": string;
  "profile-dir": string;
  open: boolean;
  help: boolean;
  version: boolean;
}>;

export type ServerConfig = {
  appVersion: string;
  host: string;
  port: number;
  password: string;
  authRequired: boolean;
  pin?: string;
  tls?: { cert: Buffer; key: Buffer };
  generatedAuthToken?: string;
  generatedAuthTokenPath?: string;
  socketPath: string;
  clientSocketPath: string;
  publicDir: string;
  sshHost?: string;
  session?: string;
  openBrowserRequested: boolean;
  logLevel: LogLevel;
  taskNotificationSource: TaskNotificationSource;
  profile?: { directory: string; durationMs: number };
  hasExplicitSocketPath: boolean;
  hasExplicitClientSocketPath: boolean;
};

const cliOptions = {
  host: { type: "string" },
  port: { type: "string" },
  password: { type: "string" },
  "tls-cert": { type: "string" },
  "tls-key": { type: "string" },
  "socket-path": { type: "string" },
  "client-socket-path": { type: "string" },
  "ssh-host": { type: "string" },
  session: { type: "string" },
  "public-dir": { type: "string" },
  "log-level": { type: "string" },
  "notification-source": { type: "string" },
  profile: { type: "boolean" },
  "profile-duration": { type: "string" },
  "profile-dir": { type: "string" },
  open: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
} as const;

/** Long server flags, for shell completion. */
export const SERVER_FLAGS = Object.keys(cliOptions).map((name) => `--${name}`);

export function resolveServerLogLevel(
  cliValue: string | undefined,
  envValue: string | undefined,
): LogLevel {
  return parseLogLevel(cliValue ?? envValue ?? "info");
}

export function resolveServerProfile(
  enabled: boolean,
  duration: string | undefined,
  directory: string | undefined,
): ServerConfig["profile"] {
  if (!enabled) return undefined;
  const seconds = Number(duration ?? "30");
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300)
    throw new Error(
      "--profile-duration must be an integer from 1 to 300 seconds.",
    );
  if (directory !== undefined && !directory.trim())
    throw new Error("--profile-dir must not be empty.");
  return {
    durationMs: seconds * 1_000,
    directory: resolve(directory ?? join(dataRoot(), "profiles")),
  };
}

export function loadServerTls(
  certPath: string | undefined,
  keyPath: string | undefined,
): ServerConfig["tls"] {
  if (!certPath && !keyPath) return undefined;
  if (!certPath || !keyPath) {
    throw new Error(
      "TLS requires both --tls-cert and --tls-key (or ROAMGATE_TLS_CERT and ROAMGATE_TLS_KEY).",
    );
  }
  try {
    const tls = { cert: readFileSync(certPath), key: readFileSync(keyPath) };
    createSecureContext(tls);
    return tls;
  } catch (error) {
    throw new Error(`Invalid TLS configuration: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

/** The server's own flags, shared by `roamgate --help` and `roamgate help`. */
export function serverOptionsHelp(): string {
  return `Options (flags override env vars; ROAMGATE_* overrides HERDR_GUI_*):
  --host <addr>              listen address        (env HOST,            default 127.0.0.1)
  --port <n>                 listen port           (env PORT,            default 8787)
  --password <pw>            fixed login password, ${MIN_PASSWORD_LENGTH}..${MAX_PASSWORD_LENGTH} characters
                             (env ROAMGATE_PASSWORD; otherwise a token is generated)
  (env ROAMGATE_PIN)         optional 6..12 digit convenience login; private networks only
  --tls-cert <path>          PEM certificate chain (env ROAMGATE_TLS_CERT; requires --tls-key)
  --tls-key <path>           PEM private key       (env ROAMGATE_TLS_KEY; requires --tls-cert)
  --socket-path <path>       control socket        (env HERDR_SOCKET_PATH)
  --client-socket-path <p>   render socket         (env HERDR_CLIENT_SOCKET_PATH)
  --ssh-host <user@host>     remote Herdr over SSH (env HERDR_SSH_HOST)
  --session <name>           named herdr session   (env HERDR_SESSION)
  --public-dir <path>        static assets dir     (env PUBLIC_DIR,      default: embedded)
  --log-level <level>        error|warn|info|debug  (env ROAMGATE_LOG_LEVEL, default: info)
  --notification-source <s>  herdr|status: task alerts follow Herdr notifications or
                             Roamgate's own status tracker (env ROAMGATE_NOTIFICATION_SOURCE, default: herdr)
  --profile                  capture server CPU samples (env ROAMGATE_PROFILE=1)
  --profile-duration <secs>   capture for 1..300 seconds (env ROAMGATE_PROFILE_DURATION, default: 30)
  --profile-dir <path>        output parent directory (env ROAMGATE_PROFILE_DIR, default: Roamgate data dir/profiles)
  --open                     open browser on start (env OPEN_BROWSER=1)
  -V, --version              show version
  -h, --help                 show this help
`;
}

function serverHelp(): string {
  return `Roamgate — Web and PWA client for Herdr

Usage: roamgate [options]

${serverOptionsHelp()}`;
}

export function loadServerConfig(
  appVersion: string,
  options: { helpText?: () => string } = {},
): ServerConfig {
  let args: CliArgs;
  try {
    args = parseArgs({
      args: process.argv.slice(2),
      options: cliOptions,
      strict: true,
      allowPositionals: false,
    }).values as CliArgs;
  } catch (e) {
    console.error(`[bridge] ${(e as Error).message}`);
    console.error("Run `roamgate --help` for usage.");
    process.exit(2);
  }

  if (args.help) {
    console.log(options.helpText?.() ?? serverHelp());
    process.exit(0);
  }

  if (args.version) {
    console.log(`roamgate ${appVersion}`);
    process.exit(0);
  }

  let logLevel: LogLevel;
  try {
    logLevel = resolveServerLogLevel(
      args["log-level"],
      roamgateEnv("LOG_LEVEL"),
    );
  } catch (error) {
    console.error(`[bridge] ${(error as Error).message}`);
    process.exit(2);
  }

  let taskNotificationSource: TaskNotificationSource;
  try {
    taskNotificationSource = parseTaskNotificationSource(
      args["notification-source"] ?? roamgateEnv("NOTIFICATION_SOURCE"),
    );
  } catch (error) {
    console.error(`[bridge] ${(error as Error).message}`);
    process.exit(2);
  }

  let profile: ServerConfig["profile"];
  try {
    profile = resolveServerProfile(
      args.profile === true || roamgateEnv("PROFILE") === "1",
      args["profile-duration"] ?? roamgateEnv("PROFILE_DURATION"),
      args["profile-dir"] ?? roamgateEnv("PROFILE_DIR"),
    );
  } catch (error) {
    console.error(`[bridge] ${(error as Error).message}`);
    process.exit(2);
  }

  const host = String(args.host ?? process.env.HOST ?? "127.0.0.1");
  const port = Number(args.port ?? process.env.PORT ?? 8787);
  // Bun inlines direct process.env.NODE_ENV reads when compiling. Authentication
  // must use the running process's environment, not the build environment.
  const { NODE_ENV: nodeEnvironment } = process.env;
  const authRequired =
    nodeEnvironment !== "development" ||
    !["127.0.0.1", "localhost", "::1"].includes(host);
  let tls: ServerConfig["tls"];
  try {
    tls = loadServerTls(
      args["tls-cert"] ?? roamgateEnv("TLS_CERT"),
      args["tls-key"] ?? roamgateEnv("TLS_KEY"),
    );
  } catch (error) {
    console.error(`[bridge] ${(error as Error).message}`);
    process.exit(2);
  }
  const pin = roamgateEnv("PIN") || undefined;
  try {
    if (pin !== undefined) assertValidAuthPin(pin);
  } catch (error) {
    console.error(`[bridge] ${(error as Error).message}`);
    process.exit(2);
  }
  const configuredPassword = String(
    args.password ?? roamgateEnv("PASSWORD") ?? "",
  );
  try {
    if (authRequired && configuredPassword)
      assertValidAuthPassword(configuredPassword);
  } catch (error) {
    console.error(`[bridge] ${(error as Error).message}`);
    process.exit(2);
  }
  const generatedAuthTokenPath =
    authRequired && !configuredPassword ? defaultAuthTokenPath() : undefined;
  let generatedAuthToken: string | undefined;
  try {
    generatedAuthToken = generatedAuthTokenPath
      ? loadOrCreateAuthToken(generatedAuthTokenPath)
      : undefined;
  } catch (cause) {
    console.error(
      `[bridge] FATAL: could not load the generated auth token: ${(cause as Error).message}`,
    );
    process.exit(1);
  }
  const password = authRequired
    ? configuredPassword || generatedAuthToken || ""
    : "";

  const sshHostValue =
    (typeof args["ssh-host"] === "string" && args["ssh-host"]) ||
    process.env.HERDR_SSH_HOST ||
    undefined;
  let sshHost: string | undefined;
  try {
    sshHost = sshHostValue ? validateSshDestination(sshHostValue) : undefined;
    if (sshHost) assertSshTunnelPlatformSupported();
  } catch (error) {
    console.error(`[bridge] ${(error as Error).message}`);
    process.exit(2);
  }
  const session =
    (typeof args.session === "string" && args.session) ||
    process.env.HERDR_SESSION ||
    undefined;
  const hasExplicitSocketPath =
    typeof args["socket-path"] === "string" || !!process.env.HERDR_SOCKET_PATH;
  const hasExplicitClientSocketPath =
    typeof args["client-socket-path"] === "string" ||
    !!process.env.HERDR_CLIENT_SOCKET_PATH;

  const { socketPath, clientSocketPath } = resolveSocketPaths(
    args,
    sshHost,
    session,
  );

  return {
    appVersion,
    host,
    port,
    password,
    authRequired,
    pin,
    tls,
    generatedAuthToken,
    generatedAuthTokenPath,
    socketPath,
    clientSocketPath,
    publicDir: resolvePublicDir(args),
    sshHost,
    session,
    openBrowserRequested:
      args.open === true || process.env.OPEN_BROWSER === "1",
    logLevel,
    taskNotificationSource,
    profile,
    hasExplicitSocketPath,
    hasExplicitClientSocketPath,
  };
}

function remoteTunnelLocalPath(
  host: string | undefined,
  session: string | undefined,
  kind: "control" | "client",
): string {
  const hostKey = host ?? "remote";
  const sessionKey = session ?? "default";
  // A short deterministic filename identifier, not an authentication secret.
  // Keep it bounded for Unix socket path limits regardless of input length.
  const key = createHash("sha256")
    .update(`${hostKey}\0${sessionKey}\0${kind}`)
    .digest("hex")
    .slice(0, 12);
  return join(tmpdir(), `roamgate-${key}-${kind}.sock`);
}

export function herdrConfigDir(
  platform: string = process.platform,
  appData: string | null | undefined = process.env.APPDATA,
  homeDir: string = homedir(),
): string {
  if (platform === "win32") {
    return join(appData ?? join(homeDir, "AppData", "Roaming"), "herdr");
  }
  return join(homeDir, ".config", "herdr");
}

export function nativeSocketPath(
  socketPath: string,
  platform: string = process.platform,
): string {
  const lowerPath = socketPath.toLowerCase();
  if (
    platform !== "win32" ||
    lowerPath.startsWith("\\\\.\\pipe\\") ||
    lowerPath.startsWith("\\\\?\\pipe\\")
  ) {
    return socketPath;
  }
  return `\\\\.\\pipe\\${socketPath}`;
}

export type HerdrSocketSettings = {
  socketPath?: string;
  clientSocketPath?: string;
  sshHost?: string;
  session?: string;
  /** Herdr's configuration directory; defaults to this process's user. */
  herdrDir?: string;
};

/**
 * Resolve the control and render sockets from already-merged settings, so
 * management commands can apply the service environment instead of the shell's.
 */
export function resolveHerdrSocketPaths(settings: HerdrSocketSettings): {
  socketPath: string;
  clientSocketPath: string;
} {
  const resolveOne = (
    explicit: string | undefined,
    kind: "control" | "client",
  ) => {
    if (explicit) return nativeSocketPath(explicit);
    if (settings.sshHost)
      return remoteTunnelLocalPath(settings.sshHost, settings.session, kind);
    const base = settings.herdrDir ?? herdrConfigDir();
    const name = kind === "control" ? "herdr.sock" : "herdr-client.sock";
    const socketPath = settings.session
      ? resolve(base, "sessions", settings.session, name)
      : resolve(base, name);
    return nativeSocketPath(socketPath);
  };
  return {
    socketPath: resolveOne(settings.socketPath, "control"),
    clientSocketPath: resolveOne(settings.clientSocketPath, "client"),
  };
}

function resolveSocketPaths(
  args: CliArgs,
  sshHost: string | undefined,
  session: string | undefined,
) {
  // An explicit empty flag is still explicit and selects nativeSocketPath("").
  const socketPath = args["socket-path"];
  const clientSocketPath = args["client-socket-path"];
  const resolved = resolveHerdrSocketPaths({
    socketPath: socketPath || process.env.HERDR_SOCKET_PATH,
    clientSocketPath: clientSocketPath || process.env.HERDR_CLIENT_SOCKET_PATH,
    sshHost,
    session,
  });
  return {
    socketPath:
      typeof socketPath === "string" && !socketPath
        ? nativeSocketPath(socketPath)
        : resolved.socketPath,
    clientSocketPath:
      typeof clientSocketPath === "string" && !clientSocketPath
        ? nativeSocketPath(clientSocketPath)
        : resolved.clientSocketPath,
  };
}

function resolvePublicDir(args: CliArgs): string {
  const fromFlag = args["public-dir"];
  if (typeof fromFlag === "string") return fromFlag;
  if (process.env.PUBLIC_DIR) return process.env.PUBLIC_DIR;
  const exeDir = dirname(process.execPath);
  const nextToExe = join(exeDir, "public");
  if (existsSync(nextToExe)) return nextToExe;
  return join(process.cwd(), "public");
}

export function getLanIPs(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((ifaces) => ifaces ?? [])
    .filter(({ family, internal }) => family === "IPv4" && !internal)
    .map(({ address }) => address);
}

export function isAnyHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}

function formatUrlHost(host: string): string {
  if (host === "127.0.0.1" || host === "::1") return "localhost";
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

export function browserUrlFor(host: string, port: number, tls = false): string {
  const browserHost = isAnyHost(host) ? "localhost" : formatUrlHost(host);
  return `${tls ? "https" : "http"}://${browserHost}:${port}`;
}

export function withLoginToken(url: string, token?: string): string {
  if (!token) return url;
  try {
    const result = new URL(url);
    result.searchParams.set("token", token);
    return result.toString();
  } catch {
    return url;
  }
}

export function openBrowser(config: ServerConfig, url: string) {
  if (!config.openBrowserRequested) return;
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const openerArgs =
    process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    Bun.spawn([opener, ...openerArgs], { stdout: "ignore", stderr: "ignore" });
  } catch (e) {
    serverLogger.child("browser").warn("failed to open browser", { error: e });
  }
}

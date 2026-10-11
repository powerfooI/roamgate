import { existsSync, rmSync } from "node:fs";
import { type Logger, silentLogger } from "../utils/logger";
import { sshCommandArgv, sshTunnelArgv } from "./ssh-command";
import { createWindowsSshTunnel } from "./ssh-windows";

const SSH_STDERR_MAX_BYTES = 16 * 1024;

export type SshTunnelFailureKind =
  | "authentication"
  | "host-key"
  | "unreachable"
  | "unsupported"
  | "exited";

export class SshTunnelError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly kind: SshTunnelFailureKind,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = "SshTunnelError";
  }
}

export function classifySshTunnelFailure(
  exitCode: number,
  stderr: string,
): SshTunnelError {
  const diagnostic = stderr
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
  if (
    diagnostic.includes("remote host identification has changed") ||
    diagnostic.includes("host key verification failed") ||
    diagnostic.includes("no matching host key type found")
  ) {
    return new SshTunnelError(
      "SSH host-key verification failed; verify the host outside Roamgate",
      false,
      "host-key",
      exitCode,
    );
  }
  if (
    diagnostic.includes("permission denied") ||
    diagnostic.includes("no supported authentication methods") ||
    diagnostic.includes("too many authentication failures")
  ) {
    return new SshTunnelError(
      "SSH authentication failed; verify the service user's OpenSSH agent and config",
      false,
      "authentication",
      exitCode,
    );
  }
  if (
    diagnostic.includes("connection timed out") ||
    diagnostic.includes("connection refused") ||
    diagnostic.includes("no route to host") ||
    diagnostic.includes("could not resolve hostname") ||
    diagnostic.includes("operation timed out")
  ) {
    return new SshTunnelError(
      "SSH destination is temporarily unreachable",
      true,
      "unreachable",
      exitCode,
    );
  }
  return new SshTunnelError(
    `SSH tunnel exited unexpectedly (code ${exitCode})`,
    true,
    "exited",
    exitCode,
  );
}

export async function readBoundedStderr(
  stream: ReadableStream<Uint8Array> | null,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  let retained = new Uint8Array(0);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength >= SSH_STDERR_MAX_BYTES) {
        retained = value.slice(value.byteLength - SSH_STDERR_MAX_BYTES);
        continue;
      }
      const combinedLength = Math.min(
        SSH_STDERR_MAX_BYTES,
        retained.byteLength + value.byteLength,
      );
      const combined = new Uint8Array(combinedLength);
      const retainedStart = Math.max(
        0,
        retained.byteLength + value.byteLength - SSH_STDERR_MAX_BYTES,
      );
      const retainedTail = retained.subarray(retainedStart);
      combined.set(retainedTail, 0);
      combined.set(value, retainedTail.byteLength);
      retained = combined;
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(retained);
}

export function assertSshTunnelPlatformSupported(
  platform: string = process.platform,
): void {
  if (platform === "win32") {
    throw new SshTunnelError(
      "SSH connections from Windows are not supported because Roamgate's stream-local forwarding cannot create a local Windows named pipe",
      false,
      "unsupported",
      -1,
    );
  }
}

export type SshTunnelConfig = {
  socketPath: string;
  clientSocketPath: string;
  sshHost?: string;
  session?: string;
  hasExplicitSocketPath: boolean;
  hasExplicitClientSocketPath: boolean;
  remoteSocketPath?: string;
  remoteClientSocketPath?: string;
  ownedRuntimeDirectory?: string;
  remotePlatform?: "windows";
  remoteHerdrPath?: string;
};

export type RunProcess = (
  argv: string[],
  input?: string,
) => Promise<{ stdout: string; stderr: string }>;

type TunnelProcess = {
  exited: Promise<number>;
  stderr?: Promise<string>;
  kill: (signal?: number) => void;
};

type ScheduledPoll = {
  cancel: () => void;
};

type SocketWait = {
  promise: Promise<void>;
  cancel: () => void;
};

class SocketWaitCancelledError extends Error {}

export type SshTunnelManager = {
  startAutoSshTunnel(): Promise<void>;
  cleanupAutoSshTunnel(): Promise<void>;
};

export function createSshTunnelManager(args: {
  connectionId?: string;
  formatError?: (error: unknown) => string;
  logger?: Logger;
  config: SshTunnelConfig;
  runProcess: RunProcess;
  onUnexpectedExit?: (error: SshTunnelError) => void;
  dependencies?: {
    exists?: (path: string) => boolean;
    remove?: (path: string) => void;
    removeDirectory?: (path: string) => void;
    spawn?: (argv: string[]) => TunnelProcess;
    schedulePoll?: (callback: () => void, delayMs: number) => ScheduledPoll;
    now?: () => number;
    socketWaitTimeoutMs?: number;
    socketPollIntervalMs?: number;
    processStopTimeoutMs?: number;
    processForceKillTimeoutMs?: number;
    platform?: string;
  };
}): SshTunnelManager {
  if (args.config.remotePlatform === "windows") {
    assertSshTunnelPlatformSupported(args.dependencies?.platform);
    return createWindowsSshTunnel(args);
  }
  const logger = args.logger ?? silentLogger;
  const platform = args.dependencies?.platform ?? process.platform;
  const exists = args.dependencies?.exists ?? existsSync;
  const formatError =
    args.formatError ??
    ((error: unknown) =>
      (error instanceof Error ? error.message : String(error))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300));
  const connectionDetail = `connection=${args.connectionId ?? "legacy-default"}`;
  const remove =
    args.dependencies?.remove ?? ((path) => rmSync(path, { force: true }));
  const removeDirectory =
    args.dependencies?.removeDirectory ??
    ((path: string) => rmSync(path, { force: true, recursive: true }));
  const spawn =
    args.dependencies?.spawn ??
    ((argv: string[]): TunnelProcess => {
      const proc = Bun.spawn(argv, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        env: { ...process.env, LC_ALL: "C" },
      });
      return {
        exited: proc.exited,
        stderr: readBoundedStderr(proc.stderr),
        kill: (signal) => proc.kill(signal),
      };
    });
  const schedulePoll =
    args.dependencies?.schedulePoll ??
    ((callback: () => void, delayMs: number) => {
      const timer = setTimeout(callback, delayMs);
      return { cancel: () => clearTimeout(timer) };
    });
  const now = args.dependencies?.now ?? Date.now;
  const socketWaitTimeoutMs = args.dependencies?.socketWaitTimeoutMs ?? 8000;
  const socketPollIntervalMs = args.dependencies?.socketPollIntervalMs ?? 100;
  const processStopTimeoutMs = args.dependencies?.processStopTimeoutMs ?? 1500;
  const processForceKillTimeoutMs =
    args.dependencies?.processForceKillTimeoutMs ?? 1000;
  let cachedRemoteHome: { host: string; home: string } | null = null;
  let autoSshTunnel: TunnelProcess | null = null;
  let processStopTask: Promise<void> | null = null;
  let autoSshTunnelPaths: string[] = [];
  let activeSocketWait: SocketWait | null = null;
  let lifecycleGeneration = 0;
  let disposed = false;
  let cleanupTask: Promise<void> | null = null;

  async function remoteHome(host: string): Promise<string> {
    if (cachedRemoteHome?.host === host) return cachedRemoteHome.home;
    const { stdout } = await args.runProcess(
      sshCommandArgv(host, `printf %s "$HOME"`),
    );
    const home = stdout.trim();
    if (!home.startsWith("/")) {
      throw new Error(`could not resolve remote HOME for ${host}`);
    }
    cachedRemoteHome = { host, home };
    return home;
  }

  async function remoteHerdrSocketPath(
    host: string,
    kind: "control" | "client",
  ): Promise<string> {
    const home = await remoteHome(host);
    const base = `${home}/.config/herdr`;
    const filename = kind === "control" ? "herdr.sock" : "herdr-client.sock";
    if (args.config.session) {
      return `${base}/sessions/${args.config.session}/${filename}`;
    }
    return `${base}/${filename}`;
  }

  function waitForLocalSockets(
    paths: string[],
    generation: number,
  ): SocketWait {
    const started = now();
    let scheduled: ScheduledPoll | null = null;
    let settled = false;
    let resolveWait!: () => void;
    let rejectWait!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveWait = resolve;
      rejectWait = reject;
    });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      scheduled?.cancel();
      scheduled = null;
      if (error) rejectWait(error);
      else resolveWait();
    };
    const tick = () => {
      scheduled = null;
      if (generation !== lifecycleGeneration) {
        finish(new SocketWaitCancelledError("ssh socket wait cancelled"));
        return;
      }
      if (paths.every((path) => exists(path))) {
        finish();
        return;
      }
      if (now() - started > socketWaitTimeoutMs) {
        finish(
          new Error(
            `ssh tunnel did not create local socket(s): ${paths.join(", ")}`,
          ),
        );
        return;
      }
      scheduled = schedulePoll(tick, socketPollIntervalMs);
    };
    tick();
    return {
      promise,
      cancel: () =>
        finish(new SocketWaitCancelledError("ssh socket wait cancelled")),
    };
  }

  async function failureForProcess(
    proc: TunnelProcess,
    exitCode: number,
  ): Promise<SshTunnelError> {
    const stderr = await proc.stderr?.catch(() => "");
    return classifySshTunnelFailure(exitCode, stderr ?? "");
  }

  async function processExitedWithin(
    proc: TunnelProcess,
    timeoutMs: number,
  ): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        proc.exited.then(
          () => true,
          () => true,
        ),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function stopTunnelProcess(): Promise<void> {
    if (processStopTask) return processStopTask;
    const proc = autoSshTunnel;
    if (!proc) return;
    autoSshTunnel = null;
    const task = (async () => {
      try {
        proc.kill();
      } catch (error) {
        logger.warn("unable to stop SSH tunnel", {
          connection: args.connectionId ?? "legacy-default",
          error: formatError(error),
        });
      }
      if (await processExitedWithin(proc, processStopTimeoutMs)) return;
      try {
        proc.kill(9);
      } catch (error) {
        logger.warn("unable to force-stop SSH tunnel", {
          connection: args.connectionId ?? "legacy-default",
          error: formatError(error),
        });
      }
      if (!(await processExitedWithin(proc, processForceKillTimeoutMs))) {
        throw new Error(
          `SSH tunnel did not exit after forced termination ${connectionDetail}`,
        );
      }
    })();
    processStopTask = task;
    try {
      await task;
    } finally {
      if (processStopTask === task) processStopTask = null;
    }
  }

  async function startAutoSshTunnel(): Promise<void> {
    if (disposed) throw new Error("SSH tunnel manager is disposed");
    const host = args.config.sshHost;
    if (!host) return;
    assertSshTunnelPlatformSupported(platform);
    const generation = ++lifecycleGeneration;
    activeSocketWait?.cancel();
    activeSocketWait = null;
    await stopTunnelProcess();
    if (generation !== lifecycleGeneration) return;

    const forwards: Array<{ local: string; remote: string; label: string }> =
      [];
    if (args.config.remoteSocketPath || !args.config.hasExplicitSocketPath) {
      const remote =
        args.config.remoteSocketPath ??
        (await remoteHerdrSocketPath(host, "control"));
      if (generation !== lifecycleGeneration) return;
      forwards.push({
        local: args.config.socketPath,
        remote,
        label: "herdr socket",
      });
    }
    if (
      args.config.remoteClientSocketPath ||
      !args.config.hasExplicitClientSocketPath
    ) {
      const remote =
        args.config.remoteClientSocketPath ??
        (await remoteHerdrSocketPath(host, "client"));
      if (generation !== lifecycleGeneration) return;
      forwards.push({
        local: args.config.clientSocketPath,
        remote,
        label: "herdr client socket",
      });
    }
    if (forwards.length === 0) return;

    autoSshTunnelPaths = forwards.map((forward) => forward.local);
    for (const path of autoSshTunnelPaths) remove(path);

    const argv = sshTunnelArgv(host, forwards);

    logger.debug("starting SSH tunnel", {
      connection: args.connectionId ?? "legacy-default",
      destination: formatError(host),
    });
    for (const forward of forwards) {
      logger.debug("SSH tunnel forwarding socket", {
        connection: args.connectionId ?? "legacy-default",
        label: forward.label,
        local: forward.local,
        remote: forward.remote,
      });
    }

    const proc = spawn(argv);
    autoSshTunnel = proc;
    const socketWait = waitForLocalSockets(autoSshTunnelPaths, generation);
    activeSocketWait = socketWait;
    let outcome: { ready: true } | { ready: false; code: number };
    try {
      outcome = await Promise.race([
        socketWait.promise.then(() => ({ ready: true }) as const),
        proc.exited.then((code) => ({ ready: false, code }) as const),
      ]);
    } catch (error) {
      if (
        generation !== lifecycleGeneration &&
        error instanceof SocketWaitCancelledError
      ) {
        return;
      }
      if (autoSshTunnel === proc) await stopTunnelProcess();
      throw error;
    } finally {
      socketWait.cancel();
      if (activeSocketWait === socketWait) activeSocketWait = null;
    }
    if (generation !== lifecycleGeneration) return;
    if (!outcome.ready) {
      if (autoSshTunnel === proc) autoSshTunnel = null;
      throw await failureForProcess(proc, outcome.code);
    }

    void proc.exited
      .then(async (code) => {
        const failure = await failureForProcess(proc, code);
        if (
          disposed ||
          generation !== lifecycleGeneration ||
          autoSshTunnel !== proc
        ) {
          return;
        }
        autoSshTunnel = null;
        args.onUnexpectedExit?.(failure);
      })
      .catch((error) => {
        if (
          disposed ||
          generation !== lifecycleGeneration ||
          autoSshTunnel !== proc
        ) {
          return;
        }
        autoSshTunnel = null;
        args.onUnexpectedExit?.(
          new SshTunnelError(
            `SSH tunnel process failed: ${formatError(error)}`,
            true,
            "exited",
            -1,
          ),
        );
      });

    logger.debug("SSH tunnel ready", {
      connection: args.connectionId ?? "legacy-default",
    });
  }

  function cleanupAutoSshTunnel(): Promise<void> {
    if (cleanupTask) return cleanupTask;
    disposed = true;
    lifecycleGeneration += 1;
    activeSocketWait?.cancel();
    activeSocketWait = null;
    const paths = autoSshTunnelPaths;
    autoSshTunnelPaths = [];
    cleanupTask = (async () => {
      await stopTunnelProcess();
      for (const path of paths) remove(path);
      if (args.config.ownedRuntimeDirectory) {
        removeDirectory(args.config.ownedRuntimeDirectory);
      }
    })();
    return cleanupTask;
  }

  return { startAutoSshTunnel, cleanupAutoSshTunnel };
}

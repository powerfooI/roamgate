import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { type Logger, silentLogger } from "../utils/logger";
import {
  sshMasterArgv,
  sshMasterCheckArgv,
  sshMasterExitArgv,
  sshMasterStopArgv,
} from "./ssh-command";
import { annotateSshArgv, trackSshProcess } from "./ssh-metrics";
import {
  muxSessionsIdle,
  registerSshMaster,
  unregisterSshMaster,
} from "./ssh-sessions";

export type SshMasterProcess = {
  exited: Promise<number>;
  kill: (signal?: number) => void;
};

// Covers ConnectTimeout plus key exchange and authentication.
const MASTER_READY_TIMEOUT_MS = 20_000;
const MASTER_POLL_INTERVAL_MS = 100;
// A master that was ready and then exited is started again after this delay
// (each time it exits); one that never became ready waits for the next tunnel
// start instead, so a host that refuses it is not retried in a loop.
const MASTER_RESTART_DELAY_MS = 10_000;
// On stop, commands already multiplexed over the master get this long to
// finish before it is killed under them.
const MASTER_DRAIN_TIMEOUT_MS = 10_000;

/**
 * Supervises the runtime's command master (connection B). It carries host
 * commands and uploads; the render/control tunnel stays on its own connection.
 * A master that is missing, starting, or dead only costs speed: commands then
 * open their own connection as before.
 */
export function createSshMaster(args: {
  destination: string;
  controlPath: string;
  connectionId?: string;
  logger?: Logger;
  dependencies?: {
    spawn?: (argv: string[]) => SshMasterProcess;
    exists?: (path: string) => boolean;
    remove?: (path: string) => void;
    runCheck?: (argv: string[]) => Promise<number>;
    readyTimeoutMs?: number;
    pollIntervalMs?: number;
    restartDelayMs?: number;
    drainTimeoutMs?: number;
    stopTimeoutMs?: number;
    forceKillTimeoutMs?: number;
  };
}) {
  const logger = args.logger ?? silentLogger;
  const connection = args.connectionId ?? "legacy-default";
  const deps = args.dependencies ?? {};
  const exists = deps.exists ?? existsSync;
  const remove = deps.remove ?? ((path) => rmSync(path, { force: true }));
  const spawn =
    deps.spawn ??
    ((argv: string[]): SshMasterProcess => {
      const proc = Bun.spawn(argv, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        env: { ...process.env, LC_ALL: "C" },
      });
      trackSshProcess(
        annotateSshArgv(argv, { tag: "master", connection }),
        proc.exited,
      );
      return { exited: proc.exited, kill: (signal) => proc.kill(signal) };
    });
  const runCheck =
    deps.runCheck ??
    ((argv: string[]) => {
      const proc = Bun.spawn(argv, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        timeout: 5_000,
      });
      trackSshProcess(
        annotateSshArgv(argv, { tag: "master.check", connection }),
        proc.exited,
      );
      return proc.exited;
    });
  const readyTimeoutMs = deps.readyTimeoutMs ?? MASTER_READY_TIMEOUT_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? MASTER_POLL_INTERVAL_MS;
  const restartDelayMs = deps.restartDelayMs ?? MASTER_RESTART_DELAY_MS;
  const drainTimeoutMs = deps.drainTimeoutMs ?? MASTER_DRAIN_TIMEOUT_MS;
  const stopTimeoutMs = deps.stopTimeoutMs ?? 1500;
  const forceKillTimeoutMs = deps.forceKillTimeoutMs ?? 1000;
  // The registry key: this runtime's master, distinct from any other runtime
  // that happens to reach the same destination.
  const owner = {};
  let proc: SshMasterProcess | null = null;
  let starting: Promise<boolean> | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let stopTask: Promise<void> | null = null;

  async function isAlive(): Promise<boolean> {
    if (!proc || !exists(args.controlPath)) return false;
    const code = await runCheck(
      sshMasterCheckArgv(args.destination, args.controlPath),
    );
    return code === 0;
  }

  function delay(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  async function waitReady(child: SshMasterProcess): Promise<boolean> {
    let exited = false;
    void child.exited.then(
      () => {
        exited = true;
      },
      () => {
        exited = true;
      },
    );
    for (let waited = 0; ; waited += pollIntervalMs) {
      if (stopped || exited || proc !== child) return false;
      if (exists(args.controlPath)) return true;
      if (waited >= readyTimeoutMs) return false;
      await delay(pollIntervalMs);
    }
  }

  function onExit(child: SshMasterProcess, wasReady: () => boolean) {
    const exitedHandler = () => {
      if (proc !== child) return;
      proc = null;
      unregisterSshMaster(owner);
      if (stopped) return;
      logger.debug("SSH command master exited", { connection });
      if (!wasReady() || restartTimer) return;
      restartTimer = setTimeout(() => {
        restartTimer = null;
        void ensure();
      }, restartDelayMs);
    };
    void child.exited.then(exitedHandler, exitedHandler);
  }

  async function start(): Promise<boolean> {
    // A master that crashed leaves its socket behind; clients would log
    // connection-refused fallbacks against it until it is gone, and a new
    // master cannot bind over it.
    try {
      remove(args.controlPath);
    } catch (error) {
      logger.debug("SSH command master socket could not be cleared", {
        connection,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    let child: SshMasterProcess;
    try {
      child = spawn(sshMasterArgv(args.destination, args.controlPath));
    } catch (error) {
      logger.debug("SSH command master failed to start", {
        connection,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    proc = child;
    let ready = false;
    onExit(child, () => ready);
    ready = await waitReady(child);
    if (!ready || stopped || proc !== child) {
      if (proc === child) {
        proc = null;
        await stopProcess(child).catch(() => undefined);
      }
      logger.debug("SSH command master unavailable; using cold logins", {
        connection,
      });
      return false;
    }
    registerSshMaster(owner, {
      destination: args.destination,
      controlPath: args.controlPath,
      isListening: () => proc === child && exists(args.controlPath),
      isAlive,
    });
    logger.debug("SSH command master ready", { connection });
    return true;
  }

  /**
   * Starts the master unless it is running; resolves whether it is ready.
   * Never rejects: callers start it without awaiting (tunnel start, restart
   * timer), and a master that fails only costs speed.
   */
  function ensure(): Promise<boolean> {
    if (stopped) return Promise.resolve(false);
    if (starting) return starting;
    if (proc) return Promise.resolve(true);
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    const task = start()
      .catch((error: unknown) => {
        logger.debug("SSH command master failed to start", {
          connection,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      })
      .finally(() => {
        if (starting === task) starting = null;
      });
    starting = task;
    return task;
  }

  async function exitedWithin(
    child: SshMasterProcess,
    timeoutMs: number,
  ): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        child.exited.then(
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

  async function stopProcess(child: SshMasterProcess): Promise<void> {
    try {
      child.kill();
    } catch {}
    if (await exitedWithin(child, stopTimeoutMs)) return;
    try {
      child.kill(9);
    } catch {}
    if (!(await exitedWithin(child, forceKillTimeoutMs))) {
      throw new Error(
        `SSH command master did not exit after forced termination connection=${connection}`,
      );
    }
  }

  /**
   * Lets commands in flight over the master finish: `-O stop` closes its
   * control socket to new sessions (which then log in on their own), and the
   * running ones get up to drainTimeoutMs.
   */
  async function drain(child: SshMasterProcess): Promise<void> {
    if (!exists(args.controlPath)) return;
    await runCheck(sshMasterStopArgv(args.destination, args.controlPath)).catch(
      () => undefined,
    );
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        muxSessionsIdle(args.controlPath),
        child.exited.catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, drainTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Stops for good. New commands go cold at once; commands in flight over the
   * master get a bounded drain before it is killed.
   */
  function stop(): Promise<void> {
    if (stopTask) return stopTask;
    stopped = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    unregisterSshMaster(owner);
    const child = proc;
    proc = null;
    stopTask = (async () => {
      if (!child) return;
      await drain(child);
      await stopProcess(child);
      try {
        remove(args.controlPath);
      } catch {
        // The runtime directory removal that follows takes it.
      }
    })();
    return stopTask;
  }

  return { ensure, stop, isRunning: () => proc !== null };
}

export type SshMaster = ReturnType<typeof createSshMaster>;

/** Where SSH profile runtimes create their private directories. */
export const SSH_RUNTIME_DIRECTORY_ROOT = "/tmp";
const SSH_RUNTIME_DIRECTORY_PATTERN = /^roamgate-ssh-[A-Za-z0-9]{6}$/;
/** Written into each runtime directory: the pid of the Roamgate that owns it. */
export const SSH_RUNTIME_OWNER_FILE = "owner.pid";
const MASTER_EXIT_TIMEOUT_MS = 5_000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, but someone else's; never ours to clean up after.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Ends command masters left behind when a Roamgate that owned them crashed.
 * A master runs in the foreground of its own ssh process, so it outlives its
 * parent. Only private `roamgate-ssh-XXXXXX` runtime directories owned by the
 * current user, whose recorded owner pid is gone, are touched: their `m.ctl`
 * socket is sent `-O exit`, then the directory is removed. Directories of a
 * Roamgate still running (another instance on the same account) or without an
 * owner record are left alone.
 */
export async function sweepOrphanedSshMasters(
  args: {
    root?: string;
    uid?: number;
    logger?: Logger;
    isProcessAlive?: (pid: number) => boolean;
    runExit?: (argv: string[]) => Promise<number>;
    remove?: (path: string) => void;
  } = {},
): Promise<number> {
  if (process.platform === "win32") return 0;
  const root = args.root ?? SSH_RUNTIME_DIRECTORY_ROOT;
  const uid = args.uid ?? process.getuid?.();
  const logger = args.logger ?? silentLogger;
  const isProcessAlive = args.isProcessAlive ?? processAlive;
  const remove =
    args.remove ??
    ((path: string) => rmSync(path, { recursive: true, force: true }));
  const runExit =
    args.runExit ??
    (async (argv: string[]) => {
      const proc = Bun.spawn(argv, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        timeout: MASTER_EXIT_TIMEOUT_MS,
      });
      return proc.exited;
    });
  if (uid === undefined) return 0;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return 0;
  }
  let swept = 0;
  for (const name of entries) {
    if (!SSH_RUNTIME_DIRECTORY_PATTERN.test(name)) continue;
    const directory = join(root, name);
    try {
      const info = lstatSync(directory);
      if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0)
        continue;
      const ownerPath = join(directory, SSH_RUNTIME_OWNER_FILE);
      const owner = lstatSync(ownerPath, { throwIfNoEntry: false });
      if (!owner?.isFile() || owner.uid !== uid) continue;
      const pid = Number(readFileSync(ownerPath, "utf8").trim());
      if (!Number.isSafeInteger(pid) || pid <= 0 || isProcessAlive(pid))
        continue;
      const controlPath = join(directory, "m.ctl");
      const socket = lstatSync(controlPath, { throwIfNoEntry: false });
      if (socket?.isSocket() && socket.uid === uid) {
        await runExit(sshMasterExitArgv(controlPath)).catch(() => undefined);
      }
      remove(directory);
      swept += 1;
    } catch (error) {
      logger.debug("Could not sweep an orphaned SSH runtime directory", {
        directory,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (swept) logger.debug("Swept orphaned SSH runtime directories", { swept });
  return swept;
}

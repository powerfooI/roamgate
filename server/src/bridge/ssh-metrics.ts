import { type Logger, serverLogger } from "../utils/logger";

/** Optional context attached to an ssh argv for the debug process log. */
export type SshProcessAnnotation = {
  /** Short, stable caller name, for example `git.status`. */
  tag?: string;
  connection?: string;
  /** Multiplexed over the runtime's command master. */
  master?: boolean;
};

// sshd drops connections beyond MaxStartups before the banner exchange; the
// client then reports one of these instead of an authentication error.
const STARTUP_FAILURE = /\b(?:kex|ssh)_exchange_identification\b/;

// Annotations ride on the argv array itself, so call sites that only build an
// argv can name themselves without threading new parameters through helpers.
const annotations = new WeakMap<readonly string[], SshProcessAnnotation>();

export function annotateSshArgv<T extends readonly string[]>(
  argv: T,
  annotation: SshProcessAnnotation,
): T {
  annotations.set(argv, { ...annotations.get(argv), ...annotation });
  return argv;
}

/**
 * Debug accounting for ssh child processes: live count, startup drops and
 * one log line per exit.
 */
export function createSshProcessMonitor(
  args: { logger?: Logger; now?: () => number } = {},
) {
  const logger = args.logger ?? serverLogger.child("ssh");
  const now = args.now ?? (() => performance.now());
  let live = 0;
  let startupFailures = 0;

  /**
   * Account for one spawned process. Non-ssh argv are ignored, so process
   * helpers can call this unconditionally. `stderr` is only scanned for
   * startup drops; pass the caller's own read so the stream is consumed once.
   */
  function track(
    argv: readonly string[],
    exited: Promise<number>,
    stderr?: Promise<string>,
  ): void {
    if (argv[0] !== "ssh") return;
    const startedAt = now();
    const liveAtStart = ++live;
    const annotation = annotations.get(argv);
    const separator = argv.indexOf("--");
    const host = separator >= 0 ? argv[separator + 1] : undefined;
    void Promise.all([
      exited.catch(() => null),
      (stderr ?? Promise.resolve("")).catch(() => ""),
    ]).then(([code, text]) => {
      live -= 1;
      const startupFailure = STARTUP_FAILURE.test(text);
      if (startupFailure) startupFailures += 1;
      logger.debug("ssh process exited", {
        tag: annotation?.tag ?? "untagged",
        connection: annotation?.connection,
        master: annotation?.master || undefined,
        host,
        code,
        total_ms: Math.round(now() - startedAt),
        live_at_start: liveAtStart,
        live,
        startup_failure: startupFailure || undefined,
        startup_failures: startupFailures || undefined,
      });
    });
  }

  return {
    track,
    liveCount: () => live,
    startupFailureCount: () => startupFailures,
  };
}

export const sshProcessMonitor = createSshProcessMonitor();

export function trackSshProcess(
  argv: readonly string[],
  exited: Promise<number>,
  stderr?: Promise<string>,
): void {
  sshProcessMonitor.track(argv, exited, stderr);
}

/** Live ssh children spawned through the tracked process helpers. */
export function liveSshProcessCount(): number {
  return sshProcessMonitor.liveCount();
}

/**
 * Bounds concurrent SSH sessions per destination. OpenSSH's sshd defaults to
 * MaxSessions 10 per connection and MaxStartups 10 unauthenticated logins, so
 * a burst of host commands (the focus prefetch alone spawns about a dozen)
 * would otherwise have sessions refused or logins dropped.
 */
export const SSH_SESSION_LIMIT = 8;
/**
 * Commands queued behind a full destination. Past this, a new command fails
 * at once rather than adding to a backlog no caller will wait out.
 */
export const SSH_SESSION_WAITER_LIMIT = 64;
/** Longest wait for a session slot when the caller has no deadline of its own. */
export const SSH_SESSION_DEFAULT_WAIT_MS = 60_000;

/** How long a caller waits for a session slot. */
export type SshSessionWait = {
  /** The caller's whole budget; the time spent queued counts against it. */
  timeoutMs?: number;
  signal?: AbortSignal;
};

/** A held slot: release it once, and spend at most `remainingMs` running. */
export type SshSessionHold = {
  release: () => void;
  /** What is left of `timeoutMs` after the wait; unset without a timeout. */
  remainingMs: number | undefined;
};

export type SshMasterRegistration = {
  destination: string;
  controlPath: string;
  /** Cheap per-command test: the process runs and its socket exists. */
  isListening: () => boolean;
  /** Confirms the master still serves sessions (process alive, `-O check`). */
  isAlive: () => Promise<boolean>;
};

type SshCommandRoute = {
  destination: string;
  /** Set when the argv multiplexes over this master's control socket. */
  controlPath?: string;
  /** The same command without multiplexing, for the one cold retry. */
  cold: string[];
  /** Only read-only commands may run twice when their master dies. */
  retrySafe: boolean;
};

// Keyed by the owning runtime, not the destination: two profiles that reach
// the same host each own and dispose their own master.
const masters = new Map<object, SshMasterRegistration>();
// Command argv built by sshCommandArgv, recognised by identity so callers that
// pass the array through unchanged need no knowledge of multiplexing.
const routes = new WeakMap<readonly string[], SshCommandRoute>();
const sessionSlots = new Map<
  string,
  { active: number; waiters: Array<() => void> }
>();
// Commands in flight over each master's control socket, so a master that is
// stopping can let them finish.
const muxSessions = new Map<
  string,
  { active: number; idle: Array<() => void> }
>();

function holdMuxSession(controlPath: string | undefined): () => void {
  if (!controlPath) return noop;
  let entry = muxSessions.get(controlPath);
  if (!entry) {
    entry = { active: 0, idle: [] };
    muxSessions.set(controlPath, entry);
  }
  const current = entry;
  current.active += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    current.active -= 1;
    if (current.active > 0) return;
    muxSessions.delete(controlPath);
    for (const resolve of current.idle.splice(0)) resolve();
  };
}

/** Resolves once no command is in flight over `controlPath`. */
export function muxSessionsIdle(controlPath: string): Promise<void> {
  const entry = muxSessions.get(controlPath);
  if (!entry) return Promise.resolve();
  return new Promise((resolve) => entry.idle.push(resolve));
}

export function registerSshMaster(
  owner: object,
  registration: SshMasterRegistration,
): void {
  masters.set(owner, registration);
}

export function unregisterSshMaster(owner: object): void {
  masters.delete(owner);
}

/** A ready roamgate-owned master for the destination, if any. */
export function sshMasterControlPath(destination: string): string | undefined {
  for (const master of masters.values()) {
    if (master.destination === destination && master.isListening()) {
      return master.controlPath;
    }
  }
  return undefined;
}

export function routeSshCommand(
  argv: readonly string[],
  route: SshCommandRoute,
): void {
  routes.set(argv, route);
}

function sessionWaitTimeout(destination: string, timeoutMs: number): Error {
  return new Error(
    `ssh timed out after ${timeoutMs}ms waiting for a session to ${destination}`,
  );
}

/**
 * Takes one of the destination's session slots, waiting in line while all are
 * busy. The wait ends with an error at `timeoutMs` (default
 * SSH_SESSION_DEFAULT_WAIT_MS), when `signal` aborts, or at once when
 * SSH_SESSION_WAITER_LIMIT commands are already queued.
 */
export async function acquireSshSession(
  destination: string,
  wait: SshSessionWait = {},
): Promise<() => void> {
  wait.signal?.throwIfAborted();
  let slot = sessionSlots.get(destination);
  if (!slot) {
    slot = { active: 0, waiters: [] };
    sessionSlots.set(destination, slot);
  }
  const current = slot;
  if (current.active >= SSH_SESSION_LIMIT) {
    if (current.waiters.length >= SSH_SESSION_WAITER_LIMIT) {
      throw new Error(
        `ssh: ${SSH_SESSION_WAITER_LIMIT} commands already waiting for ${destination}`,
      );
    }
    const timeoutMs = wait.timeoutMs ?? SSH_SESSION_DEFAULT_WAIT_MS;
    if (timeoutMs <= 0) throw sessionWaitTimeout(destination, timeoutMs);
    await new Promise<void>((resolve, reject) => {
      const signal = wait.signal;
      const settle = (error?: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const index = current.waiters.indexOf(grant);
        if (index >= 0) current.waiters.splice(index, 1);
        if (error === undefined) resolve();
        else reject(error);
      };
      // Called by release with the slot already handed over.
      const grant = () => settle();
      const onAbort = () => settle(signal?.reason);
      const timer = setTimeout(
        () => settle(sessionWaitTimeout(destination, timeoutMs)),
        timeoutMs,
      );
      signal?.addEventListener("abort", onAbort, { once: true });
      current.waiters.push(grant);
    });
  } else {
    current.active += 1;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Hand the slot straight to the next waiter so a newcomer cannot jump it.
    const next = current.waiters.shift();
    if (next) {
      next();
      return;
    }
    current.active -= 1;
    if (current.active === 0) sessionSlots.delete(destination);
  };
}

/** Holds a session slot for argv built by sshCommandArgv; others pass through. */
export async function holdSshSession(
  argv: readonly string[],
  wait: SshSessionWait = {},
): Promise<SshSessionHold> {
  const route = routes.get(argv);
  if (!route) {
    wait.signal?.throwIfAborted();
    return { release: noop, remainingMs: wait.timeoutMs };
  }
  const startedAt = Date.now();
  const releaseSlot = await acquireSshSession(route.destination, wait);
  const releaseMux = holdMuxSession(route.controlPath);
  return {
    release: () => {
      releaseMux();
      releaseSlot();
    },
    remainingMs:
      wait.timeoutMs === undefined
        ? undefined
        : wait.timeoutMs - (Date.now() - startedAt),
  };
}

function noop() {}

// OpenSSH prints these when it could not use the master and already fell back
// to its own connection; a 255 then belongs to that cold attempt.
const MUX_FALLBACK_STDERR =
  /Control socket connect|mux_client_request_session: session request failed/;

async function masterDied(controlPath: string): Promise<boolean> {
  for (const master of masters.values()) {
    if (master.controlPath !== controlPath) continue;
    return !(await master.isAlive().catch(() => false));
  }
  return true;
}

/**
 * Runs argv from sshCommandArgv inside the destination's session limit. A
 * read-only command (sshReadCommandArgv) is rerun once without multiplexing
 * when the master died under it. A mux client whose master goes away exits 255
 * with nothing on stderr, while the remote side may still be running; a 255
 * while the master is still alive is the remote command's own status. Other
 * commands report that 255 rather than risk running twice.
 *
 * `run` gets what is left of `wait.timeoutMs` (unset without one) once the
 * slot is held, so queueing and a retry spend the caller's budget rather than
 * extend it.
 */
export async function runSshCommand<T extends { code: number; stderr: string }>(
  argv: string[],
  run: (argv: string[], remainingMs: number | undefined) => Promise<T>,
  wait: SshSessionWait = {},
): Promise<T> {
  const route = routes.get(argv);
  if (!route) return run(argv, wait.timeoutMs);
  const startedAt = Date.now();
  const remaining = () => {
    if (wait.timeoutMs === undefined) return undefined;
    const left = wait.timeoutMs - (Date.now() - startedAt);
    if (left <= 0) throw new Error(`ssh timed out after ${wait.timeoutMs}ms`);
    return left;
  };
  const release = await acquireSshSession(route.destination, wait);
  const releaseMux = holdMuxSession(route.controlPath);
  try {
    const result = await run(argv, remaining());
    if (
      route.retrySafe &&
      route.controlPath &&
      result.code === 255 &&
      !MUX_FALLBACK_STDERR.test(result.stderr) &&
      (await masterDied(route.controlPath))
    ) {
      releaseMux();
      return await run(route.cold, remaining());
    }
    return result;
  } finally {
    releaseMux();
    release();
  }
}

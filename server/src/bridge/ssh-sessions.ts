import { AsyncLocalStorage } from "node:async_hooks";

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
/**
 * Slots background reads (badges, polls, prefetches) may hold at once: the
 * others stay free for what the user is doing, so a switch, an attach or the
 * chat on screen never queues behind them.
 */
export const SSH_BACKGROUND_SESSION_LIMIT = 5;
/** Background commands queued behind a full destination before more are shed. */
export const SSH_BACKGROUND_WAITER_LIMIT = 64;

/**
 * Who a command is for. Interactive work (the default) is what the user is
 * waiting on; background work yields to it and is shed, not failed loudly,
 * when its line is full.
 */
export type SshLane = "interactive" | "background";

const lanes = new AsyncLocalStorage<SshLane>();

/** Runs `fn`, and every SSH command it starts, in `lane`. */
export function runInSshLane<T>(lane: SshLane, fn: () => T): T {
  return lanes.run(lane, fn);
}

/** The lane of the work running now: interactive unless said otherwise. */
export function currentSshLane(): SshLane {
  return lanes.getStore() ?? "interactive";
}

/**
 * A background command dropped because its line is full: nothing the user
 * asked for failed, so callers log it quietly and try again later.
 */
export class SshBackgroundShedError extends Error {
  readonly shed = true;
  constructor(destination: string) {
    super(
      `ssh: ${SSH_BACKGROUND_WAITER_LIMIT} background commands already waiting for ${destination}`,
    );
    this.name = "SshBackgroundShedError";
  }
}

export function isSshBackgroundShed(error: unknown): boolean {
  return (error as { shed?: unknown } | null)?.shed === true;
}

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
type SessionSlots = {
  active: number;
  /** Of `active`, those held by background commands. */
  background: number;
  waiters: Array<() => void>;
  backgroundWaiters: Array<() => void>;
};
const sessionSlots = new Map<string, SessionSlots>();
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

/** Gives free slots to the waiters: interactive ones first. */
function grantWaiters(slot: SessionSlots) {
  while (slot.active < SSH_SESSION_LIMIT) {
    const interactive = slot.waiters.shift();
    if (interactive) {
      slot.active += 1;
      interactive();
      continue;
    }
    if (slot.background >= SSH_BACKGROUND_SESSION_LIMIT) return;
    const background = slot.backgroundWaiters.shift();
    if (!background) return;
    slot.active += 1;
    slot.background += 1;
    background();
  }
}

/**
 * Takes one of the destination's session slots, waiting in line while all are
 * busy. The wait ends with an error at `timeoutMs` (default
 * SSH_SESSION_DEFAULT_WAIT_MS), when `signal` aborts, or at once when
 * SSH_SESSION_WAITER_LIMIT commands are already queued.
 *
 * Background work (`lane`, else the lane it runs in) holds at most
 * SSH_BACKGROUND_SESSION_LIMIT slots and waits behind every interactive
 * command; past SSH_BACKGROUND_WAITER_LIMIT queued it is shed with
 * SshBackgroundShedError.
 */
export async function acquireSshSession(
  destination: string,
  wait: SshSessionWait = {},
  lane: SshLane = currentSshLane(),
): Promise<() => void> {
  wait.signal?.throwIfAborted();
  let slot = sessionSlots.get(destination);
  if (!slot) {
    slot = { active: 0, background: 0, waiters: [], backgroundWaiters: [] };
    sessionSlots.set(destination, slot);
  }
  const current = slot;
  const background = lane === "background";
  const free = background
    ? current.active < SSH_SESSION_LIMIT &&
      current.background < SSH_BACKGROUND_SESSION_LIMIT &&
      current.waiters.length === 0 &&
      current.backgroundWaiters.length === 0
    : current.active < SSH_SESSION_LIMIT;
  if (free) {
    current.active += 1;
    if (background) current.background += 1;
  } else {
    const line = background ? current.backgroundWaiters : current.waiters;
    if (background && line.length >= SSH_BACKGROUND_WAITER_LIMIT)
      throw new SshBackgroundShedError(destination);
    if (!background && line.length >= SSH_SESSION_WAITER_LIMIT) {
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
        const index = line.indexOf(grant);
        if (index >= 0) line.splice(index, 1);
        if (error === undefined) resolve();
        else reject(error);
      };
      // Called by grantWaiters with the slot already counted as taken.
      const grant = () => settle();
      const onAbort = () => settle(signal?.reason);
      const timer = setTimeout(
        () => settle(sessionWaitTimeout(destination, timeoutMs)),
        timeoutMs,
      );
      signal?.addEventListener("abort", onAbort, { once: true });
      line.push(grant);
    });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    current.active -= 1;
    if (background) current.background -= 1;
    // Hand the slot straight to the next waiter so a newcomer cannot jump it.
    grantWaiters(current);
    if (
      current.active === 0 &&
      !current.waiters.length &&
      !current.backgroundWaiters.length
    )
      sessionSlots.delete(destination);
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
  wait.signal?.throwIfAborted();
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
    wait.signal?.throwIfAborted();
    const result = await run(argv, remaining());
    if (
      route.retrySafe &&
      route.controlPath &&
      result.code === 255 &&
      !MUX_FALLBACK_STDERR.test(result.stderr) &&
      (await masterDied(route.controlPath))
    ) {
      releaseMux();
      wait.signal?.throwIfAborted();
      return await run(route.cold, remaining());
    }
    return result;
  } finally {
    releaseMux();
    release();
  }
}

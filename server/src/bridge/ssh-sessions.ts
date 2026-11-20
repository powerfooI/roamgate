import { AsyncLocalStorage } from "node:async_hooks";
import { copySshAnnotation } from "./ssh-metrics";

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
 * A multiplexed command whose session the host refused (sshd's MaxSessions,
 * 10 by default) is run again over the master after these waits, then on a
 * connection of its own.
 */
export const SSH_REFUSED_RETRY_DELAYS_MS = [200, 500, 1000, 2000] as const;
/**
 * After a refusal the host has fewer sessions free than counted here (a
 * session closes on the host a moment after its client exits, and a command
 * killed here may still run there): no new slot is given past the ones in
 * use until this long after the last refusal.
 */
export const SSH_REFUSED_COOLDOWN_MS = 5_000;
/**
 * A command run with a deadline ends on the host this long (in seconds)
 * after it, even when nothing there notices its client is gone.
 */
export const SSH_REMOTE_GRACE_S = 2;
/**
 * A master whose host refused this many sessions in a row, over at least
 * SSH_MASTER_RECYCLE_AFTER_MS with none served in between, is closed and
 * opened again: its sessions stay taken on the host (an sshd that stopped
 * reaping its session processes keeps them counted), and only a new
 * connection gets fresh ones. Until it is back, commands go straight to a
 * connection of their own instead of retrying over it.
 */
export const SSH_MASTER_RECYCLE_REFUSALS = 8;
export const SSH_MASTER_RECYCLE_AFTER_MS = 15_000;
/** The least time between two recycles of one master. */
export const SSH_MASTER_RECYCLE_INTERVAL_MS = 60_000;

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
  /**
   * Closes the master and opens a new one, for a host that keeps refusing
   * its sessions; commands meanwhile log in on their own.
   */
  recycle?: () => void;
};

type SshCommandRoute = {
  destination: string;
  /** Set when the argv multiplexes over this master's control socket. */
  controlPath?: string;
  /** The same command without multiplexing, for the one cold retry. */
  cold: string[];
  /**
   * The multiplexed command that fails instead of logging in on its own
   * when the master refuses its session; what runSshCommand runs.
   */
  muxOnly?: string[];
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
  /**
   * Sessions whose client was killed here and that may still run on the
   * host until their deadline: the host counts them, so no slot goes to
   * them meanwhile.
   */
  lingering: number;
  /**
   * The most sessions the host serves while it recovers from a refusal,
   * lingering ones included.
   */
  ceiling: number;
  cooldownUntil: number;
  cooldownTimer?: ReturnType<typeof setTimeout>;
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

// Refusals in a row over each master's control socket, since the first.
const refusalStreaks = new Map<string, { since: number; count: number }>();
const lastRecycles = new Map<string, number>();

/** A session over `controlPath` ran: its host serves sessions again. */
function noteMasterServed(controlPath: string) {
  refusalStreaks.delete(controlPath);
}

/**
 * The host refused a session over `controlPath`. Past
 * SSH_MASTER_RECYCLE_REFUSALS in a row over SSH_MASTER_RECYCLE_AFTER_MS,
 * the master is recycled (at most every SSH_MASTER_RECYCLE_INTERVAL_MS) and
 * true is returned: the master is not worth retrying.
 */
function noteMasterRefusal(controlPath: string): boolean {
  const now = Date.now();
  let streak = refusalStreaks.get(controlPath);
  if (!streak) {
    streak = { since: now, count: 0 };
    refusalStreaks.set(controlPath, streak);
  }
  streak.count += 1;
  if (
    streak.count < SSH_MASTER_RECYCLE_REFUSALS ||
    now - streak.since < SSH_MASTER_RECYCLE_AFTER_MS
  )
    return false;
  const last = lastRecycles.get(controlPath);
  if (last === undefined || now - last >= SSH_MASTER_RECYCLE_INTERVAL_MS) {
    for (const master of masters.values()) {
      if (master.controlPath !== controlPath || !master.recycle) continue;
      lastRecycles.set(controlPath, now);
      refusalStreaks.delete(controlPath);
      master.recycle();
      break;
    }
  }
  return true;
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

/** How many slots the destination gives now. */
function slotLimit(slot: SessionSlots): number {
  const sessions =
    slot.cooldownUntil > Date.now() ? slot.ceiling : SSH_SESSION_LIMIT;
  return Math.max(0, sessions - slot.lingering);
}

function newSlots(): SessionSlots {
  return {
    active: 0,
    background: 0,
    lingering: 0,
    ceiling: SSH_SESSION_LIMIT,
    cooldownUntil: 0,
    waiters: [],
    backgroundWaiters: [],
  };
}

function slotsOf(destination: string): SessionSlots {
  let slot = sessionSlots.get(destination);
  if (!slot) {
    slot = newSlots();
    sessionSlots.set(destination, slot);
  }
  return slot;
}

function forgetIfIdle(destination: string, slot: SessionSlots) {
  if (
    slot.active === 0 &&
    slot.lingering === 0 &&
    !slot.waiters.length &&
    !slot.backgroundWaiters.length &&
    slot.cooldownUntil <= Date.now() &&
    sessionSlots.get(destination) === slot
  )
    sessionSlots.delete(destination);
}

/**
 * The host refused a session: give no slot past the ones in use (less the
 * refused one) for SSH_REFUSED_COOLDOWN_MS, then hand out the rest again.
 */
function noteRefusal(destination: string) {
  const slot = slotsOf(destination);
  const until = Date.now() + SSH_REFUSED_COOLDOWN_MS;
  slot.ceiling = Math.max(
    1,
    Math.min(
      slot.cooldownUntil > Date.now() ? slot.ceiling : SSH_SESSION_LIMIT,
      slot.active + slot.lingering - 1,
    ),
  );
  slot.cooldownUntil = until;
  if (slot.cooldownTimer) clearTimeout(slot.cooldownTimer);
  slot.cooldownTimer = setTimeout(() => {
    slot.cooldownTimer = undefined;
    grantWaiters(slot);
    forgetIfIdle(destination, slot);
  }, SSH_REFUSED_COOLDOWN_MS);
  (slot.cooldownTimer as { unref?: () => void }).unref?.();
}

/**
 * A command's client was killed here (its deadline passed) while its
 * session may still run on the host until `until`: the slot is free here,
 * but the host's session is counted until then.
 */
function noteLingering(destination: string, until: number) {
  const left = until - Date.now();
  if (left <= 0) return;
  const slot = slotsOf(destination);
  slot.lingering += 1;
  const timer = setTimeout(() => {
    slot.lingering -= 1;
    grantWaiters(slot);
    forgetIfIdle(destination, slot);
  }, left);
  (timer as { unref?: () => void }).unref?.();
}

/**
 * The remote command line that runs `command` under /bin/sh, as the
 * commands sent to hosts are written for, but kills it and everything it
 * started `seconds` from now: sshd gives each session its own process
 * group, and a command that waits on nothing it reads (a keychain prompt
 * nobody sees, a stalled network call) would otherwise hold its session,
 * one of sshd's MaxSessions, long after its client here was killed. The watchdog goes when the command ends.
 * The outer line parses alike in sh, bash, zsh and fish; PowerShell
 * commands (Windows hosts) are left as they are.
 */
export function withRemoteDeadline(command: string, seconds: number): string {
  if (/^powershell(?:\.exe)?\s/i.test(command)) return command;
  const script =
    't=$1; c=$2; (trap "kill \\$p 2>/dev/null; exit 0" TERM; sleep "$t" & p=$!; wait "$p" && kill -s KILL 0) </dev/null >/dev/null 2>&1 & w=$!; /bin/sh -c "$c"; s=$?; kill "$w" 2>/dev/null; exit "$s"';
  return `exec /bin/sh -c ${anyShellQuote(script)} roamgate-deadline ${Math.max(1, Math.ceil(seconds))} ${anyShellQuote(command)}`;
}

/**
 * Single quotes as POSIX shells read them, with backslashes outside the
 * quotes, since fish reads \\ and \' inside single quotes as escapes.
 */
function anyShellQuote(value: string): string {
  return `'${value.replace(/['\\]/g, (c) => (c === "'" ? "'\\''" : "'\\\\'"))}'`;
}

/** Gives free slots to the waiters: interactive ones first. */
function grantWaiters(slot: SessionSlots) {
  while (slot.active < slotLimit(slot)) {
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
  const current = slotsOf(destination);
  const background = lane === "background";
  const limit = slotLimit(current);
  const free = background
    ? current.active < limit &&
      current.background < SSH_BACKGROUND_SESSION_LIMIT &&
      current.waiters.length === 0 &&
      current.backgroundWaiters.length === 0
    : current.active < limit && current.waiters.length === 0;
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
    forgetIfIdle(destination, current);
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
// The master could not open the session: the host refused it (MaxSessions).
const MUX_REFUSED_STDERR = /mux_client_request_session: session request failed/;
// OpenSSH's lines about the master and its fallback, not the command's.
const MUX_NOISE_LINE =
  /^(?:Control socket connect\(.*|mux_client_\w+: .*|muxclient: .*|kex_exchange_identification: .*|Connection closed by UNKNOWN port \d+)$/;

/** The command's stderr without OpenSSH's lines about the master. */
export function withoutMuxNoise(stderr: string): string {
  if (!/mux_client|Control socket connect|muxclient/.test(stderr))
    return stderr;
  return stderr
    .split("\n")
    .filter((line) => !MUX_NOISE_LINE.test(line.replace(/\r$/, "")))
    .join("\n");
}

function backoff(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      done();
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      done();
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function masterDied(controlPath: string): Promise<boolean> {
  for (const master of masters.values()) {
    if (master.controlPath !== controlPath) continue;
    return !(await master.isAlive().catch(() => false));
  }
  return true;
}

/**
 * Runs argv from sshCommandArgv inside the destination's session limit.
 *
 * Over a master it runs the command's mux-only form: when the host refuses
 * the session (sshd's MaxSessions) the command has not run, so it waits
 * SSH_REFUSED_RETRY_DELAYS_MS and runs again over the master, holding its
 * slot, while the destination gives no new slot (SSH_REFUSED_COOLDOWN_MS);
 * past the last wait, and when the master's socket is gone, it runs on a
 * connection of its own. OpenSSH's lines about the master are left out of
 * the stderr returned.
 *
 * A read-only command (sshReadCommandArgv) is rerun once without multiplexing
 * when the master died under it. A mux client whose master goes away exits 255
 * with nothing on stderr, while the remote side may still be running; a 255
 * while the master is still alive is the remote command's own status. Other
 * commands report that 255 rather than risk running twice.
 *
 * `run` gets what is left of `wait.timeoutMs` (unset without one) once the
 * slot is held, so queueing and a retry spend the caller's budget rather than
 * extend it. With a deadline, the remote command is run under
 * withRemoteDeadline, to end SSH_REMOTE_GRACE_S after it; when `run` throws
 * (its client killed at the deadline), the slot is free again but the
 * host's session is counted until then.
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
  const clean = (result: T): T => {
    const stderr = withoutMuxNoise(result.stderr);
    return stderr === result.stderr ? result : { ...result, stderr };
  };
  const release = await acquireSshSession(route.destination, wait);
  const releaseMux = holdMuxSession(route.controlPath);
  // With a deadline, the command ends on the host too, shortly after it;
  // a client killed here leaves its session counted until then.
  const attempt = async (each: string[]) => {
    const left = remaining();
    if (left === undefined) return run(each, left);
    const until = Date.now() + left + SSH_REMOTE_GRACE_S * 1000;
    const bounded = [
      ...each.slice(0, -1),
      withRemoteDeadline(
        each[each.length - 1] ?? "",
        (until - Date.now()) / 1000,
      ),
    ];
    copySshAnnotation(each, bounded);
    try {
      return await run(bounded, left);
    } catch (error) {
      noteLingering(route.destination, until);
      throw error;
    }
  };
  try {
    const muxOnly = route.muxOnly;
    if (muxOnly) copySshAnnotation(argv, muxOnly);
    for (let tries = 0; ; tries += 1) {
      wait.signal?.throwIfAborted();
      const result = await attempt(muxOnly ?? argv);
      if (
        muxOnly &&
        result.code === 255 &&
        MUX_REFUSED_STDERR.test(result.stderr)
      ) {
        noteRefusal(route.destination);
        const broken =
          route.controlPath !== undefined &&
          noteMasterRefusal(route.controlPath);
        const delay = broken ? undefined : SSH_REFUSED_RETRY_DELAYS_MS[tries];
        if (delay !== undefined) {
          const left = remaining();
          if (left === undefined || left > delay) {
            await backoff(delay, wait.signal);
            continue;
          }
        }
        // Still refused: a connection of its own.
        releaseMux();
        wait.signal?.throwIfAborted();
        return clean(await attempt(route.cold));
      }
      if (
        muxOnly &&
        result.code === 255 &&
        MUX_FALLBACK_STDERR.test(result.stderr)
      ) {
        // The socket is gone: the command never started.
        releaseMux();
        wait.signal?.throwIfAborted();
        return clean(await attempt(route.cold));
      }
      if (muxOnly && route.controlPath) noteMasterServed(route.controlPath);
      if (
        route.retrySafe &&
        route.controlPath &&
        result.code === 255 &&
        !MUX_FALLBACK_STDERR.test(result.stderr) &&
        (await masterDied(route.controlPath))
      ) {
        releaseMux();
        wait.signal?.throwIfAborted();
        return clean(await attempt(route.cold));
      }
      return clean(result);
    }
  } finally {
    releaseMux();
    release();
  }
}

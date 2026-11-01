/**
 * Who an RPC is for. Interactive calls (the default) are what the user is
 * waiting on: a switch, an attach, the chat on screen. Background calls
 * (badges, polls, prefetches) must never be in their way: the browser runs
 * only a few at a time per connection, shares identical ones in flight, and
 * the bridge runs them behind interactive work on the host.
 */
export type RpcLane = "interactive" | "background";

export type RpcCallOptions = {
  lane?: RpcLane;
};

/** Background calls one connection runs at once; the rest wait their turn. */
export const BACKGROUND_RPC_LIMIT = 4;

/**
 * A queue for background calls: at most `limit` run at once, and a call
 * identical to one in flight (same key) shares its answer instead of asking
 * again.
 */
export function createBackgroundLane(limit = BACKGROUND_RPC_LIMIT) {
  let active = 0;
  const waiting: Array<() => void> = [];
  const inFlight = new Map<string, Promise<unknown>>();

  function next() {
    while (active < limit) {
      const start = waiting.shift();
      if (!start) return;
      active += 1;
      start();
    }
  }

  function run<T>(key: string, call: () => Promise<T>): Promise<T> {
    const shared = inFlight.get(key);
    if (shared) return shared as Promise<T>;
    const result = new Promise<T>((resolve, reject) => {
      waiting.push(() => {
        let settled: Promise<T>;
        try {
          settled = call();
        } catch (error) {
          settled = Promise.reject(error);
        }
        settled.then(resolve, reject).finally(() => {
          active -= 1;
          next();
        });
      });
    });
    inFlight.set(key, result);
    const forget = () => {
      if (inFlight.get(key) === result) inFlight.delete(key);
    };
    result.then(forget, forget);
    next();
    return result;
  }

  return {
    run,
    /** Calls running now, and waiting. */
    get size() {
      return { active, waiting: waiting.length };
    },
  };
}

export type BackgroundLane = ReturnType<typeof createBackgroundLane>;

/** The key under which identical background calls are shared. */
export function backgroundCallKey(
  scope: string,
  method: string,
  params: Record<string, unknown>,
): string {
  let encoded: string;
  try {
    encoded = JSON.stringify(params);
  } catch {
    encoded = String(Math.random());
  }
  return `${scope}\u0000${method}\u0000${encoded}`;
}

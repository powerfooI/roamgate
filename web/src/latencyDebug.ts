/**
 * Opt-in latency samples, written with console.debug (the console's Verbose
 * level). Enable with `?debugLatency` in the URL, or persistently with
 * `localStorage.setItem("roamgate:debugLatency", "1")` and a reload.
 */
export const latencyDebugEnabled = (() => {
  if (typeof window === "undefined") return false;
  try {
    return (
      new URLSearchParams(window.location.search).has("debugLatency") ||
      window.localStorage.getItem("roamgate:debugLatency") === "1"
    );
  } catch {
    return false;
  }
})();

export type LatencyFields = Record<string, string | number | undefined>;

/** Render `key=value` pairs like the server log so both can be grepped alike. */
export function formatLatencyLine(event: string, fields: LatencyFields) {
  const parts = [`[latency] ${event}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const text = String(value);
    parts.push(`${key}=${/[\s="]/.test(text) ? JSON.stringify(text) : text}`);
  }
  return parts.join(" ");
}

export function logLatency(event: string, fields: LatencyFields) {
  if (latencyDebugEnabled) console.debug(formatLatencyLine(event, fields));
}

/** Log how long `promise` took to settle, then pass its outcome through. */
export function timeLatency<T>(
  event: string,
  fields: LatencyFields,
  promise: Promise<T>,
  now: () => number = () => performance.now(),
): Promise<T> {
  if (!latencyDebugEnabled) return promise;
  const startedAt = now();
  const done = (status: string) =>
    logLatency(event, {
      ...fields,
      status,
      total_ms: Math.round(now() - startedAt),
    });
  return promise.then(
    (value) => {
      done("ok");
      return value;
    },
    (error: unknown) => {
      done("error");
      throw error;
    },
  );
}

/**
 * Echo samples only count one typed character. Control keys, escape
 * sequences and pastes often redraw without a plain echo and skew the sample.
 */
export function isTypedCharacter(data: string) {
  return (
    Array.from(data).length === 1 && !/[\u0000-\u001f\u007f-\u009f]/.test(data)
  );
}

/**
 * Time from sending a typed character to writing the next terminal frame.
 * Only the oldest unanswered key is timed, so fast typing yields one sample
 * per frame rather than stacking keys onto the same frame.
 */
export function createEchoProbe(now: () => number = () => performance.now()) {
  let sentAt: number | null = null;
  return {
    sent(data: string) {
      if (sentAt === null && isTypedCharacter(data)) sentAt = now();
    },
    /** Returns the elapsed ms for a pending key, or null when none was sent. */
    presented(): number | null {
      if (sentAt === null) return null;
      const elapsed = now() - sentAt;
      sentAt = null;
      return Math.round(elapsed);
    },
  };
}

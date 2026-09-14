export type TerminalSize = { cols: number; rows: number };

export type TerminalRelayLayout = {
  zoomed?: boolean;
  area: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  panes: Array<{
    pane_id: string;
    rect: {
      width: number;
      height: number;
    };
  }>;
};

export const TERMINAL_RESIZE_DEBOUNCE_MS = 90;

const relayViewportByTab = new Map<string, TerminalSize>();

function relayViewportKey(
  connectionId: string,
  generation: number,
  tabId: string,
) {
  return `${connectionId}\0${generation}\0${tabId}`;
}

export function rememberTerminalRelayViewport(
  connectionId: string,
  generation: number,
  tabId: string,
  size: TerminalSize,
) {
  if (!connectionId || !tabId || !validSize(size)) return;
  relayViewportByTab.set(relayViewportKey(connectionId, generation, tabId), {
    ...size,
  });
}

export function terminalRelayViewportForTab(
  connectionId: string,
  generation: number,
  tabId: string,
): TerminalSize | null {
  const size = relayViewportByTab.get(
    relayViewportKey(connectionId, generation, tabId),
  );
  return size ? { ...size } : null;
}

export function forgetTerminalRelayViewportsExcept(
  connectionId: string,
  generation: number,
  tabIds: Set<string>,
) {
  const prefix = `${connectionId}\0${generation}\0`;
  for (const key of relayViewportByTab.keys()) {
    if (!key.startsWith(prefix)) continue;
    if (!tabIds.has(key.slice(prefix.length))) relayViewportByTab.delete(key);
  }
}

export function clearTerminalRelayViewports() {
  relayViewportByTab.clear();
}

function sameSize(a: TerminalSize | null, b: TerminalSize | null): boolean {
  return !!a && !!b && a.cols === b.cols && a.rows === b.rows;
}

function validSize(size: TerminalSize): boolean {
  return size.cols > 0 && size.rows > 0;
}

/**
 * Converts one rendered pane's xterm size into the full Herdr app-client
 * viewport used by the clipboard relay.
 *
 * A relay is an app client, not a direct pane attachment: its dimensions must
 * include Herdr's sidebar/tab-bar chrome and the complete split layout. Using
 * the latest pane's dimensions directly makes every split pane drag background
 * runtimes through unrelated geometries. A single pane reserves its right-edge
 * column; split panes also
 * have borders around each pane, for three columns and two rows of total pane
 * chrome. Scale the desired content dimensions with that chrome included.
 */
export function terminalRelayViewportSize(
  size: TerminalSize,
  layout: TerminalRelayLayout | null | undefined,
  paneId: string | null | undefined,
): TerminalSize {
  const surface = terminalEndpointViewportSize(size, layout, paneId);
  if (!surface || !layout) return size;
  return {
    cols: Math.min(65_535, surface.cols + Math.max(0, layout.area.x)),
    rows: Math.min(65_535, surface.rows + Math.max(0, layout.area.y)),
  };
}

/** Endpoint surfaces cover the tab, excluding app sidebar and tab-bar insets. */
export function terminalEndpointViewportSize(
  size: TerminalSize,
  layout: TerminalRelayLayout | null | undefined,
  paneId: string | null | undefined,
): TerminalSize | null {
  if (!validSize(size) || !layout || !paneId) return null;
  const pane = layout.panes.find((item) => item.pane_id === paneId);
  const area = layout.area;
  if (
    !pane ||
    area.width <= 0 ||
    area.height <= 0 ||
    pane.rect.width <= 0 ||
    pane.rect.height <= 0
  ) {
    return null;
  }

  const splitLayout = layout.panes.length > 1 && !layout.zoomed;
  const paneChromeCols = splitLayout ? 3 : 1;
  const paneChromeRows = splitLayout ? 2 : 0;
  // A pane already matching the current layout (±1 cell for xterm fit's
  // fractional-pixel flooring) means the layout is settled: return the area
  // verbatim. Recomputing a rounded estimate per pane lets routine focus
  // switches re-base the shared geometry on ±1-2 cell differences, visibly
  // reflowing every pane in the tab.
  if (
    Math.abs(size.cols - (pane.rect.width - paneChromeCols)) <= 1 &&
    Math.abs(size.rows - (pane.rect.height - paneChromeRows)) <= 1
  ) {
    return { cols: area.width, rows: area.height };
  }
  const terminalAreaCols = Math.max(
    1,
    Math.round(((size.cols + paneChromeCols) * area.width) / pane.rect.width),
  );
  const terminalAreaRows = Math.max(
    1,
    Math.round(((size.rows + paneChromeRows) * area.height) / pane.rect.height),
  );
  return {
    cols: Math.min(65_535, terminalAreaCols),
    rows: Math.min(65_535, terminalAreaRows),
  };
}

/**
 * Coalesces xterm size changes into `terminal.resize` RPCs.
 *
 * Herdr re-renders and streams a full frame on every resize — even a same-size
 * one — so over a slow (remote) link every redundant RPC becomes a visible
 * full-screen reflow. This helper therefore
 *  - dedupes sizes identical to the last dispatched server size, and
 *  - debounces bursts (CSS transitions, window drags, pane-layout settling)
 *    into a single trailing update.
 *
 * `send` must return false when the resize could not be dispatched (e.g. no
 * terminal is currently attached); the size then stays "unsynced" so a later
 * schedule/sendNow retries it.
 */
export class TerminalResizeSync {
  private synced: TerminalSize | null = null;
  private pending: TerminalSize | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private send: (size: TerminalSize) => boolean,
    private debounceMs = TERMINAL_RESIZE_DEBOUNCE_MS,
  ) {}

  /** Records the size an attach RPC already carried to the server. */
  markAttached(size: TerminalSize) {
    this.cancelPending();
    this.synced = validSize(size) ? size : null;
  }

  /** Debounced sync; collapses bursts and drops no-op sizes. */
  schedule(size: TerminalSize) {
    if (!validSize(size)) return;
    if (sameSize(size, this.synced)) {
      // A burst that lands back on the synced size must not fire stale
      // intermediate sizes queued earlier in the burst.
      this.cancelPending();
      return;
    }
    this.pending = size;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fire(), this.debounceMs);
  }

  /** Immediate sync, still deduped against the dispatched server size. */
  sendNow(size: TerminalSize): boolean {
    if (!validSize(size)) return false;
    this.cancelPending();
    return this.deliver(size);
  }

  /** Makes a rejected dispatch eligible for a later retry. */
  markFailed(size: TerminalSize) {
    if (sameSize(size, this.synced)) this.synced = null;
  }

  dispose() {
    this.cancelPending();
  }

  private cancelPending() {
    this.pending = null;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private fire() {
    const size = this.pending;
    this.pending = null;
    this.timer = null;
    if (!size) return;
    this.deliver(size);
  }

  private deliver(size: TerminalSize): boolean {
    if (sameSize(size, this.synced)) return false;
    if (!this.send(size)) return false;
    this.synced = size;
    return true;
  }
}

export class TerminalAttachFrameWatchdog {
  private attempt = 0;
  private frameAttempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Starts a new attach attempt and returns its identity. */
  begin(): number {
    this.clearTimer();
    this.attempt += 1;
    return this.attempt;
  }

  /** Records a matching frame whether it arrives before or after the RPC. */
  markFrame() {
    this.frameAttempt = this.attempt;
    this.clearTimer();
  }

  /**
   * Arms only if this is still the current attempt and no frame has arrived.
   * Returns false when the watchdog was already satisfied or superseded.
   */
  arm(attempt: number, delayMs: number, onTimeout: () => void): boolean {
    if (attempt !== this.attempt || this.frameAttempt === attempt) return false;
    this.clearTimer();
    this.timer = setTimeout(
      () => {
        this.timer = null;
        if (attempt !== this.attempt || this.frameAttempt === attempt) return;
        onTimeout();
      },
      Math.max(0, delayMs),
    );
    return true;
  }

  cancel(attempt?: number) {
    if (attempt !== undefined && attempt !== this.attempt) return;
    this.clearTimer();
    this.attempt += 1;
  }

  dispose() {
    this.cancel();
  }

  private clearTimer() {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

const ATTACH_WATCHDOG_MIN_MS = 4000;
const ATTACH_WATCHDOG_MAX_MS = 20000;
const ATTACH_WATCHDOG_RTT_FACTOR = 3;

/**
 * Scales the "no frame after attach" watchdog with the attach round-trip so
 * slow remote links (where the first full frame legitimately takes seconds)
 * do not trigger futile detach/re-attach storms.
 */
export function terminalAttachWatchdogMs(attachRttMs: number): number {
  const scaled = Math.round(
    Math.max(0, attachRttMs) * ATTACH_WATCHDOG_RTT_FACTOR,
  );
  return Math.min(
    ATTACH_WATCHDOG_MAX_MS,
    Math.max(ATTACH_WATCHDOG_MIN_MS, scaled),
  );
}

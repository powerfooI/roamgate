import { describe, expect, test } from "bun:test";
import {
  TerminalAttachFrameWatchdog,
  TerminalResizeSync,
  clearTerminalRelayViewports,
  forgetTerminalRelayViewportsExcept,
  rememberTerminalRelayViewport,
  terminalAttachWatchdogMs,
  terminalEndpointViewportSize,
  terminalRelayViewportForTab,
  terminalRelayViewportSize,
} from "./terminalResize";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("TerminalResizeSync", () => {
  test("sends a changed size after the debounce window", async () => {
    const sent: Array<{ cols: number; rows: number }> = [];
    const sync = new TerminalResizeSync((size) => {
      sent.push(size);
      return true;
    }, 20);
    sync.markAttached({ cols: 100, rows: 30 });
    sync.schedule({ cols: 120, rows: 40 });
    expect(sent).toEqual([]);
    await tick(40);
    expect(sent).toEqual([{ cols: 120, rows: 40 }]);
    sync.dispose();
  });

  test("collapses a burst of sizes into the latest one", async () => {
    const sent: Array<{ cols: number; rows: number }> = [];
    const sync = new TerminalResizeSync((size) => {
      sent.push(size);
      return true;
    }, 25);
    sync.markAttached({ cols: 265, rows: 70 });
    // Simulates a CSS transition / window drag: many intermediate sizes.
    sync.schedule({ cols: 260, rows: 70 });
    await tick(10);
    sync.schedule({ cols: 238, rows: 66 });
    await tick(10);
    sync.schedule({ cols: 220, rows: 62 });
    await tick(50);
    expect(sent).toEqual([{ cols: 220, rows: 62 }]);
    sync.dispose();
  });

  test("skips sizes identical to the dispatched server size", async () => {
    const sent: Array<{ cols: number; rows: number }> = [];
    const sync = new TerminalResizeSync((size) => {
      sent.push(size);
      return true;
    }, 10);
    sync.markAttached({ cols: 142, rows: 44 });
    sync.schedule({ cols: 142, rows: 44 });
    sync.sendNow({ cols: 142, rows: 44 });
    await tick(30);
    expect(sent).toEqual([]);
    sync.dispose();
  });

  test("a burst returning to the synced size cancels the queued resize", async () => {
    const sent: Array<{ cols: number; rows: number }> = [];
    const sync = new TerminalResizeSync((size) => {
      sent.push(size);
      return true;
    }, 25);
    sync.markAttached({ cols: 142, rows: 44 });
    sync.schedule({ cols: 150, rows: 44 });
    await tick(10);
    sync.schedule({ cols: 142, rows: 44 });
    await tick(50);
    expect(sent).toEqual([]);
    sync.dispose();
  });

  test("sendNow delivers immediately and dedupes", () => {
    const sent: Array<{ cols: number; rows: number }> = [];
    const sync = new TerminalResizeSync((size) => {
      sent.push(size);
      return true;
    }, 10);
    sync.markAttached({ cols: 100, rows: 30 });
    expect(sync.sendNow({ cols: 101, rows: 30 })).toBe(true);
    expect(sync.sendNow({ cols: 101, rows: 30 })).toBe(false);
    expect(sent).toEqual([{ cols: 101, rows: 30 }]);
    sync.dispose();
  });

  test("a failed send keeps the size unsynced for the next attempt", async () => {
    const sent: Array<{ cols: number; rows: number }> = [];
    let deliverable = false;
    const sync = new TerminalResizeSync((size) => {
      if (!deliverable) return false;
      sent.push(size);
      return true;
    }, 10);
    sync.markAttached({ cols: 100, rows: 30 });
    // Resize arrives while the attach is still in flight: send is dropped.
    sync.sendNow({ cols: 120, rows: 40 });
    expect(sent).toEqual([]);
    // Once attached, the same size must still be delivered.
    deliverable = true;
    expect(sync.sendNow({ cols: 120, rows: 40 })).toBe(true);
    expect(sent).toEqual([{ cols: 120, rows: 40 }]);
    sync.dispose();
  });

  test("retries a dispatched size after its RPC is rejected", () => {
    const sent: Array<{ cols: number; rows: number }> = [];
    const sync = new TerminalResizeSync((size) => {
      sent.push(size);
      return true;
    });
    const size = { cols: 120, rows: 40 };
    sync.markAttached({ cols: 100, rows: 30 });
    expect(sync.sendNow(size)).toBe(true);
    sync.markFailed(size);
    expect(sync.sendNow(size)).toBe(true);
    expect(sent).toEqual([size, size]);
    sync.dispose();
  });

  test("rejects zero sizes", () => {
    const sent: Array<{ cols: number; rows: number }> = [];
    const sync = new TerminalResizeSync((size) => {
      sent.push(size);
      return true;
    }, 5);
    sync.schedule({ cols: 0, rows: 0 });
    expect(sync.sendNow({ cols: 0, rows: 1 })).toBe(false);
    expect(sent).toEqual([]);
    sync.dispose();
  });
});

describe("terminal relay viewport", () => {
  test("adds Herdr app chrome to a single pane", () => {
    expect(
      terminalRelayViewportSize(
        { cols: 142, rows: 44 },
        {
          area: { x: 26, y: 1, width: 54, height: 23 },
          panes: [{ pane_id: "pane_1", rect: { width: 54, height: 23 } }],
        },
        "pane_1",
      ),
    ).toEqual({ cols: 169, rows: 45 });
  });

  test("projects split pane dimensions back to one stable viewport", () => {
    const layout = {
      area: { x: 26, y: 1, width: 100, height: 40 },
      panes: [
        { pane_id: "left", rect: { width: 50, height: 40 } },
        { pane_id: "right", rect: { width: 50, height: 40 } },
      ],
    };
    expect(
      terminalRelayViewportSize({ cols: 70, rows: 44 }, layout, "left"),
    ).toEqual({ cols: 172, rows: 47 });
    expect(
      terminalRelayViewportSize({ cols: 70, rows: 44 }, layout, "right"),
    ).toEqual({ cols: 172, rows: 47 });
  });

  test("treats a zoomed split tab as one visible pane", () => {
    expect(
      terminalRelayViewportSize(
        { cols: 142, rows: 44 },
        {
          zoomed: true,
          area: { x: 26, y: 1, width: 100, height: 40 },
          panes: [
            { pane_id: "focused", rect: { width: 100, height: 40 } },
            { pane_id: "hidden", rect: { width: 50, height: 40 } },
          ],
        },
        "focused",
      ),
    ).toEqual({ cols: 169, rows: 45 });
  });

  test("falls back to the direct size without usable layout geometry", () => {
    expect(
      terminalRelayViewportSize({ cols: 100, rows: 30 }, null, "pane_1"),
    ).toEqual({ cols: 100, rows: 30 });
  });
});

describe("endpoint initial viewport", () => {
  const layout = {
    area: { x: 26, y: 1, width: 134, height: 69 },
    panes: [
      { pane_id: "left", rect: { width: 67, height: 69 } },
      { pane_id: "right", rect: { width: 67, height: 69 } },
    ],
  };

  test("both panes project a full-tab surface without app chrome", () => {
    for (const paneId of ["left", "right"]) {
      expect(
        terminalEndpointViewportSize({ cols: 134, rows: 69 }, layout, paneId),
      ).toEqual({ cols: 274, rows: 71 });
    }
  });

  test("single and zoomed panes include only pane chrome", () => {
    const fullPane = { pane_id: "left", rect: { width: 134, height: 69 } };
    for (const panes of [[fullPane], [fullPane, layout.panes[1]]]) {
      expect(
        terminalEndpointViewportSize(
          { cols: 271, rows: 70 },
          { ...layout, zoomed: true, panes },
          "left",
        ),
      ).toEqual({ cols: 272, rows: 70 });
    }
  });

  test("projects nested split dimensions", () => {
    expect(
      terminalEndpointViewportSize(
        { cols: 81, rows: 25 },
        {
          area: { x: 26, y: 1, width: 100, height: 40 },
          panes: [
            { pane_id: "small", rect: { width: 30, height: 10 } },
            { pane_id: "other", rect: { width: 70, height: 40 } },
          ],
        },
        "small",
      ),
    ).toEqual({ cols: 280, rows: 108 });
  });

  test("a pane already fitting the layout keeps the settled area verbatim", () => {
    // xterm fit floors fractional pixels, so a settled pane can measure one
    // cell under the layout-implied content size; that must not re-base the
    // shared geometry on every focus switch.
    for (const paneId of ["left", "right"]) {
      for (const size of [
        { cols: 64, rows: 67 },
        { cols: 63, rows: 66 },
        { cols: 65, rows: 68 },
      ]) {
        expect(terminalEndpointViewportSize(size, layout, paneId)).toEqual({
          cols: 134,
          rows: 69,
        });
      }
    }
  });

  test("both settled panes project the identical relay viewport", () => {
    // Regression: per-pane fit rounding must not alternate the shared relay
    // viewport (and with it the pane widths) when focus switches.
    for (const [paneId, size] of [
      ["left", { cols: 64, rows: 67 }],
      ["right", { cols: 63, rows: 66 }],
    ] as const) {
      expect(terminalRelayViewportSize(size, layout, paneId)).toEqual({
        cols: 160,
        rows: 70,
      });
    }
  });

  test("a real resize still projects a corrected viewport", () => {
    expect(
      terminalEndpointViewportSize({ cols: 70, rows: 67 }, layout, "left"),
    ).toEqual({ cols: 146, rows: 69 });
  });

  test("missing or unusable layout leaves sizing to endpoint feedback", () => {
    expect(
      terminalEndpointViewportSize({ cols: 134, rows: 69 }, null, "left"),
    ).toBeNull();
    expect(
      terminalEndpointViewportSize({ cols: 134, rows: 69 }, layout, "absent"),
    ).toBeNull();
    expect(
      terminalEndpointViewportSize(
        { cols: 134, rows: 69 },
        {
          ...layout,
          area: { ...layout.area, width: 0 },
        },
        "left",
      ),
    ).toBeNull();
  });
});

describe("terminal relay viewport cache", () => {
  test("isolates colliding tab IDs by connection generation and prunes one scope", () => {
    clearTerminalRelayViewports();
    rememberTerminalRelayViewport("alpha", 1, "same", {
      cols: 169,
      rows: 45,
    });
    rememberTerminalRelayViewport("beta", 1, "same", {
      cols: 172,
      rows: 47,
    });
    expect(terminalRelayViewportForTab("alpha", 1, "same")).toEqual({
      cols: 169,
      rows: 45,
    });
    expect(terminalRelayViewportForTab("beta", 1, "same")).toEqual({
      cols: 172,
      rows: 47,
    });
    expect(terminalRelayViewportForTab("alpha", 2, "same")).toBeNull();
    forgetTerminalRelayViewportsExcept("alpha", 1, new Set());
    expect(terminalRelayViewportForTab("alpha", 1, "same")).toBeNull();
    expect(terminalRelayViewportForTab("beta", 1, "same")).toEqual({
      cols: 172,
      rows: 47,
    });
    clearTerminalRelayViewports();
  });
});

describe("TerminalAttachFrameWatchdog", () => {
  test("does not arm when the frame arrived before the RPC response", async () => {
    const watchdog = new TerminalAttachFrameWatchdog();
    const attempt = watchdog.begin();
    let timedOut = false;
    watchdog.markFrame();
    expect(watchdog.arm(attempt, 5, () => (timedOut = true))).toBe(false);
    await tick(15);
    expect(timedOut).toBe(false);
    watchdog.dispose();
  });

  test("a frame arriving after the RPC response cancels the timer", async () => {
    const watchdog = new TerminalAttachFrameWatchdog();
    const attempt = watchdog.begin();
    let timedOut = false;
    expect(watchdog.arm(attempt, 15, () => (timedOut = true))).toBe(true);
    await tick(5);
    watchdog.markFrame();
    await tick(20);
    expect(timedOut).toBe(false);
    watchdog.dispose();
  });

  test("does not arm a superseded attach attempt", () => {
    const watchdog = new TerminalAttachFrameWatchdog();
    const staleAttempt = watchdog.begin();
    watchdog.begin();
    expect(watchdog.arm(staleAttempt, 5, () => {})).toBe(false);
    watchdog.dispose();
  });
});

describe("terminalAttachWatchdogMs", () => {
  test("keeps a snappy floor for local links", () => {
    expect(terminalAttachWatchdogMs(0)).toBe(4000);
    expect(terminalAttachWatchdogMs(200)).toBe(4000);
    expect(terminalAttachWatchdogMs(1000)).toBe(4000);
  });

  test("scales with the attach round trip on remote links", () => {
    expect(terminalAttachWatchdogMs(2500)).toBe(7500);
    expect(terminalAttachWatchdogMs(5000)).toBe(15000);
  });

  test("caps pathological round trips", () => {
    expect(terminalAttachWatchdogMs(30000)).toBe(20000);
  });
});

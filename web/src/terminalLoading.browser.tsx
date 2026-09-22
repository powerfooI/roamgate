import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { bridge, type ConnectionClient, type TerminalPush } from "./api";
import { __storeTesting, store, type State } from "./store";
import { TerminalView } from "./components/TerminalView";
import type { Pane, PaneLayout } from "./types";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout/app.css";

const failures: string[] = [];
const check = (condition: boolean, message: string) => {
  if (!condition) failures.push(message);
};
const settle = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

// Bun's fake clock does not reach Chrome. Control 500ms deadlines without
// delaying React scheduling or xterm rendering. This also advances xterm's
// unrelated scrollbar-hide timer, so a mount can register more than one timer.
const realSetTimeout = window.setTimeout;
const realClearTimeout = window.clearTimeout;
const timers = new Map<number, { at: number; fire: () => void }>();
let now = 0;
let timerId = 0;
window.setTimeout = ((
  handler: TimerHandler,
  delay?: number,
  ...args: unknown[]
) => {
  if (delay !== 500 || typeof handler !== "function")
    return realSetTimeout(handler, delay, ...args);
  const id = --timerId;
  timers.set(id, { at: now + delay, fire: () => handler(...args) });
  return id;
}) as typeof window.setTimeout;
window.clearTimeout = (id) => {
  timers.delete(Number(id));
  realClearTimeout(id as number);
};
const advance = async (ms: number) => {
  now += ms;
  flushSync(() => {
    for (const [id, timer] of timers) {
      if (timer.at > now) continue;
      timers.delete(id);
      timer.fire();
    }
  });
  await settle();
};

const listeners = new Set<(frame: TerminalPush) => void>();
let attachCalls = 0;
let attachError = "";
let cols = 80;
let rows = 24;
const client: ConnectionClient = {
  connectionId: "loading-test",
  generation: 1,
  serverRuntimeGeneration: 1,
  isCurrent: () => true,
  acceptsServerGeneration: () => true,
  call: async (method, params = {}) => {
    if (method === "terminal.attach") {
      attachCalls++;
      cols = Number(params.cols);
      rows = Number(params.rows);
      if (attachError) throw new Error(attachError);
    }
    return {};
  },
};
bridge.connection = () => client;
bridge.onTerminal = (listener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const pane: Pane = {
  pane_id: "pane",
  terminal_id: "terminal",
  workspace_id: "workspace",
  tab_id: "tab",
  focused: true,
  agent_status: "idle",
  revision: 1,
};
const layout: PaneLayout = {
  workspace_id: pane.workspace_id,
  tab_id: pane.tab_id,
  zoomed: false,
  splits: [],
  area: { x: 0, y: 0, width: 80, height: 24 },
  focused_pane_id: pane.pane_id,
  panes: [
    {
      pane_id: pane.pane_id,
      focused: true,
      rect: { x: 0, y: 0, width: 80, height: 24 },
    },
  ],
};
const initial: State = {
  ...store.get(),
  status: "connected" as const,
  connectionPaused: false,
  activeConnectionId: client.connectionId,
  connectionGeneration: 1,
  serverRuntimeGeneration: 1,
  panes: [pane],
  selectedPaneId: pane.pane_id,
  error: null,
  pendingFocusWorkspaceId: null,
  layout,
};
const host = document.createElement("div");
host.className = "workspace-terminal-surface";
host.style.cssText = "position:fixed;inset:0;display:flex";
document.body.append(host);
const root = createRoot(host);
let mountId = 0;
type LoadingKind = "navigation" | "attach";
const render = () =>
  root.render(
    <TerminalView
      key={mountId}
      terminalTheme={{ background: "#171922", foreground: "#dddddd" }}
      uiScale={100}
      showMobileKeys={false}
    />,
  );
const update = (patch: Partial<State>) =>
  flushSync(() => {
    // replaceState is deliberately silent; render to observe the new snapshot.
    __storeTesting.replaceState({ ...store.get(), ...patch });
    render();
  });
const mount = async (kind: LoadingKind) => {
  const before = attachCalls;
  mountId++;
  update({ ...initial, layout: kind === "attach" ? layout : null });
  await settle();
  check(
    kind === "navigation" || attachCalls > before,
    "attach actually started",
  );
};
const loading = () =>
  host
    .querySelector(".terminal-loading")
    ?.textContent?.includes("Loading terminal") === true;
const finish = async (kind: LoadingKind) => {
  if (kind === "navigation") {
    // Moving to an empty workspace ends navigation without starting an attach.
    update({ panes: [], selectedPaneId: null });
  } else {
    flushSync(() => {
      for (const listener of listeners)
        listener({
          connection_id: client.connectionId,
          connection_generation: 1,
          terminal_id: pane.terminal_id,
          width: cols,
          height: rows,
          full: true,
          mouse_reporting: false,
          bytes: btoa("ready"),
        });
    });
  }
  await settle();
};
const restart = async (kind: LoadingKind) => {
  if (kind === "navigation")
    update({ panes: [pane], selectedPaneId: pane.pane_id });
  else update({ terminalAttachEpoch: store.get().terminalAttachEpoch + 1 });
  await settle();
};

try {
  for (const kind of ["navigation", "attach"] as const) {
    await mount(kind);
    check(timers.size > 0, `${kind}: loading deadline is scheduled`);
    check(!loading(), `${kind}: no immediate spinner`);
    await advance(499);
    check(!loading(), `${kind}: no spinner at 499ms`);
    await advance(1);
    check(loading(), `${kind}: spinner at 500ms`);
    check(
      host.querySelector('[role="status"]')?.getAttribute("aria-live") ===
        "polite",
      `${kind}: accessible loading status`,
    );
    await finish(kind);
    check(!loading(), `${kind}: completion hides spinner`);

    // A new request in the same component must get a fresh grace period.
    await restart(kind);
    check(!loading(), `${kind}: previous elapsed flag is reset`);
    await advance(499);
    check(!loading(), `${kind}: second request still waits 500ms`);
    await finish(kind);
    check(timers.size === 0, `${kind}: fast completion cancels timer`);
    await advance(1);
    check(!loading(), `${kind}: cancelled timer never shows spinner`);

    await restart(kind);
    check(
      !loading(),
      `${kind}: cancelled request cannot expire the next request`,
    );
    await advance(499);
    flushSync(() => root.render(null));
    check(timers.size === 0, `${kind}: unmount cancels timer`);
    await mount(kind);
    await advance(1);
    check(!loading(), `${kind}: old deadline does not affect new mount`);
    await advance(498);
    check(!loading(), `${kind}: new mount waits its own 500ms`);
    await advance(1);
    check(loading(), `${kind}: new mount shows slow loading`);
    await finish(kind);
  }

  attachError = "Fixture attach failed";
  await mount("attach");
  check(
    host.querySelector('[role="alert"]')?.textContent?.includes(attachError) ===
      true,
    "attach errors are immediate, not delayed 500ms",
  );
  await advance(500);
  check(!loading(), "attach error never becomes a loading spinner");
} catch (error) {
  failures.push(String(error));
} finally {
  flushSync(() => root.unmount());
  window.setTimeout = realSetTimeout;
  window.clearTimeout = realClearTimeout;
  await fetch("/result", { method: "POST", body: JSON.stringify(failures) });
}

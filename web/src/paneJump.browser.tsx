import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import App from "./App";
import { bridge, type ConnectionClient } from "./api";
import { __storeTesting, store } from "./store";
import { selectShortcutPreset } from "./shortcutPreferences";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/vendor.css";

const failures: string[] = [];
const check = (condition: boolean, message: string) => {
  if (!condition) failures.push(message);
};
const boundary = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
async function until(predicate: () => unknown) {
  for (let i = 0; i < 120; i++) {
    if (predicate()) return;
    await boundary();
  }
  throw new Error("Pane switcher did not reach the expected state");
}
async function input(method: string, params: Record<string, unknown>) {
  const response = await fetch("/input", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  if (!response.ok) throw new Error("Browser input failed");
  await boundary();
}
async function key(
  value: string,
  code: string,
  modifiers = 0,
  type = "keyDown",
  autoRepeat = false,
) {
  await input("Input.dispatchKeyEvent", {
    type,
    key: value,
    code,
    modifiers,
    autoRepeat,
  });
}

async function run() {
  const client: ConnectionClient = {
    connectionId: "pane-jump-test",
    generation: 1,
    serverRuntimeGeneration: 1,
    isCurrent: () => true,
    acceptsServerGeneration: () => true,
    call: async () => ({}),
  };
  store.init = () => {};
  bridge.connection = () => client;
  bridge.onTerminal = () => () => {};
  bridge.onTerminalClosed = () => () => {};
  const focused: string[] = [];
  store.focusPane = async (paneId) => {
    focused.push(paneId);
  };
  __storeTesting.replaceState({
    ...store.get(),
    status: "connected",
    activeConnectionId: client.connectionId,
    connectionGeneration: 1,
    serverRuntimeGeneration: 1,
    lastRefresh: 1,
    workspaces: [
      {
        workspace_id: "w1",
        number: 1,
        label: "Project",
        focused: true,
        pane_count: 2,
        tab_count: 1,
        agent_status: "idle",
        active_tab_id: "w1:t1",
      },
    ],
    tabs: [
      {
        tab_id: "w1:t1",
        workspace_id: "w1",
        number: 1,
        label: "1",
        focused: true,
        pane_count: 2,
        agent_status: "idle",
      },
    ],
    panes: [1, 2].map((n) => ({
      pane_id: `w1:p${n}`,
      terminal_id: `terminal-${n}`,
      workspace_id: "w1",
      tab_id: "w1:t1",
      cwd: "/repo",
      focused: n === 1,
      agent_status: "idle",
      revision: 1,
    })),
    recentPaneIds: ["w1:p1", "w1:p2"],
    selectedPaneId: "w1:p1",
    connections: [
      {
        id: client.connectionId,
        label: "Test",
        source: "test",
        is_default: true,
        state: "ready",
        generation: 1,
      },
    ],
    layout: {
      workspace_id: "w1",
      tab_id: "w1:t1",
      zoomed: false,
      splits: [],
      area: { x: 0, y: 0, width: 80, height: 24 },
      focused_pane_id: "w1:p1",
      panes: [
        {
          pane_id: "w1:p1",
          focused: true,
          rect: { x: 0, y: 0, width: 80, height: 24 },
        },
      ],
    },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<App />));
  try {
    await until(() => document.querySelector(".xterm-helper-textarea"));
    const terminal = document.querySelector<HTMLTextAreaElement>(
      ".xterm-helper-textarea",
    )!;
    const search = () =>
      document.querySelector<HTMLInputElement>(".pane-jump-search");
    for (const platform of ["mac", "windows", "linux"] as const) {
      flushSync(() => selectShortcutPreset(platform));
      for (const reverse of [false, true]) {
        terminal.focus();
        const openingModifiers = platform === "mac" ? 2 : 3;
        const heldModifiers = openingModifiers | (reverse ? 8 : 0);
        await key(
          platform === "mac" ? "Tab" : "j",
          platform === "mac" ? "Tab" : "KeyJ",
          platform === "mac" ? heldModifiers : openingModifiers,
        );
        check(
          !!document.querySelector(".pane-jump-backdrop"),
          `${platform}: recent switcher did not open`,
        );
        check(!search(), `${platform}: recent switcher started in search mode`);
        check(
          document
            .querySelector(".pane-jump-list")
            ?.textContent?.includes("Pane p2") === true,
          "Recent items omit the pane ID",
        );
        // IME composition must not turn K into an application shortcut.
        terminal.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "k",
            code: "KeyK",
            ctrlKey: true,
            isComposing: true,
            bubbles: true,
          }),
        );
        await boundary();
        check(!search(), "Composing K entered search mode");
        await key(reverse ? "K" : "k", "KeyK", heldModifiers);
        check(
          !!search(),
          `${platform}, reverse=${reverse}: held-modifier K did not enter search`,
        );
        check(
          !document.querySelector(".command-popover"),
          `${platform}: K opened the command menu`,
        );
        check(
          document.activeElement === search(),
          "Search did not receive focus",
        );
        check(search()?.value === "", "Opening K leaked into the query");
        await key("k", "KeyK", heldModifiers, "keyUp");
        await key("Control", "ControlLeft", 0, "keyUp");
        check(
          !!search() && focused.length === 0,
          "Releasing Ctrl committed the jump",
        );
        check(
          document
            .querySelector(".pane-jump-list")
            ?.textContent?.includes("Pane p2") === true,
          "Search items omit the pane ID",
        );
        await input("Input.insertText", { text: "p2" });
        check(
          document.querySelectorAll(".pane-jump-item").length === 1,
          "Pane ID search did not narrow the results",
        );
        await key("Enter", "Enter");
        check(
          focused.pop() === "w1:p2",
          "Enter did not focus the matching pane",
        );
        check(!search(), "Enter did not close search");
      }
      terminal.focus();
      await key("k", "KeyK", 1);
      check(!!search(), `${platform}: Alt+K no longer opens search`);
      await key("k", "KeyK", 1, "keyDown", true);
      check(!!search(), "Repeated Alt+K closed search");
      await key("k", "KeyK", 1, "keyUp");
      await key("Escape", "Escape");
      check(!search(), "Escape did not close search");
      terminal.focus();
      await key("k", "KeyK", platform === "mac" ? 4 : 3);
      await until(() => document.querySelector(".command-popover"));
      check(
        !search(),
        "Command shortcut outside the switcher opened pane search",
      );
      await key("Escape", "Escape");
      await until(() => !document.querySelector(".command-popover"));
    }
  } finally {
    root.unmount();
    host.remove();
  }
}
run()
  .catch((error) => failures.push(String(error)))
  .finally(() =>
    fetch("/result", { method: "POST", body: JSON.stringify(failures) }),
  );

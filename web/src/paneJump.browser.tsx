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

function checkSearchAccessibility() {
  const field = document.querySelector<HTMLInputElement>(".pane-jump-search")!;
  const selected = document.querySelector(".pane-jump-item.is-selected");
  check(field.getAttribute("role") === "combobox", "Search is not a combobox");
  check(
    field.getAttribute("aria-expanded") === "true",
    "Search is not expanded",
  );
  check(
    field.getAttribute("aria-autocomplete") === "list",
    "Search autocomplete is missing",
  );
  check(
    document
      .getElementById(field.getAttribute("aria-controls")!)
      ?.getAttribute("role") === "listbox",
    "Search does not control its listbox",
  );
  const activeId = field.getAttribute("aria-activedescendant");
  check(
    selected
      ? !!activeId && document.getElementById(activeId) === selected
      : activeId === null,
    "Accessible focus does not match the selected result",
  );
  check(
    document.activeElement === field,
    "Result navigation moved DOM focus out of search",
  );
}

function checkPaneIdsVisible() {
  const rows = document.querySelectorAll<HTMLElement>(".pane-jump-item");
  check(rows.length === 2, "Expected two same-tab panes");
  for (const row of rows) {
    const label = row.querySelector<HTMLElement>(".pane-jump-id");
    check(!!label, "Pane ID has no independent label");
    if (!label) continue;
    check(
      label.parentElement?.classList.contains("pane-jump-subtitle") === true &&
        label.previousElementSibling?.classList.contains("pane-jump-tab") ===
          true,
      "Pane ID must follow the tab label in the left subtitle",
    );
    const range = document.createRange();
    range.selectNodeContents(label);
    const text = range.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    check(
      text.width > 0 &&
        text.left >= box.left &&
        text.right <= box.right &&
        text.right <= innerWidth,
      "Long tab name clipped the pane ID",
    );
    check(
      label.clientWidth >= label.scrollWidth,
      "Pane ID text is internally clipped",
    );
  }
}

async function run() {
  const outside = document.createElement("input");
  outside.setAttribute("aria-label", "Outside focus target");
  outside.style.cssText =
    "position:fixed;left:0;top:0;width:120px;height:30px;z-index:10000";
  document.body.append(outside);
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
    // Stand in for the destination pane taking focus after a real jump.
    outside.focus();
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
        label: "W".repeat(80),
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
      agent: n === 2 ? "codex" : undefined,
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
        checkPaneIdsVisible();
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
        checkPaneIdsVisible();
        checkSearchAccessibility();
        const originalId = search()!.getAttribute("aria-activedescendant");
        await key("ArrowUp", "ArrowUp");
        checkSearchAccessibility();
        check(
          search()!.getAttribute("aria-activedescendant") !== originalId,
          "ArrowUp did not move accessible focus",
        );
        await key("ArrowDown", "ArrowDown");
        checkSearchAccessibility();
        await key("Tab", "Tab");
        checkSearchAccessibility();
        await key("Tab", "Tab", 8);
        checkSearchAccessibility();
        check(
          search()!.getAttribute("aria-activedescendant") === originalId,
          "Reverse navigation did not restore accessible focus",
        );
        await input("Input.insertText", { text: "p2" });
        checkSearchAccessibility();
        check(
          search()!.getAttribute("aria-activedescendant") === originalId,
          "Filtering changed the surviving option ID",
        );
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
        check(
          document.activeElement === outside,
          "A real jump restored focus to the old pane",
        );
      }
      terminal.focus();
      await key("k", "KeyK", 1);
      check(!!search(), `${platform}: Alt+K no longer opens search`);
      await key("k", "KeyK", 1, "keyDown", true);
      check(!!search(), "Repeated Alt+K closed search");
      await key("k", "KeyK", 1, "keyUp");
      await key("Escape", "Escape");
      check(!search(), "Escape did not close search");
      check(
        document.activeElement === terminal,
        "Escape did not restore terminal focus",
      );
      // Do not manually focus the terminal between keyboard dismissals.
      await key("k", "KeyK", 1);
      await key("k", "KeyK", 1, "keyUp");
      await key("k", "KeyK", 1);
      check(!search(), "Second Alt+K did not close search");
      check(
        document.activeElement === terminal,
        "Alt+K dismissal lost terminal focus",
      );
      await key("k", "KeyK", 1);
      await input("Input.insertText", { text: "p1" });
      checkSearchAccessibility();
      check(
        document.querySelectorAll(".pane-jump-item").length === 1,
        "Current-only query did not narrow results",
      );
      await key("Enter", "Enter");
      check(
        !search() && focused.length === 0,
        "Current-only Enter unexpectedly jumped",
      );
      check(
        document.activeElement === terminal,
        "Current-only Enter lost terminal focus",
      );
      await key("k", "KeyK", 1);
      await input("Input.insertText", { text: "no-such-pane" });
      checkSearchAccessibility();
      check(
        document.querySelectorAll(".pane-jump-item").length === 0,
        "Expected empty search results",
      );
      await key("Enter", "Enter");
      check(
        !search() && focused.length === 0,
        "Empty search unexpectedly jumped",
      );
      check(
        document.activeElement === terminal,
        "Empty-result Enter lost terminal focus",
      );
      await key("k", "KeyK", 1);
      const outsideBounds = outside.getBoundingClientRect();
      for (const type of ["mousePressed", "mouseReleased"])
        await input("Input.dispatchMouseEvent", {
          type,
          x: outsideBounds.left + 10,
          y: outsideBounds.top + 10,
          button: "left",
          clickCount: 1,
        });
      check(!search(), "Clicking outside did not close search");
      check(
        document.activeElement === outside,
        "Blur dismissal stole the user's new focus",
      );
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
    outside.remove();
  }
}
run()
  .catch((error) => failures.push(String(error)))
  .finally(() =>
    fetch("/result", { method: "POST", body: JSON.stringify(failures) }),
  );

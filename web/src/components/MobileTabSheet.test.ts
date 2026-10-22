import { expect, test } from "bun:test";

const nav = await Bun.file(
  new URL("../styles/layout/mobile-nav.css", import.meta.url),
).text();
const app = await Bun.file(new URL("../App.tsx", import.meta.url)).text();
const sheet = await Bun.file(
  new URL("./MobileTabSheet.tsx", import.meta.url),
).text();

test("Tabs and More share popup geometry and chrome inside the app stacking context", () => {
  expect(nav).toMatch(
    /body \.app \.mobile-tab-sheet,\s*body \.app\[data-mobile-more\] \.mobile-controls-stack \{/,
  );
  const popup = nav.slice(
    nav.indexOf("body .app .mobile-tab-sheet,"),
    nav.indexOf("body .app .mobile-popup-head"),
  );
  for (const declaration of [
    "position: fixed",
    "z-index: 132",
    "272px",
    "100% -",
    "border-radius: 10px",
    "background: var(--panel)",
    "box-shadow: var(--shadow-lg)",
    "overflow-y: auto",
    "overscroll-behavior-y: contain",
    "env(safe-area-inset-top",
    "var(--keyboard-inset-content",
    "var(--ui-scale, 1)",
  ])
    expect(popup).toContain(declaration);
  expect(nav).toMatch(/\.mobile-bottom-bar\s*\{[^}]*z-index: 131/);
  expect(nav).toMatch(/\.mobile-more-backdrop\s*\{[^}]*z-index: 130/);
  expect(nav).toContain(".mobile-popup-head .close-button:focus-visible");
  expect(nav).toContain("outline-color: Highlight");
  expect(sheet).not.toContain("createPortal");
  expect(sheet).not.toContain('aria-modal="true"');
  expect(sheet).toContain(
    'className="mobile-more-backdrop mobile-tab-sheet-backdrop"',
  );
  expect(app.indexOf("<MobileTabSheet")).toBeLessThan(
    app.indexOf('className="mobile-controls-stack"'),
  );
  expect(app).toContain('className="mobile-more-head mobile-popup-head"');
  // Both still register popup-level Back rather than a view-navigation layer.
  expect(app).toMatch(/useSystemBack\(\s*mobileTabSheetOpen,[\s\S]*?"popup"/);
  expect(app).toMatch(
    /useSystemBack\(\s*mobile && mobileMoreOpen,[\s\S]*?"popup"/,
  );
});

test("Tabs and More preserve input toolbar visibility without bypassing pane scope or closed state", () => {
  // Exercise App's actual visibility predicate, not a second implementation in
  // the harness. Popup focus/blur remains independent of toolbar visibility.
  const expression = app.match(
    /const terminalComposerOpen =\s*([\s\S]*?);/,
  )?.[1];
  expect(expression).toBeDefined();
  const isOpen = new Function(
    "mobile",
    "mobileTabSheetOpen",
    "mobileMoreOpen",
    "openTerminalComposerScopeKey",
    "terminalComposerScopeKey",
    "activeTerminalComposerDraftKey",
    `return (${expression});`,
  );
  for (const tabs of [false, true]) {
    for (const more of [false, true]) {
      // Open tools/shortcuts stay open for either popup; previously closed
      // tools, stale connections/panes and absent active panes stay closed.
      expect(
        isOpen(true, tabs, more, "connection:pane", "connection:pane", "draft"),
      ).toBe(true);
      expect(isOpen(true, tabs, more, null, "connection:pane", "draft")).toBe(
        false,
      );
      expect(
        isOpen(true, tabs, more, "old:pane", "connection:pane", "draft"),
      ).toBe(false);
      expect(
        isOpen(true, tabs, more, "connection:old", "connection:pane", "draft"),
      ).toBe(false);
      expect(
        isOpen(true, tabs, more, "connection:pane", "connection:pane", null),
      ).toBe(false);
      expect(
        isOpen(
          false,
          tabs,
          more,
          "connection:pane",
          "connection:pane",
          "draft",
        ),
      ).toBe(false);
    }
  }
});

if (process.env.ROAMGATE_TAB_POPUP_DOM_TEST !== "1") {
  test("tab popup DOM interactions in an isolated runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_TAB_POPUP_DOM_TEST: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
    expect(code).toBe(0);
  }, 15_000);
} else {
  const { mock } = await import("bun:test");
  const { Window } = await import("happy-dom");
  const browser = new Window({ url: "http://localhost" });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  const { act, createElement, StrictMode, useState } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const pins = new Set(["pinned"]);
  const state = {
    activeConnectionId: "local",
    connectionGeneration: 1,
    selectedPaneId: "one:p2",
    layout: {
      focused_pane_id: "one:p1",
      panes: [{ pane_id: "one:p1" }, { pane_id: "one:p2" }],
    },
    panes: ["one", "pinned"].flatMap((tab_id) =>
      [1, 2].map((number) => ({
        pane_id: `${tab_id}:p${number}`,
        tab_id,
        agent: number === 1 ? "codex" : undefined,
        cwd: `/project/${tab_id}`,
      })),
    ),
    workspaces: [{ workspace_id: "ws", focused: true }],
    tabs: [
      { tab_id: "one", workspace_id: "ws", name: "First", focused: true },
      { tab_id: "pinned", workspace_id: "ws", name: "Pinned", focused: false },
    ],
  };
  let complete: (() => void) | undefined;
  const focusTab = mock(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  const createTab = mock(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  const focusPane = mock(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  const requestCloseTab = mock(() => {});
  const setTabPinned = mock(() => {});
  mock.module("../store", () => ({
    store: { focusTab, createTab, focusPane },
    useStoreSelector: (select: (s: typeof state) => unknown) => select(state),
    shallowEqual: () => true,
    useEndpointCreationReason: () => null,
  }));
  mock.module("./TabBar", () => ({
    requestCloseTab,
    tabName: (t: { name: string }) => t.name,
  }));
  mock.module("../tabPins", () => ({
    useTabPins: () => pins,
    setTabPinned,
    orderTabsForDisplay: (tabs: unknown[]) => tabs,
  }));
  mock.module("./agentSession", () => ({ summarizeTabAgents: () => null }));
  mock.module("./AgentStatusIcon", () => ({ AgentStatusIcon: () => null }));
  const { MobileTabSheet } = await import("./MobileTabSheet");
  const { MobileBottomBar } = await import("./MobileBottomBar");
  const container = document.createElement("div");
  container.className = "app";
  document.body.append(container);
  const root = createRoot(container);
  let shown = 0;
  function Harness() {
    const [tabs, setTabs] = useState(false);
    const [more, setMore] = useState(false);
    return createElement(
      "div",
      null,
      createElement(MobileTabSheet, {
        open: tabs,
        onClose: () => setTabs(false),
        onShowSession: () => {
          shown++;
        },
      }),
      more
        ? createElement(
            "div",
            { id: "mobile-more-options" },
            createElement("button", null, "More action"),
          )
        : null,
      createElement(MobileBottomBar, {
        inputRef: null,
        tabCount: state.tabs.length,
        attention: false,
        tabsOpen: tabs,
        moreOpen: more,
        onTabsOpenChange: setTabs,
        onMoreOpenChange: setMore,
      }),
    );
  }
  const render = () =>
    root.render(createElement(StrictMode, null, createElement(Harness)));
  const button = (label: string) =>
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (item) =>
        item.getAttribute("aria-label") === label || item.textContent === label,
    )!;
  const click = async (label: string) => act(async () => button(label).click());
  const escape = async () =>
    act(async () =>
      browser.dispatchEvent(
        new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
  test("tab and pane navigation preserve pending guards, focus and popup switching", async () => {
    try {
      await act(async () => render());
      await click("Show tabs");
      const popup = container.querySelector('[role="dialog"]')!;
      expect(popup.parentElement?.closest(".app")).toBe(container);
      expect(popup.hasAttribute("aria-modal")).toBe(false);
      expect(document.activeElement).toBe(popup.querySelector(".close-button"));
      await click("More options");
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement?.textContent).toBe("More action");
      await click("Show tabs");
      expect(container.querySelector("#mobile-more-options")).toBeNull();
      expect(document.activeElement?.classList.contains("close-button")).toBe(
        true,
      );
      await click("Close First");
      expect(requestCloseTab).toHaveBeenCalledWith("one");
      await click("Unpin Pinned");
      expect(setTabPinned).toHaveBeenCalledWith("local", "pinned", false);
      const modal = document.createElement("div");
      modal.className = "modal-backdrop";
      document.body.append(modal);
      await escape();
      expect(container.querySelector('[role="dialog"]')).not.toBeNull();
      modal.remove();
      await click("First");
      await click("First");
      await click("New Tab");
      await click("Close tab switcher");
      await escape();
      expect(focusTab).toHaveBeenCalledTimes(1);
      expect(createTab).toHaveBeenCalledTimes(0);
      expect(
        container.querySelector('[role="dialog"]')?.getAttribute("aria-busy"),
      ).toBe("true");
      await act(async () => complete!());
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(shown).toBe(1);
      expect(document.activeElement).toBe(button("Show tabs"));
      await click("Show tabs");
      await click("New Tab");
      expect(createTab).toHaveBeenCalledWith("ws");
      await act(async () => complete!());
      expect(shown).toBe(2);
      // Navigation stays usable during a request; its eventual completion must
      // not close More, steal its focus, or activate a stale session.
      await click("Show tabs");
      await click("First");
      await click("More options");
      const moreFocus = document.activeElement;
      await act(async () => complete!());
      expect(shown).toBe(2);
      expect(container.querySelector("#mobile-more-options")).not.toBeNull();
      expect(document.activeElement).toBe(moreFocus);
      await click("Show tabs");
      await click("First");
      await click("More options");
      await click("Show tabs");
      await act(async () => complete!());
      expect(shown).toBe(2);
      expect(container.querySelector('[role="dialog"]')).not.toBeNull();
      await escape();
      await click("Show tabs");
      await click("First");
      // A reconnect on the same ID also invalidates the original completion.
      state.connectionGeneration++;
      await act(async () => render());
      await act(async () => complete!());
      expect(shown).toBe(2);
      await escape();
      // Escape never restores focus into an editor or steals unrelated focus.
      await click("Show tabs");
      button("More options").focus();
      await escape();
      expect(document.activeElement).toBe(button("More options"));
      // Pane groups belong to their tab; browser selection takes precedence
      // over the server's focus and a stale selection falls back to the layout.
      await click("Show tabs");
      const groups = container.querySelectorAll(".mobile-tab-sheet-panes");
      expect(groups).toHaveLength(2);
      expect(groups[0]?.getAttribute("aria-label")).toBe("First panes");
      expect(groups[1]?.getAttribute("aria-label")).toBe("Pinned panes");
      expect(groups[0]?.querySelectorAll("button")).toHaveLength(2);
      expect(button("First: Pane p1").textContent).toContain("codex");
      expect(button("First: Pane p2").textContent).toContain("/project/one");
      expect(button("First: Pane p2").getAttribute("aria-current")).toBe(
        "true",
      );
      expect(button("Pinned: Pane p2").hasAttribute("aria-current")).toBe(
        false,
      );
      state.selectedPaneId = "gone";
      await act(async () => render());
      expect(button("First: Pane p1").getAttribute("aria-current")).toBe(
        "true",
      );
      expect(button("First: Pane p2").hasAttribute("aria-current")).toBe(false);
      const tabCalls = focusTab.mock.calls.length;
      for (const [name, id] of [
        ["First: Pane p2", "one:p2"],
        ["Pinned: Pane p2", "pinned:p2"],
      ]) {
        const paneCalls = focusPane.mock.calls.length;
        const previousShown = shown;
        await click(name!);
        await click(name!);
        await click("New Tab");
        await escape();
        expect(focusPane).toHaveBeenLastCalledWith(id);
        expect(focusPane).toHaveBeenCalledTimes(paneCalls + 1);
        expect(button("New Tab").disabled).toBe(true);
        expect(container.querySelector('[role="dialog"]')).not.toBeNull();
        await act(async () => complete!());
        expect(container.querySelector('[role="dialog"]')).toBeNull();
        expect(shown).toBe(previousShown + 1);
        expect(document.activeElement).toBe(button("Show tabs"));
        await click("Show tabs");
      }
      expect(focusTab).toHaveBeenCalledTimes(tabCalls);
      await escape();
      // Empty and single-tab workspaces retain their create affordance.
      state.tabs = [];
      await click("Show tabs");
      expect(container.querySelectorAll('[role="listitem"]')).toHaveLength(0);
      expect(button("New Tab").disabled).toBe(false);
      await escape();
      state.tabs = [
        { tab_id: "one", workspace_id: "ws", name: "Only", focused: true },
      ];
      state.panes = state.panes.slice(0, 1);
      await click("Show tabs");
      expect(container.querySelectorAll('[role="listitem"]')).toHaveLength(1);
      expect(container.querySelector(".mobile-tab-sheet-panes")).toBeNull();
      await escape();
      state.workspaces = [];
      await click("Show tabs");
      expect(container.textContent).toContain("Select or create a workspace");
      expect(button("New Tab").disabled).toBe(true);
    } finally {
      await act(async () => root.unmount());
      await browser.happyDOM.abort();
    }
  });
}

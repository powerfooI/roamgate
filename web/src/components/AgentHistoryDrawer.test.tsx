import { expect, mock, test } from "bun:test";
import * as React from "react";
import type { Pane } from "../types";

if (process.env.ROAMGATE_HISTORY_DRAWER_DOM_TEST !== "1") {
  test("history drawer mobile disclosures in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_HISTORY_DRAWER_DOM_TEST: "1" },
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
  test("mobile session and search start collapsed, remain accessible, and reset per pane", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/?layout=mobile" });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      Event: browser.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    }
    const client = {
      isCurrent: () => true,
      call: async (method: string) =>
        method === "agent_session.get"
          ? { status: "ok", stats: {} }
          : { status: "ok", mode: "snapshot", messages: [], cursor: null },
    };
    mock.module("../useConnectionClient", () => ({
      useConnectionClient: () => client,
      useConnectionReady: () => true,
      connectionClientScopeKey: () => "test",
    }));
    const { initializeLayoutPreferences, updateLayoutPreferences } =
      await import("../layoutPreferences");
    initializeLayoutPreferences();
    const { AgentHistoryDrawer } = await import("./AgentHistoryDrawer");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const pane: Pane = {
      pane_id: "pane-one",
      terminal_id: "term-one",
      workspace_id: "workspace",
      tab_id: "tab",
      agent: "codex",
      agent_status: "idle",
      focused: true,
      revision: 1,
    };
    const onOpenChange = mock(() => {});
    const render = (current = pane) =>
      React.act(async () => {
        root.render(
          <AgentHistoryDrawer
            pane={current}
            open
            embedded
            onOpenChange={onOpenChange}
          />,
        );
      });
    const button = (label: string) =>
      container.querySelector<HTMLButtonElement>(
        `button[aria-label="${label}"]`,
      )!;
    const click = (element: HTMLElement) =>
      React.act(async () => element.click());
    try {
      await render();
      const header = () =>
        container.querySelector<HTMLElement>(".agent-history-drawer-head")!;
      const toggle = () =>
        container.querySelector<HTMLButtonElement>(
          ".agent-history-session-toggle",
        )!;
      const search = () =>
        container.querySelector<HTMLInputElement>('input[type="search"]');
      expect(container.querySelector(".agent-history-composer")).toBeNull();
      expect(header().hidden).toBe(true);
      expect(toggle().getAttribute("aria-expanded")).toBe("false");
      expect(search()).toBeNull();
      const chatToggle = button("Chat view");
      expect(chatToggle.closest(".agent-history-mobile-head")).not.toBeNull();
      expect(
        container.querySelectorAll('[aria-label="Chat view"]').length,
      ).toBe(1);
      expect(chatToggle.nextElementSibling).toBe(
        button("Search history messages"),
      );
      expect(button("Search history messages").nextElementSibling).toBe(
        button("Close session"),
      );
      expect(chatToggle.getAttribute("aria-pressed")).toBe("true");
      const drawer = container.querySelector<HTMLElement>(
        ".agent-history-drawer",
      )!;
      expect(drawer.dataset.view).toBe("chat");
      await click(chatToggle);
      expect(chatToggle.getAttribute("aria-pressed")).toBe("false");
      expect(drawer.dataset.view).toBe("timeline");
      expect(container.querySelector(".agent-history-filters")).not.toBeNull();
      await click(chatToggle);
      expect(chatToggle.getAttribute("aria-pressed")).toBe("true");
      await click(button("Close session"));
      expect(onOpenChange).toHaveBeenCalledWith(false);
      await click(toggle());
      expect(header().hidden).toBe(false);
      expect(toggle().getAttribute("aria-controls")).toBe(header().id);
      await click(button("Session details"));
      expect(drawer.dataset.view).toBe("details");
      await click(chatToggle);
      expect(drawer.dataset.view).toBe("chat");
      await click(toggle());
      expect(header().hidden).toBe(true);

      await click(button("Search history messages"));
      expect(search()).not.toBeNull();
      expect(document.activeElement).toBe(search());
      await React.act(async () => {
        Object.getOwnPropertyDescriptor(
          browser.HTMLInputElement.prototype,
          "value",
        )!.set!.call(search(), "no match");
        search()!.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
      await React.act(async () => {
        search()!.dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect(search()).toBeNull();
      expect(document.activeElement).toBe(button("Search history messages"));
      await click(button("Search history messages"));
      expect(search()!.value).toBe("");
      await click(button("Close search"));
      expect(search()).toBeNull();
      await click(toggle());
      await click(button("Search history messages"));
      await render({ ...pane, pane_id: "pane-two" });
      expect(header().hidden).toBe(true);
      expect(search()).toBeNull();

      await React.act(async () => updateLayoutPreferences({ mode: "desktop" }));
      expect(container.querySelector(".agent-history-mobile-head")).toBeNull();
      expect(
        button("Chat view").closest(".agent-history-actions"),
      ).not.toBeNull();
      expect(
        container.querySelector('[aria-label="Close session"]'),
      ).toBeNull();
      expect(container.querySelector(".agent-history-composer")).not.toBeNull();
      expect(header().hidden).toBe(false);
      expect(search()).not.toBeNull();
      await React.act(async () => {
        Object.getOwnPropertyDescriptor(
          browser.HTMLInputElement.prototype,
          "value",
        )!.set!.call(search(), "desktop query");
        search()!.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
      await React.act(async () => updateLayoutPreferences({ mode: "mobile" }));
      expect(container.querySelector(".agent-history-composer")).toBeNull();
      expect(search()!.value).toBe("desktop query");
      expect(
        button("Search history messages").getAttribute("aria-expanded"),
      ).toBe("true");
      await click(button("Close search"));
      expect(search()).toBeNull();
    } finally {
      await React.act(async () => root.unmount());
      container.remove();
      await browser.happyDOM.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      mock.restore();
    }
  });
}

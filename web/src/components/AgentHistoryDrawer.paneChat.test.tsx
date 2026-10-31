import { expect, mock, test } from "bun:test";
import * as React from "react";
import type { Pane } from "../types";

if (process.env.ROAMGATE_PANE_CHAT_DOM_TEST !== "1") {
  test("pane chat in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_PANE_CHAT_DOM_TEST: "1" },
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
  test("a pane's chat has one slim row and says what the agent does", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/" });
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      DOMParser: browser.DOMParser,
      NodeFilter: browser.NodeFilter,
      ResizeObserver: browser.ResizeObserver,
      Event: browser.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    }))
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    const client = {
      isCurrent: () => true,
      call: async (method: string) =>
        method === "agent_session.get"
          ? { status: "ok", stats: {}, session: { value: "s1" } }
          : {
              status: "ok",
              agent: "claude",
              pane_id: "pane-one",
              workspace_id: "workspace",
              tab_id: "tab",
              path: "/sessions/s1.jsonl",
              updated_at: "2026-01-01T00:00:00Z",
              history_version: 2,
              mode: "snapshot",
              cursor: { epoch: "e", revision: 1 },
              window_limit: 200,
              entries: [
                {
                  id: "m1",
                  role: "user",
                  kind: "message",
                  text: "Run the tests",
                  sent_at: "2026-01-01T00:00:00Z",
                },
              ],
            },
    };
    mock.module("../useConnectionClient", () => ({
      useConnectionClient: () => client,
      useConnectionReady: () => true,
      connectionClientScopeKey: () => "test",
    }));
    const { initializeLayoutPreferences } = await import(
      "../layoutPreferences"
    );
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
      agent: "claude",
      agent_status: "working",
      focused: true,
      revision: 1,
    };
    const onKeys = mock<(text: string) => void>(() => {});
    const onShowTerminal = mock(() => {});
    const render = (agent_status: string) =>
      React.act(async () => {
        root.render(
          <AgentHistoryDrawer
            pane={{ ...pane, agent_status }}
            open
            embedded
            paneChat={{ onKeys, onShowTerminal }}
            onOpenChange={() => {}}
          />,
        );
      });
    const button = (label: string) =>
      container.querySelector<HTMLButtonElement>(
        `button[aria-label="${label}"]`,
      );
    const click = (element: HTMLElement) =>
      React.act(async () => element.click());
    try {
      await render("working");
      expect(container.textContent).toContain("Run the tests");
      expect(container.querySelector(".is-pane-chat")).not.toBeNull();
      // The History drawer's own controls stay in the History drawer.
      expect(button("Session details")).toBeNull();
      expect(button("Chat view")).toBeNull();
      expect(container.querySelector('input[type="search"]')).toBeNull();
      expect(container.querySelector(".agent-history-composer")).not.toBeNull();
      expect(container.querySelector(".agent-chat-activity")).not.toBeNull();
      await click(button("Stop")!);
      expect(onKeys.mock.calls).toEqual([["\x1b"]]);
      await click(button("Search the conversation")!);
      expect(container.querySelector('input[type="search"]')).not.toBeNull();

      await render("blocked");
      expect(button("Stop")).toBeNull();
      expect(container.querySelector(".agent-chat-activity")).toBeNull();
      expect(container.textContent).toContain("claude is waiting for you");
      const toTerminal = Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          ".agent-chat-prompt button",
        ),
      ).find((each) => each.textContent?.includes("Show the terminal"))!;
      await click(toTerminal);
      await click(button("Show the terminal")!);
      expect(onShowTerminal).toHaveBeenCalledTimes(2);

      await render("idle");
      expect(container.querySelector(".agent-chat-prompt")).toBeNull();
      expect(container.querySelector(".agent-chat-activity")).toBeNull();
    } finally {
      await React.act(async () => root.unmount());
      await browser.happyDOM.close();
    }
  });
}

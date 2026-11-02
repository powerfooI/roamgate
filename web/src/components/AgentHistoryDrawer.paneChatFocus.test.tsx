import { expect, mock, test } from "bun:test";
import * as React from "react";
import type { Pane } from "../types";

if (process.env.ROAMGATE_PANE_CHAT_FOCUS_DOM_TEST !== "1") {
  test("pane chat focus in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_PANE_CHAT_FOCUS_DOM_TEST: "1" },
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
  test("a pane's message box keeps the focus when its transcript appears", async () => {
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
      matchMedia: () => ({ matches: false }),
      HTMLTextAreaElement: browser.HTMLTextAreaElement,
      KeyboardEvent: browser.KeyboardEvent,
      requestAnimationFrame: (callback: FrameRequestCallback) =>
        setTimeout(() => callback(0), 0),
      IS_REACT_ACT_ENVIRONMENT: true,
    }))
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    // A new Claude session: no transcript until its first message.
    let transcript = false;
    const client = {
      isCurrent: () => true,
      call: async (method: string) => {
        if (!method.startsWith("agent_"))
          return Promise.reject(new Error("pane closed"));
        if (!transcript)
          return {
            status: "unavailable",
            stats: {},
            detail: "Could not find the claude session transcript",
          };
        return method === "agent_session.get"
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
            };
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
      agent_status: "idle",
      focused: true,
      revision: 1,
    };
    const settle = () =>
      React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    try {
      await React.act(async () => {
        root.render(
          <AgentHistoryDrawer
            pane={pane}
            open
            embedded
            paneChat={{ onKeys: () => {}, onShowTerminal: () => {} }}
            onOpenChange={() => {}}
          />,
        );
      });
      await settle();
      expect(container.textContent).toContain("No conversation yet");
      const box = container.querySelector("textarea")!;
      expect(box).not.toBeNull();
      box.focus();
      await React.act(async () => {
        Object.getOwnPropertyDescriptor(
          browser.HTMLTextAreaElement.prototype,
          "value",
        )!.set!.call(box, "half a thought");
        box.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
      expect(document.activeElement).toBe(box);

      // The transcript shows up (the first message reached the agent): the
      // conversation takes the waiting notice's place, and the box, with
      // the focus and what was typed, stays the same element.
      transcript = true;
      await React.act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Refresh session"]',
          )!
          .click(),
      );
      await settle();
      expect(container.textContent).toContain("Run the tests");
      expect(container.textContent).not.toContain("No conversation yet");
      expect(container.querySelector("textarea")).toBe(box);
      expect(document.activeElement).toBe(box);
      expect(box.value).toBe("half a thought");

      // And back: a transcript that cannot be read any more (a server
      // restart) does not take the box away either.
      transcript = false;
      await React.act(async () => root.render(null));
      await React.act(async () => {
        root.render(
          <AgentHistoryDrawer
            pane={pane}
            open
            embedded
            paneChat={{ onKeys: () => {}, onShowTerminal: () => {} }}
            onOpenChange={() => {}}
          />,
        );
      });
      const first = container.querySelector("textarea")!;
      first.focus();
      await settle();
      expect(container.textContent).toContain("No conversation yet");
      expect(container.querySelector("textarea")).toBe(first);
      expect(document.activeElement).toBe(first);

      // A message sent before there is a transcript shows at once.
      await React.act(async () => {
        first.dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      await settle();
      expect(container.textContent).toContain("half a thought");
      expect(container.textContent).not.toContain("No conversation yet");
    } finally {
      await React.act(async () => root.unmount());
      await browser.happyDOM.close();
    }
  });
}

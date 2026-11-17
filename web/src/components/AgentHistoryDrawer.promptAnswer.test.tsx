import { expect, mock, test } from "bun:test";
import * as React from "react";
import type { AgentPrompt } from "../agentPrompt";
import type { Pane } from "../types";

if (process.env.ROAMGATE_PROMPT_ANSWER_DOM_TEST !== "1") {
  test("prompt answers in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_PROMPT_ANSWER_DOM_TEST: "1" },
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
  test("a question answered in a pane's chat", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/" });
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      localStorage: browser.localStorage,
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
    const client = {
      isCurrent: () => true,
      call: async (method: string) =>
        !method.startsWith("agent_")
          ? Promise.reject(new Error("pane closed"))
          : method === "agent_session.get"
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
                    text: "Fetch the page",
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
    const { initializeLayoutPreferences, updateLayoutPreferences } =
      await import("../layoutPreferences");
    initializeLayoutPreferences();
    const { parseAgentPrompt } = await import("../agentPrompt");
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
      agent_status: "blocked",
      focused: true,
      revision: 1,
    };
    const onKeys = mock<(text: string) => void>(() => {});
    const render = (prompt: AgentPrompt | null) =>
      React.act(async () => {
        root.render(
          <AgentHistoryDrawer
            pane={{ ...pane, agent_status: prompt ? "blocked" : "working" }}
            open
            embedded
            paneChat={{ prompt, active: true, onKeys, onShowTerminal() {} }}
            onOpenChange={() => {}}
          />,
        );
      });
    const settle = () =>
      React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    const screen = (cursor: number) => [
      "──────────────────────────────────────────────",
      " Bash command",
      "   curl -s https://example.com",
      " Do you want to proceed?",
      `${cursor === 1 ? " ❯" : "  "} 1. Yes`,
      `${cursor === 2 ? " ❯" : "  "} 2. Yes, and don't ask again for: curl *`,
      `${cursor === 3 ? " ❯" : "  "} 3. No, and tell Claude what to do differently (esc)`,
    ];
    const tapYes = async () => {
      const yes = Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          ".agent-chat-prompt-actions button",
        ),
      ).find((each) => each.textContent?.includes("Yes"))!;
      // A tap moves the focus to the choice, which goes with the card.
      yes.focus();
      await React.act(async () => yes.click());
    };
    const box = () => container.querySelector("textarea");
    try {
      // With the cursor on the editable rule, a number goes to its choice
      // with the arrows: typed into the rule, it would change it.
      await render(parseAgentPrompt(screen(2)));
      await settle();
      (document.activeElement as HTMLElement | null)?.blur();
      await React.act(async () => {
        document.body.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "1", bubbles: true }),
        );
      });
      expect(onKeys.mock.calls).toEqual([["\x1b[A\r"]]);
      // Elsewhere, the number itself, as on the terminal.
      await render(parseAgentPrompt(screen(1)));
      (document.activeElement as HTMLElement | null)?.blur();
      await React.act(async () => {
        document.body.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "3", bubbles: true }),
        );
      });
      expect(onKeys.mock.calls).toEqual([["\x1b[A\r"], ["3"]]);

      // On a desktop, the message box gets the keys back once answered.
      await tapYes();
      await render(null);
      await settle();
      expect(box()).not.toBeNull();
      expect(document.activeElement).toBe(box());

      // On a phone, it does not: its keyboard would come up over the chat.
      await React.act(async () => updateLayoutPreferences({ mode: "mobile" }));
      await render(parseAgentPrompt(screen(1)));
      await settle();
      await tapYes();
      await render(null);
      await settle();
      expect(box()).not.toBeNull();
      expect(document.activeElement).not.toBe(box());
    } finally {
      await React.act(async () => root.unmount());
      await browser.happyDOM.close();
    }
  });
}

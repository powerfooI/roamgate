import { expect, mock, spyOn, test } from "bun:test";
import * as React from "react";
import type {
  AssistantMention,
  AssistantMentionTarget,
  AssistantSnapshot,
  AssistantWorkspace,
} from "../../../shared/assistant";
import * as assistant from "../assistant";
import { adjustAssistantMentions } from "../assistantMentions";
import { AssistantMentionComposer } from "./AssistantMentionComposer";
import { AssistantPanel, AssistantUserMessage } from "./AssistantPanel";
import { bridge } from "../api";

const workspace: AssistantWorkspace = {
  connection_id: "local",
  workspace_id: "project",
  runtime_generation: 1,
  connection_label: "Mac",
  label: "Project",
};
const target: AssistantMentionTarget = {
  ...workspace,
  kind: "workspace",
  workspace_label: workspace.label,
};
const agent: AssistantMentionTarget = {
  ...target,
  kind: "agent",
  label: "Codex / Project",
  agent: "codex",
  pane_id: "pane-one",
  terminal_id: "terminal-one",
  agent_identity: "a".repeat(64),
};

if (process.env.ROAMGATE_MENTION_DOM_TEST !== "1") {
  test("Ranger references in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_MENTION_DOM_TEST: "1" },
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
  test("picker preserves native focus and chooses a bound reference without sending, including IME and fallback", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost" });
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
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const catalog = spyOn(assistant, "getAssistantMentions");
    const spies: { mockRestore: () => void }[] = [catalog];
    const submit = mock(() => {});
    const openMention = mock(() => {});
    const composing = mock(() => {});
    let value = "";
    let mentions: AssistantMention[] = [];
    let draftKey = "bridge:chat";
    const inputRef = React.createRef<HTMLTextAreaElement>();
    const render = async () => {
      await React.act(async () => root.render(<Harness />));
    };
    function Harness() {
      return (
        <AssistantMentionComposer
          value={value}
          mentions={mentions}
          workspaces={[workspace]}
          currentWorkspace={workspace}
          draftKey={draftKey}
          inputRef={inputRef}
          mobile={false}
          onChange={(next, refs, inputType, edit) => {
            mentions =
              refs ?? adjustAssistantMentions(value, next, mentions, edit);
            expect(
              inputType === undefined || typeof inputType === "string",
            ).toBe(true);
            value = next;
            root.render(<Harness />);
          }}
          onSubmit={submit}
          onOpenMention={openMention}
          onCompositionChange={composing}
        >
          <div className="assistant-compose-actions" />
        </AssistantMentionComposer>
      );
    }
    const input = () => inputRef.current!;
    const button = (label: string) =>
      container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
    const key = async (name: string, options: KeyboardEventInit = {}) => {
      await React.act(async () =>
        input().dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: name,
            bubbles: true,
            cancelable: true,
            ...options,
          }),
        ),
      );
    };
    const fill = async (text: string) => {
      await React.act(async () => {
        Object.getOwnPropertyDescriptor(
          browser.HTMLTextAreaElement.prototype,
          "value",
        )!.set!.call(input(), text);
        input().setSelectionRange(text.length, text.length);
        input().dispatchEvent(new window.Event("input", { bubbles: true }));
      });
    };
    try {
      let resolve!: (value: {
        targets: AssistantMentionTarget[];
        errors: string[];
      }) => void;
      catalog.mockReturnValueOnce(
        new Promise((done) => {
          resolve = done;
        }),
      );
      await React.act(async () => root.render(<Harness />));
      input().focus();
      await React.act(async () => button("Mention workspace or agent").click());
      expect(document.activeElement).toBe(input());
      expect(input().getAttribute("aria-expanded")).toBe("true");
      expect(
        container.querySelector<HTMLButtonElement>('[role="option"]')!.disabled,
      ).toBe(true);
      await React.act(async () =>
        resolve({ targets: [target, agent], errors: [] }),
      );
      await key("ArrowDown");
      await key("Enter");
      expect(value).toBe("@Codex / Project ");
      expect(mentions).toHaveLength(1);
      expect(mentions[0]?.kind).toBe("agent");
      expect(submit).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(input());
      expect(input().selectionStart).toBe(value.length);
      await key("Enter");
      expect(submit).toHaveBeenCalledTimes(1);
      await React.act(async () =>
        container
          .querySelector<HTMLButtonElement>(".assistant-mention-chip button")!
          .click(),
      );
      expect(openMention).toHaveBeenCalledWith(mentions[0]);
      await React.act(async () => {
        input().setSelectionRange(mentions[0]!.start, mentions[0]!.end);
        input().dispatchEvent(
          new window.InputEvent("beforeinput", {
            bubbles: true,
            inputType: "insertFromPaste",
          }),
        );
        input().dispatchEvent(
          new window.InputEvent("input", {
            bubbles: true,
            inputType: "insertFromPaste",
          }),
        );
      });
      expect(mentions).toEqual([]);
      expect(value).toBe("@Codex / Project ");
      catalog.mockResolvedValue({ targets: [target, agent], errors: [] });
      await React.act(async () => {
        input().setSelectionRange(0, value.length);
        button("Mention workspace or agent").click();
      });
      await key("ArrowDown");
      await key("Tab");
      expect(mentions).toHaveLength(1);
      await React.act(async () =>
        button("Remove reference to Codex / Project").click(),
      );
      expect(mentions).toEqual([]);
      expect(value).toBe("@Codex / Project ");

      catalog.mockResolvedValue({ targets: [target, agent], errors: [] });
      await fill("user@example.com");
      expect(input().getAttribute("aria-expanded")).toBe("false");
      await fill("\u770b\u770b@Pro");
      expect(input().getAttribute("aria-expanded")).toBe("true");
      await key("Enter", { shiftKey: true });
      expect(submit).toHaveBeenCalledTimes(1);
      await React.act(async () =>
        input().dispatchEvent(
          new window.CompositionEvent("compositionstart", { bubbles: true }),
        ),
      );
      await key("Enter");
      expect(submit).toHaveBeenCalledTimes(1);
      expect(composing).toHaveBeenLastCalledWith(true);
      await React.act(async () =>
        input().dispatchEvent(
          new window.CompositionEvent("compositionend", { bubbles: true }),
        ),
      );
      expect(composing).toHaveBeenLastCalledWith(false);
      await key("Escape");
      expect(input().getAttribute("aria-expanded")).toBe("false");

      catalog.mockRejectedValueOnce(
        new Error("Method unavailable; update the bridge."),
      );
      await fill("@");
      expect(container.textContent).toContain("update the bridge");
      await key("Enter");
      expect(submit).toHaveBeenCalledTimes(1);
      await key("Escape");
      await key("Enter");
      expect(submit).toHaveBeenCalledTimes(2);
      expect(mentions).toEqual([]);
      draftKey = "bridge:other-chat";
      value = "Another draft";
      await render();
      expect(input().value).toBe("Another draft");
      expect(input().getAttribute("aria-expanded")).toBe("false");

      const unsafe = { ...target, label: "<script>unsafe</script>" };
      const text = `Explain @${unsafe.label} please`;
      await React.act(async () =>
        root.render(
          <AssistantUserMessage
            message={{
              id: "message",
              role: "user",
              text,
              sent_at: "2026-10-08T00:00:00Z",
              tools: [],
              sources: [],
              mentions: [{ ...unsafe, start: 8, end: 9 + unsafe.label.length }],
            }}
            onOpenMention={openMention}
          />,
        ),
      );
      expect(container.textContent).toBe(text);
      expect(container.querySelector("script")).toBeNull();

      const snapshot: AssistantSnapshot = {
        instance_id: "bridge",
        revision: 1,
        config: {
          provider: "provider",
          model: "model",
          credential_source: "assistant",
          allowed_workspaces: [workspace],
        },
        providers: [
          { id: "provider", label: "Provider", configured: true, methods: [] },
        ],
        models: [{ id: "model", provider: "provider", label: "Model" }],
        running: false,
        error: null,
        auth: null,
        messages: [
          {
            id: "message",
            role: "user",
            text: `@${agent.label}`,
            sent_at: "2026-10-08T00:00:00Z",
            tools: [],
            sources: [],
            mentions: [{ ...agent, start: 0, end: agent.label.length + 1 }],
          },
        ],
      };
      const state: ReturnType<typeof assistant.useAssistantState> = {
        snapshot,
        draft: "",
        draftMentions: [],
        loading: false,
        supported: true,
        connectionStatus: "connected",
        error: null,
      };
      spies.push(spyOn(assistant, "useAssistantState").mockReturnValue(state));
      spies.push(
        spyOn(bridge, "call").mockResolvedValue({
          workspaces: [workspace],
          errors: [],
        }),
      );
      const opened = mock(() => {});
      await React.act(async () =>
        root.render(
          <AssistantPanel
            open
            floating
            mobile={false}
            onClose={() => {}}
            onToggleFloating={() => {}}
            onOpenSource={opened}
          />,
        ),
      );
      catalog.mockResolvedValue({
        targets: [{ ...agent, agent_identity: "b".repeat(64) }],
        errors: [],
      });
      await React.act(async () =>
        container
          .querySelector<HTMLButtonElement>(".assistant-message-mention")!
          .click(),
      );
      expect(opened).not.toHaveBeenCalled();
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "reference is no longer available",
      );
      catalog.mockResolvedValue({ targets: [agent], errors: [] });
      await React.act(async () =>
        container
          .querySelector<HTMLButtonElement>(".assistant-message-mention")!
          .click(),
      );
      expect(opened).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "history",
          connection_id: "local",
          workspace_id: "project",
          runtime_generation: 1,
          pane_id: "pane-one",
        }),
      );
    } finally {
      await React.act(async () => root.unmount());
      for (const spy of spies.reverse()) spy.mockRestore();
      await browser.happyDOM.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
}

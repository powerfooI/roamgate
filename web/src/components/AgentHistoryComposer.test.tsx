import { expect, mock, test } from "bun:test";
import * as React from "react";
import {
  readTerminalComposerDraft,
  terminalComposerDraftKey,
  writeTerminalComposerDraft,
} from "../terminalComposer";
import { AgentHistoryComposer } from "./AgentHistoryComposer";

if (process.env.ROAMGATE_HISTORY_COMPOSER_DOM_TEST !== "1") {
  test("history composer in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_HISTORY_COMPOSER_DOM_TEST: "1" },
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
  test("sends the shared draft and confirms before typing into a busy agent", async () => {
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
    const draftKey = terminalComposerDraftKey("local", 1, "pane-one");
    let fail = false;
    const send = mock<(text: string) => Promise<void>>(async () => {
      if (fail) throw new Error("pane closed");
    });
    const error = mock<(message: string) => void>(() => {});
    let stateSeq = 0;
    const render = (status: string, sameState = false) =>
      React.act(async () =>
        root.render(
          <AgentHistoryComposer
            draftKey={draftKey}
            agent="codex"
            status={status}
            stateSeq={sameState ? stateSeq : ++stateSeq}
            onSend={send}
            onError={error}
          />,
        ),
      );
    const input = () => container.querySelector("textarea")!;
    const warning = () => container.querySelector('[role="alert"]');
    const key = (name: string, options: KeyboardEventInit = {}) =>
      React.act(async () =>
        input().dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: name,
            bubbles: true,
            cancelable: true,
            ...options,
          }),
        ),
      );
    const fill = (text: string) =>
      React.act(async () => {
        Object.getOwnPropertyDescriptor(
          browser.HTMLTextAreaElement.prototype,
          "value",
        )!.set!.call(input(), text);
        input().dispatchEvent(new window.Event("input", { bubbles: true }));
      });
    let coarsePointer = false;
    const matchMedia = (query: string) => ({
      matches: query === "(pointer: coarse)" && coarsePointer,
    });
    originals.set(
      "matchMedia",
      Object.getOwnPropertyDescriptor(globalThis, "matchMedia"),
    );
    Object.defineProperty(globalThis, "matchMedia", {
      value: matchMedia,
      configurable: true,
      writable: true,
    });
    const sendAnyway = () =>
      React.act(async () =>
        Array.from(container.querySelectorAll("button"))
          .find((button) => button.textContent === "Send anyway")!
          .click(),
      );
    try {
      // A draft started in the terminal composer appears here.
      writeTerminalComposerDraft(draftKey, "from terminal");
      await render("idle");
      expect(input().value).toBe("from terminal");

      // Shift+Enter keeps editing; Enter sends to an idle agent at once.
      await fill("hello");
      await key("Enter", { shiftKey: true });
      expect(send).not.toHaveBeenCalled();
      await key("Enter");
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[0]).toBe("hello");
      expect(readTerminalComposerDraft(draftKey)).toBe("");
      expect(input().value).toBe("");

      // Codex reports "unknown" while it sits at its prompt.
      await render("unknown");
      await fill("status?");
      await key("Enter");
      expect(warning()).toBeNull();
      expect(send).toHaveBeenCalledTimes(2);

      // A working agent needs Send anyway: Enter again only keeps the warning.
      await render("working");
      await fill("next step");
      await key("Enter");
      expect(warning()?.textContent).toContain("codex is still working.");
      await key("Enter");
      await key("Enter");
      expect(send).toHaveBeenCalledTimes(2);
      expect(warning()).not.toBeNull();

      // Editing or Escape dismisses it.
      await fill("next steps");
      expect(warning()).toBeNull();
      await key("Enter");
      await key("Escape");
      expect(warning()).toBeNull();

      // A dismissed warning stays dismissed when the text is restored.
      await key("Enter");
      expect(warning()).not.toBeNull();
      await fill("next steps!");
      await fill("next steps");
      expect(warning()).toBeNull();

      // So does one for a state the agent left and returned to, even when no
      // render saw the state in between.
      await key("Enter");
      expect(warning()).not.toBeNull();
      stateSeq += 1;
      await render("working");
      expect(warning()).toBeNull();
      await render("working", true);
      expect(warning()).toBeNull();
      expect(send).toHaveBeenCalledTimes(2);

      // A state change drops a warning given for the previous state.
      await key("Enter");
      await render("blocked");
      expect(warning()).toBeNull();
      await key("Enter");
      expect(warning()?.textContent).toContain("waiting on a prompt");
      await sendAnyway();
      expect(send).toHaveBeenCalledTimes(3);
      expect(send.mock.calls[2]?.[0]).toBe("next steps");
      expect(warning()).toBeNull();

      // The warning disappears once the agent is back at its prompt.
      await fill("approve");
      await key("Enter");
      expect(warning()).not.toBeNull();
      await render("idle");
      expect(warning()).toBeNull();

      // Touch keyboards cannot type Shift+Enter, so Enter adds a line there.
      coarsePointer = true;
      await render("done");
      expect(input().getAttribute("enterkeyhint")).toBe("enter");
      await key("Enter");
      expect(send).toHaveBeenCalledTimes(3);
      coarsePointer = false;
      await render("idle");

      // A failed send restores the draft and reports the error.
      fail = true;
      await key("Enter");
      expect(send).toHaveBeenCalledTimes(4);
      expect(readTerminalComposerDraft(draftKey)).toBe("approve");
      expect(input().value).toBe("approve");
      expect(error.mock.calls[0]?.[0]).toBe("pane closed");

      // A touch submits on release, before the keyboard can move the button,
      // and its later compatibility click is not a second send.
      fail = false;
      let clock = 1000;
      const touch = (target: HTMLButtonElement, type: string) => {
        clock += 10;
        const event = new browser.PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerType: "touch",
          pointerId: 1,
          isPrimary: true,
          clientX: 20,
          clientY: 20,
        });
        Object.defineProperty(event, "timeStamp", { value: clock });
        target.dispatchEvent(event as unknown as Event);
      };
      const button = (label: string) =>
        Array.from(container.querySelectorAll("button")).find((target) =>
          target.textContent?.includes(label),
        )!;
      // Touch down and release only; WebKit may never deliver the click.
      const release = (label: string) =>
        React.act(async () => {
          const target = button(label);
          target.getBoundingClientRect = () =>
            ({ left: 0, right: 100, top: 0, bottom: 40 }) as DOMRect;
          touch(target, "pointerdown");
          touch(target, "pointerup");
          await Promise.resolve();
        });
      const compatibilityClick = (label: string) =>
        React.act(async () => {
          button(label).dispatchEvent(
            new browser.PointerEvent("click", {
              bubbles: true,
              cancelable: true,
              pointerType: "touch",
              pointerId: 1,
              detail: 1,
            }) as unknown as Event,
          );
        });
      await fill("tapped");
      await release("Send");
      expect(send).toHaveBeenCalledTimes(5);
      expect(send.mock.calls[4]?.[0]).toBe("tapped");
      await compatibilityClick("Send");
      expect(send).toHaveBeenCalledTimes(5);

      await render("working");
      await fill("tapped anyway");
      await release("Send");
      expect(warning()).not.toBeNull();
      // Older WebKit's compatibility click has no pointer identity. Layout can
      // retarget it to the confirmation the release revealed; it must not
      // confirm the send.
      await React.act(async () => {
        button("Send anyway").dispatchEvent(
          new browser.MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            detail: 1,
            clientX: 20,
            clientY: 20,
          }) as unknown as Event,
        );
      });
      expect(send).toHaveBeenCalledTimes(5);
      expect(warning()).not.toBeNull();
      await release("Send anyway");
      expect(send).toHaveBeenCalledTimes(6);
      expect(send.mock.calls[5]?.[0]).toBe("tapped anyway");
      await compatibilityClick("Send");
      expect(send).toHaveBeenCalledTimes(6);
    } finally {
      await React.act(async () => root.unmount());
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    }
  });
}

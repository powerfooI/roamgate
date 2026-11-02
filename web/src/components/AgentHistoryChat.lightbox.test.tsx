import { expect, test } from "bun:test";
import * as React from "react";

if (process.env.ROAMGATE_CHAT_LIGHTBOX_DOM_TEST !== "1") {
  test("chat image lightbox in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_CHAT_LIGHTBOX_DOM_TEST: "1" },
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
  test("closing an image from the chat gives the focus back to the message box", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/" });
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      HTMLDialogElement: browser.HTMLDialogElement,
      Element: browser.Element,
      Node: browser.Node,
      DOMParser: browser.DOMParser,
      ResizeObserver: browser.ResizeObserver,
      Event: browser.Event,
      MouseEvent: browser.MouseEvent,
      KeyboardEvent: browser.KeyboardEvent,
      matchMedia: () => ({ matches: false }),
      requestAnimationFrame: (callback: FrameRequestCallback) =>
        setTimeout(() => callback(0), 0),
      cancelAnimationFrame: (id: number) => clearTimeout(id),
      IS_REACT_ACT_ENVIRONMENT: true,
    }))
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    const { AgentHistoryChat } = await import("./AgentHistoryChat");
    const { groupHistoryChatItems } = await import("./agentHistoryView");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    const box = document.createElement("textarea");
    document.body.append(container, box);
    const root = createRoot(container);
    await React.act(async () =>
      root.render(
        <AgentHistoryChat
          items={groupHistoryChatItems([
            {
              id: "1",
              role: "user",
              kind: "message",
              text: "[Image #1] what is wrong here?",
              sent_at: "2026-01-01T00:00:00Z",
              images: [{ media_type: "image/png", bytes: 9, hash: "h1" }],
            },
          ])}
          listRef={React.createRef<HTMLDivElement>()}
          contentRef={React.createRef<HTMLDivElement>()}
          onOpen={() => {}}
          attachedImages={new Map([["1", ["blob:http://localhost/one"]]])}
        />,
      ),
    );
    box.focus();
    const link = container.querySelector<HTMLElement>(
      "a.agent-history-chat-image",
    )!;
    // A browser moves the focus to a link pressed with the mouse; not here.
    const press = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    link.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    await React.act(async () => link.click());
    const dialog = document.querySelector("dialog.image-lightbox")!;
    expect(dialog).not.toBeNull();
    expect(document.activeElement).not.toBe(box);
    await React.act(async () => {
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(document.querySelector("dialog.image-lightbox")).toBeNull();
    expect(document.activeElement).toBe(box);
    await React.act(async () => root.unmount());
  });
}

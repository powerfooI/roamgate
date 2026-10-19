import { expect, test } from "bun:test";
import * as React from "react";
import { AssistantThinking } from "./AssistantThinking";

if (process.env.ROAMGATE_THINKING_DOM_TEST !== "1") {
  test("Ranger reasoning in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_THINKING_DOM_TEST: "1" },
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
  test("reasoning stays open while thinking and collapses once the answer starts", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost" });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
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
    const render = (
      message: React.ComponentProps<typeof AssistantThinking>["message"],
      active: boolean,
    ) =>
      React.act(async () =>
        root.render(<AssistantThinking message={message} active={active} />),
      );
    const details = () => container.querySelector("details")!;
    const summary = () => details().querySelector("summary")!.textContent;
    const labels = () =>
      Array.from(
        details().querySelectorAll("strong"),
        (label) => label.textContent,
      );
    try {
      await render({ thinking: ["Check status"] }, true);
      expect(details().open).toBe(true);
      expect(summary()).toBe("Thinking...");
      // A single step needs no step label.
      expect(labels()).toEqual([]);
      await render({ thinking: ["Check status", "Answer now."] }, true);
      expect(summary()).toBe("Thinking... (2 steps)");
      expect(labels()).toEqual(["Step 1", "Step 2"]);
      expect(details().querySelector(".assistant-thinking-note")).toBeNull();
      await render({ thinking: ["Check status", "Answer now."] }, false);
      expect(details().open).toBe(false);
      expect(summary()).toBe("Thinking (2 steps)");
      details().open = true;
      await render(
        {
          thinking: ["tail of step 3", "Step four"],
          thinking_skipped: 2,
          thinking_truncated: true,
        },
        false,
      );
      expect(details().open).toBe(true);
      expect(summary()).toBe("Thinking (4 steps)");
      expect(labels()).toEqual(["Step 3", "Step 4"]);
      expect(
        details().querySelector(".assistant-thinking-note")!.textContent,
      ).toBe("Earlier reasoning truncated");
    } finally {
      await React.act(async () => root.unmount());
      for (const [key, descriptor] of originals)
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      await browser.happyDOM.close();
    }
  });
}

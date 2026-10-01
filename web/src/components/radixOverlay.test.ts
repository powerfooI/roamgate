import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

if (process.env.ROAMGATE_RADIX_DOM_TEST !== "1") {
  test("Radix overlay regressions in an isolated runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_RADIX_DOM_TEST: "1" },
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
  await registerDomTests();
}

async function registerDomTests() {
  const browser = new Window({ url: "http://localhost" });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLInputElement",
    "Element",
    "Node",
    "NodeFilter",
    "Event",
    "CustomEvent",
    "MutationObserver",
    "ResizeObserver",
    "KeyboardEvent",
    "MouseEvent",
    "PointerEvent",
  ] as const) {
    Object.defineProperty(globalThis, key, {
      value: key === "window" ? browser : browser[key],
      writable: true,
      configurable: true,
    });
  }
  Object.assign(globalThis, {
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { act, createElement: h } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { Popover, PopoverTrigger, PopoverContent } = await import(
    "./ui/popover"
  );
  const { Command, CommandInput, CommandList, CommandItem } = await import(
    "./ui/command"
  );
  let root: Root | null = null;
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    document.body.replaceChildren();
    await browser.happyDOM.whenAsyncComplete();
  });
  afterAll(async () => browser.happyDOM.close());

  test("reopens the command popover, dismisses with Escape and restores focus", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        h(
          Popover,
          null,
          h(PopoverTrigger, null, "Commands"),
          h(
            PopoverContent,
            null,
            h(
              Command,
              null,
              h(CommandInput, { "aria-label": "Find command" }),
              h(
                CommandList,
                null,
                h(CommandItem, { value: "open" }, "Open workspace"),
              ),
            ),
          ),
        ),
      ),
    );
    const outside = document.createElement("button");
    outside.textContent = "Outside";
    document.body.append(outside);
    const trigger = container.querySelector("button")!;
    for (let i = 0; i < 2; i++) {
      trigger.focus();
      await act(async () => trigger.click());
      const input = document.querySelector<HTMLInputElement>("[cmdk-input]")!;
      expect(input).not.toBeNull();
      expect(document.activeElement === input).toBe(true);
      await act(async () =>
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      await act(
        async () => await new Promise((resolve) => setTimeout(resolve, 0)),
      );
      expect(document.querySelector("[cmdk-input]") === null).toBe(true);
      expect(document.activeElement === trigger).toBe(true);
    }
    await act(async () => trigger.click());
    expect(document.querySelector("[cmdk-input]") !== null).toBe(true);
    // DismissableLayer installs its outside pointer listener on the next task.
    await act(
      async () => await new Promise((resolve) => setTimeout(resolve, 0)),
    );
    await act(async () => {
      outside.dispatchEvent(
        new PointerEvent("pointerdown", {
          pointerType: "mouse",
          bubbles: true,
          cancelable: true,
        }),
      );
      outside.focus();
      outside.click();
    });
    await act(
      async () => await new Promise((resolve) => setTimeout(resolve, 0)),
    );
    expect(document.querySelector("[cmdk-input]") === null).toBe(true);
    expect(document.activeElement === outside).toBe(true);
  });
}

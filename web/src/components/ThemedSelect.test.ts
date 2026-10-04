import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";

if (process.env.ROAMGATE_THEMED_SELECT_DOM_TEST !== "1") {
  test("ThemedSelect disabled transitions in an isolated runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_THEMED_SELECT_DOM_TEST: "1" },
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
  await registerDomTest();
}

async function registerDomTest() {
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
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ThemedSelect } = await import("./ThemedSelect");
  afterAll(async () => browser.happyDOM.close());

  test("disabling closes an open dropdown and re-enabling requires a new click", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const changes: string[] = [];
    const render = async (disabled?: boolean) => {
      await act(async () =>
        root.render(
          createElement(ThemedSelect, {
            value: "first",
            options: [
              { value: "first", label: "First" },
              { value: "second", label: "Second" },
            ],
            "aria-label": "Choose a model",
            onChange: (value) => changes.push(value),
            disabled,
          }),
        ),
      );
    };
    try {
      await render();
      const trigger = container.querySelector("button")!;
      expect(trigger.disabled).toBe(false);
      await act(async () => trigger.click());
      expect(document.querySelector(".themed-select-content")).not.toBeNull();
      await render(true);
      expect(trigger.disabled).toBe(true);
      expect(document.querySelector(".themed-select-content")).toBeNull();
      await act(async () => trigger.click());
      expect(document.querySelector(".themed-select-content")).toBeNull();
      expect(changes).toEqual([]);
      await render(false);
      expect(document.querySelector(".themed-select-content")).toBeNull();
      await act(async () => trigger.click());
      const option = document.querySelector<HTMLElement>(
        '[cmdk-item][data-value="second"]',
      )!;
      expect(option).not.toBeNull();
      await act(async () => option.click());
      expect(changes).toEqual(["second"]);
      expect(document.querySelector(".themed-select-content")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      await browser.happyDOM.whenAsyncComplete();
    }
  });
}

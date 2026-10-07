import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

if (process.env.ROAMGATE_THEMED_SELECT_DOM_TEST !== "1") {
  test("ThemedSelect interactions in an isolated runtime", async () => {
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
      expect(document.querySelector(".themed-select-content") !== null).toBe(
        true,
      );
      await render(true);
      expect(trigger.disabled).toBe(true);
      expect(document.querySelector(".themed-select-content") === null).toBe(
        true,
      );
      await act(async () => trigger.click());
      expect(document.querySelector(".themed-select-content") === null).toBe(
        true,
      );
      expect(changes).toEqual([]);
      await render(false);
      expect(document.querySelector(".themed-select-content") === null).toBe(
        true,
      );
      await act(async () => trigger.click());
      const option = document.querySelector<HTMLElement>(
        '[cmdk-item][data-value="second"]',
      )!;
      expect(option).not.toBeNull();
      await act(async () => option.click());
      expect(changes).toEqual(["second"]);
      expect(document.querySelector(".themed-select-content") === null).toBe(
        true,
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
      await browser.happyDOM.whenAsyncComplete();
    }
  });

  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    expect(document.querySelector(".themed-select-content") === null).toBe(
      true,
    );
  });
  const click = async (element: HTMLElement) => {
    await act(async () => element.click());
    await act(async () => browser.happyDOM.whenAsyncComplete());
  };
  const key = async (value: string) => {
    const target = document.activeElement;
    if (!target) throw new Error("No focused keyboard target");
    await act(async () => {
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: value,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await act(async () => browser.happyDOM.whenAsyncComplete());
  };
  async function mount(searchable = false) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const changes: string[] = [];
    let selectedCloses = 0;
    await act(async () =>
      root.render(
        createElement(
          "div",
          null,
          createElement("button", { "aria-label": "Outside" }, "Outside"),
          createElement(ThemedSelect, {
            value: "second",
            options: [
              {
                value: "first",
                label: "First",
                detail: "Alpha",
                keywords: ["fast"],
              },
              {
                value: "second",
                label: "Second",
                detail: "Beta",
                keywords: ["balanced"],
              },
              {
                value: "third",
                label: "Third",
                detail: "Gamma",
                keywords: ["reasoner"],
              },
            ],
            "aria-label": "Choose a model",
            searchPlaceholder: searchable ? "Search models" : undefined,
            onChange: (value) => changes.push(value),
            onSelectedClose: () => {
              selectedCloses += 1;
            },
          }),
        ),
      ),
    );
    cleanups.push(async () => {
      await act(async () => root.unmount());
      container.remove();
      await browser.happyDOM.whenAsyncComplete();
    });
    return {
      changes,
      trigger: container.querySelector<HTMLButtonElement>(
        'button[aria-label="Choose a model"]',
      )!,
      outside: container.querySelector<HTMLButtonElement>(
        'button[aria-label="Outside"]',
      )!,
      selectedCloses: () => selectedCloses,
    };
  }

  test("non-searchable keyboard navigation starts at the current selection and accepts Enter", async () => {
    const fixture = await mount();
    await click(fixture.trigger);
    expect(document.activeElement?.hasAttribute("cmdk-list")).toBe(true);
    expect(
      document
        .querySelector('[cmdk-item][data-selected="true"]')
        ?.getAttribute("data-value"),
    ).toBe("second");
    await key("ArrowDown");
    expect(
      document
        .querySelector('[cmdk-item][data-selected="true"]')
        ?.getAttribute("data-value"),
    ).toBe("third");
    await key("Home");
    expect(
      document
        .querySelector('[cmdk-item][data-selected="true"]')
        ?.getAttribute("data-value"),
    ).toBe("first");
    await key("End");
    await key("Enter");
    expect(fixture.changes).toEqual(["third"]);
    expect(fixture.selectedCloses()).toBe(1);
    expect(document.querySelector(".themed-select-content") === null).toBe(
      true,
    );
  });

  test("search filters keywords and Enter selects the visible result", async () => {
    const fixture = await mount(true);
    await click(fixture.trigger);
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Search models"]',
    )!;
    expect(document.activeElement === input).toBe(true);
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "reasoner");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.querySelectorAll("[cmdk-item]")).toHaveLength(1);
    expect(document.querySelector("[cmdk-item]")?.textContent).toContain(
      "Gamma",
    );
    await key("Enter");
    expect(fixture.changes).toEqual(["third"]);
    expect(fixture.selectedCloses()).toBe(1);
    expect(document.querySelector(".themed-select-content") === null).toBe(
      true,
    );
  });

  test("Escape closes without selection, restores trigger focus and resets the search on reopening", async () => {
    const fixture = await mount(true);
    await click(fixture.trigger);
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Search models"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "no such model");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.querySelector("[cmdk-empty]")?.textContent).toBe(
      "No models found",
    );
    await key("Escape");
    expect(document.querySelector(".themed-select-content") === null).toBe(
      true,
    );
    expect(document.activeElement === fixture.trigger).toBe(true);
    expect(fixture.changes).toEqual([]);
    expect(fixture.selectedCloses()).toBe(0);
    await click(fixture.trigger);
    expect(
      document.querySelector<HTMLInputElement>(
        'input[aria-label="Search models"]',
      )?.value,
    ).toBe("");
    expect(document.querySelectorAll("[cmdk-item]")).toHaveLength(3);
  });

  test("outside pointer and browser navigation dismiss without selection or a stale close callback", async () => {
    const fixture = await mount(true);
    await click(fixture.trigger);
    await act(async () => {
      fixture.outside.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerType: "mouse",
          button: 0,
        }),
      );
      fixture.outside.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          pointerType: "mouse",
          button: 0,
        }),
      );
      fixture.outside.click();
    });
    await act(async () => browser.happyDOM.whenAsyncComplete());
    expect(document.querySelector(".themed-select-content") === null).toBe(
      true,
    );
    expect(fixture.selectedCloses()).toBe(0);
    await click(fixture.trigger);
    await act(async () => window.dispatchEvent(new Event("popstate")));
    // Radix restores focus asynchronously when the old popover unmounts.
    // Let that navigation finish before simulating the next user action.
    await act(async () => browser.happyDOM.whenAsyncComplete());
    expect(document.querySelector(".themed-select-content") === null).toBe(
      true,
    );
    expect(fixture.changes).toEqual([]);
    expect(fixture.selectedCloses()).toBe(0);
    await click(fixture.trigger);
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Search models",
    );
    expect(
      document
        .querySelector('[cmdk-item][data-selected="true"]')
        ?.getAttribute("data-value"),
    ).toBe("second");
    await key("Enter");
    expect(fixture.changes).toEqual(["second"]);
    expect(fixture.selectedCloses()).toBe(1);
    await click(fixture.trigger);
    await key("Escape");
    expect(fixture.selectedCloses()).toBe(1);
  });
}

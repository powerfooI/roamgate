import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";
import type { MobileControlsPlacement } from "../mobileControlsPlacement";

// Real commits exercise the applied/stored offset feedback and native events.
// Layout geometry is explicit: happy-dom cannot validate browser CSS layout.
if (process.env.ROAMGATE_CAPSULE_KEYBOARD_DOM_TEST !== "1") {
  test("mobile capsule keyboard regressions in an isolated runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_CAPSULE_KEYBOARD_DOM_TEST: "1" },
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
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const resizeObservers = new Set<TestResizeObserver>();
  class TestResizeObserver {
    observed = new Set<Element>();
    constructor(readonly callback: () => void) {
      resizeObservers.add(this);
    }
    observe(element: Element) {
      this.observed.add(element);
    }
    unobserve(element: Element) {
      this.observed.delete(element);
    }
    disconnect() {
      this.observed.clear();
      resizeObservers.delete(this);
    }
  }
  const viewport = Object.assign(new browser.EventTarget(), {
    height: 844,
    offsetTop: 0,
  });
  Object.defineProperty(browser, "visualViewport", { value: viewport });
  Object.defineProperty(browser, "innerHeight", { value: 844 });
  Object.defineProperty(browser, "innerWidth", { value: 390 });
  let scale = 1;
  let composerHeight = 150;
  let pickerHeight = 0;
  let composerHidden = false;
  let composerOpen = false;
  let assistant = false;
  let root: Root | null = null;
  let container: HTMLDivElement;
  let placement: MobileControlsPlacement;
  let saves: MobileControlsPlacement[];
  const app = () => container.querySelector<HTMLElement>(".app")!;
  const compact = () => app().hasAttribute("data-mobile-controls-compact");
  const offset = () =>
    Number.parseFloat(
      app().style.getPropertyValue("--mobile-controls-offset-y"),
    ) || 0;
  const appBottom = () => 844 + viewport.offsetTop;
  const normalBottom = (element: Element) =>
    (element.classList.contains("mobile-terminal-controls")
      ? 106
      : element.classList.contains("mobile-workspace-tools")
        ? 156
        : 58) +
    112 +
    20 +
    offset();
  const dockHeight = () =>
    compact()
      ? Math.min(
          composerHeight,
          Number.parseFloat(
            app().style.getPropertyValue(
              "--mobile-controls-composer-max-height",
            ),
          ) || composerHeight,
        )
      : composerHeight;
  const dockTop = () =>
    viewport.offsetTop + viewport.height - dockHeight() * scale;
  const rect = (top: number, height: number, width = 390) =>
    ({
      x: 0,
      y: top,
      top,
      bottom: top + height,
      left: 0,
      right: width,
      width,
      height,
      toJSON: () => ({}),
    }) as DOMRect;
  const geometry = (element: Element): DOMRect => {
    if (element.classList.contains("app")) return rect(viewport.offsetTop, 844);
    if (element.classList.contains("topbar"))
      return rect(viewport.offsetTop, 60 * scale);
    if (element.classList.contains("terminal-mobile-keys-toggle"))
      return rect(viewport.offsetTop + 60 * scale, 40 * scale);
    if (element.classList.contains("terminal-composer"))
      return rect(dockTop(), dockHeight() * scale);
    if (element.classList.contains("terminal-composer-commands")) {
      const scrollTop = element.parentElement?.scrollTop ?? 0;
      return rect(
        compact()
          ? dockTop() - scrollTop * scale
          : dockTop() - (pickerHeight + 6) * scale,
        pickerHeight * scale,
      );
    }
    if (element.classList.contains("mobile-controls-stack") && compact()) {
      const bottom =
        appBottom() -
        Number.parseFloat(
          app().style.getPropertyValue("--mobile-controls-compact-bottom"),
        ) *
          scale;
      return rect(bottom - 42 * scale, 42 * scale);
    }
    if (element.matches(".mobile-nav, .mobile-terminal-controls")) {
      if (compact())
        return geometry(element.closest(".mobile-controls-stack")!);
      const bottom = appBottom() - normalBottom(element) * scale;
      return rect(bottom - 42 * scale, 42 * scale);
    }
    return rect(0, 0);
  };
  Object.defineProperties(browser.HTMLElement.prototype, {
    offsetWidth: {
      configurable: true,
      get() {
        return 390 / scale;
      },
    },
    offsetHeight: {
      configurable: true,
      get() {
        if (
          this.tagName === "DIV" &&
          this.getAttribute("aria-hidden") === "true" &&
          !this.className
        )
          return 20;
        return geometry(this).height / scale;
      },
    },
    getBoundingClientRect: {
      configurable: true,
      value() {
        return geometry(this);
      },
    },
    setPointerCapture: { configurable: true, value() {} },
  });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    Event: browser.Event,
    MutationObserver: browser.MutationObserver,
    ResizeObserver: TestResizeObserver,
    localStorage: browser.localStorage,
    sessionStorage: browser.sessionStorage,
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    matchMedia: () => ({ matches: true }),
    getComputedStyle: (element: HTMLElement) => ({
      display:
        assistant && element.matches(".mobile-nav, .mobile-terminal-controls")
          ? "none"
          : "block",
      visibility:
        composerHidden && element.closest(".terminal-composer")
          ? "hidden"
          : "visible",
      bottom: `${normalBottom(element)}px`,
    }),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  const { act, createElement: h, useRef, useState } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useMobileControlsDrag } = await import("./useMobileControlsDrag");
  const { TerminalComposer } = await import("./TerminalComposer");
  const drafts = await import("../terminalComposer");
  let draftKey = "";
  function Harness() {
    const appRef = useRef<HTMLDivElement>(null);
    const toggleRef = useRef<HTMLButtonElement>(null);
    const [saved, setSaved] = useState(placement);
    const [collapsed, setCollapsed] = useState(false);
    const applied = useMobileControlsDrag({
      enabled: true,
      appRef,
      toggleRef,
      placement: saved,
      onPlacementChange: (next) => {
        placement = next;
        saves.push(next);
        setSaved(next);
      },
    });
    return h(
      "div",
      {
        ref: appRef,
        className: `app ${collapsed ? "mobile-controls-collapsed" : ""} ${saved.side === "left" ? "mobile-controls-left" : ""} ${assistant ? "assistant-view" : ""}`,
        style: { "--mobile-controls-offset-y": `${applied}px` },
      },
      h("header", { className: "topbar" }),
      h("button", { className: "terminal-mobile-keys-toggle" }),
      h(
        "div",
        { className: "mobile-controls-stack" },
        h(
          "nav",
          { className: "mobile-nav", "aria-hidden": collapsed },
          h("button", null, "Commits"),
        ),
        h(
          "nav",
          {
            className: "mobile-nav mobile-workspace-tools",
            "aria-hidden": collapsed,
          },
          h("button", null, "Tabs"),
        ),
        h(
          "div",
          { className: "mobile-terminal-controls" },
          h("nav", {
            className: "mobile-nav mobile-terminal-tools",
            "aria-hidden": collapsed,
          }),
          h(
            "button",
            {
              ref: toggleRef,
              className: "mobile-controls-toggle",
              "aria-pressed": collapsed,
              onClick: () => setCollapsed(!collapsed),
            },
            "Toggle",
          ),
        ),
      ),
      composerOpen
        ? h(TerminalComposer, {
            draftKey,
            mode: "composer",
            onModeChange() {},
            onFocusDirect() {},
            directDisabled: false,
            agent: "claude",
            shortcutRows: [],
            onRunShortcut() {},
            onClose() {},
            async onSubmit() {},
            async onUploadImage() {
              return "";
            },
            async onUploadFile() {
              return "";
            },
            onError() {},
          })
        : null,
    );
  }
  async function render() {
    await act(async () => root!.render(h(Harness)));
    await browser.happyDOM.whenAsyncComplete();
  }
  async function mount(side: "left" | "right" = "right", savedOffset = 0) {
    document.documentElement.dataset.layout = "mobile";
    document.documentElement.classList.add("keyboard-open");
    viewport.height = 844;
    viewport.offsetTop = 0;
    composerHeight = 150;
    pickerHeight = 0;
    composerHidden = false;
    composerOpen = false;
    assistant = false;
    placement = { side, offsetY: savedOffset };
    saves = [];
    drafts.activateTerminalComposerDraftScope("capsule-test", 1);
    draftKey = drafts.terminalComposerDraftKey("capsule-test", 1, "pane");
    drafts.writeTerminalComposerDraft(draftKey, "unfinished draft");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await render();
  }
  async function resize(height: number, offsetTop = 0) {
    viewport.height = height;
    viewport.offsetTop = offsetTop;
    await act(async () => {
      viewport.dispatchEvent(new browser.Event("resize"));
    });
  }
  async function observeResize() {
    await act(async () => {
      for (const observer of resizeObservers) observer.callback();
    });
  }
  const toggle = () =>
    container.querySelector<HTMLButtonElement>(".mobile-controls-toggle")!;
  async function pointer(type: string, x: number, y: number) {
    await act(async () =>
      toggle().dispatchEvent(
        new browser.PointerEvent(type, {
          clientX: x,
          clientY: y,
          pointerType: "mouse",
          pointerId: 1,
          isPrimary: true,
          button: 0,
          bubbles: true,
          cancelable: true,
        }) as unknown as PointerEvent,
      ),
    );
  }
  function expectAboveDock() {
    const target = compact()
      ? container.querySelector(".mobile-controls-stack")!
      : container.querySelector(".mobile-nav")!;
    expect(geometry(target).bottom).toBeLessThanOrEqual(dockTop() - 7 * scale);
    expect(geometry(target).top).toBeGreaterThanOrEqual(
      viewport.offsetTop + 60 * scale,
    );
  }
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    expect(resizeObservers.size).toBe(0);
    document.body.replaceChildren();
    await browser.happyDOM.whenAsyncComplete();
  });
  afterAll(async () => {
    await browser.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  for (const zoom of [1, 1.25, 1.5]) {
    test(`keyboard and Composer lift restores saved placement at ${zoom * 100}% scale`, async () => {
      scale = zoom;
      await mount("right", -30);
      expect(offset()).toBe(-30);
      composerOpen = true;
      await render();
      await resize(600, 20);
      expectAboveDock();
      expect(saves).toEqual([]);
      expect(placement).toEqual({ side: "right", offsetY: -30 });
      composerHeight = 200;
      await observeResize();
      expectAboveDock();
      composerOpen = false;
      await render();
      await resize(844);
      expect(offset()).toBe(-30);
      expect(compact()).toBe(false);
      expect(saves).toEqual([]);
    });
  }

  test("Direct keyboard bounds lift the stack without a Composer", async () => {
    scale = 1;
    await mount();
    await resize(450, 18);
    const bottom = geometry(container.querySelector(".mobile-nav")!).bottom;
    expect(bottom).toBeLessThanOrEqual(18 + 450 - 20 - 7);
    expect(compact()).toBe(false);
    expect(saves).toEqual([]);
    await resize(844);
    expect(offset()).toBe(0);
  });

  test("horizontal drag saves dock side without persisting keyboard lift", async () => {
    scale = 1;
    await mount();
    composerOpen = true;
    await render();
    await resize(600);
    expect(offset()).toBeGreaterThan(0);
    await pointer("pointerdown", 350, 300);
    await pointer("pointermove", 30, 300);
    await pointer("pointerup", 30, 300);
    expect(placement).toEqual({ side: "left", offsetY: 0 });
    expectAboveDock();
    const beforeVerticalDrag = offset();
    await pointer("pointerdown", 30, 300);
    await pointer("pointermove", 30, 275);
    await pointer("pointerup", 30, 275);
    expect(placement).toEqual({ side: "left", offsetY: 25 });
    expect(offset()).toBe(beforeVerticalDrag + 25);
    await observeResize();
    expect(offset()).toBe(beforeVerticalDrag + 25);
    composerOpen = false;
    await render();
    await resize(844);
    expect(offset()).toBe(25);
  });

  test("keyboard height changes during drag settle without saving their lift", async () => {
    scale = 1;
    await mount();
    composerOpen = true;
    await render();
    await resize(600);
    await pointer("pointerdown", 350, 300);
    await pointer("pointermove", 30, 300);
    await resize(330, 20);
    await pointer("pointerup", 30, 300);
    expect(compact()).toBe(true);
    expect(placement).toEqual({ side: "left", offsetY: 0 });
    expectAboveDock();
    composerOpen = false;
    await render();
    await resize(844);
    expect(offset()).toBe(0);
  });

  for (const side of ["left", "right"] as const) {
    test(`compact ${side} row stays stable, scrollable, and manually collapsible`, async () => {
      scale = 1.5;
      await mount(side, 10);
      composerOpen = true;
      composerHeight = 330;
      await render();
      await resize(420, 15);
      expect(compact()).toBe(true);
      expectAboveDock();
      const row = container.querySelector<HTMLElement>(
        ".mobile-controls-stack",
      )!;
      const dock = container.querySelector<HTMLElement>(".terminal-composer")!;
      row.scrollLeft = side === "left" ? 55 : -55;
      dock.scrollTop = 70;
      const before = app().style.getPropertyValue(
        "--mobile-controls-compact-bottom",
      );
      for (let index = 0; index < 5; index++) await observeResize();
      expect(compact()).toBe(true);
      expect(
        app().style.getPropertyValue("--mobile-controls-compact-bottom"),
      ).toBe(before);
      expect(row.scrollLeft).toBe(side === "left" ? 55 : -55);
      expect(dock.scrollTop).toBe(70);
      await act(async () => toggle().click());
      expect(toggle().getAttribute("aria-pressed")).toBe("true");
      await resize(400);
      expect(toggle().getAttribute("aria-pressed")).toBe("true");
      expectAboveDock();
      await act(async () => toggle().click());
      expect(toggle().getAttribute("aria-pressed")).toBe("false");
      expectAboveDock();
      await pointer("pointerdown", 330, 100);
      await pointer("pointermove", 30, 50);
      await pointer("pointerup", 30, 50);
      expect(placement).toEqual({ side: "left", offsetY: 10 });
      composerOpen = false;
      await render();
      await resize(844);
      expect(compact()).toBe(false);
      expect(offset()).toBe(10);
    });
  }

  test("impossibly short viewport prioritizes a usable dock and row over header clearance", async () => {
    scale = 1.5;
    await mount();
    composerOpen = true;
    composerHeight = 330;
    await render();
    await resize(220, 15);
    expect(compact()).toBe(true);
    const rowRect = geometry(
      container.querySelector(".mobile-controls-stack")!,
    );
    expect(dockHeight()).toBe(84); // 64px editing space plus the safe area.
    expect(rowRect.top).toBeGreaterThanOrEqual(viewport.offsetTop);
    expect(rowRect.bottom).toBeLessThanOrEqual(dockTop() - 7 * scale);
    expect(rowRect.top).toBeLessThan(viewport.offsetTop + 60 * scale);
    await resize(150, 15);
    expect(dockHeight()).toBe(42); // Bound the minimum by actual visible space.
    expect(
      geometry(container.querySelector(".mobile-controls-stack")!).top,
    ).toBeGreaterThanOrEqual(viewport.offsetTop);
    expect(
      Number.parseFloat(
        app().style.getPropertyValue("--mobile-controls-composer-max-height"),
      ),
    ).toBeGreaterThanOrEqual(0);
    expect(saves).toEqual([]);
    await resize(844);
    composerOpen = false;
    await render();
    expect(compact()).toBe(false);
    expect(offset()).toBe(0);
  });

  test("picker mounts are observed and clipped compact picker geometry does not move the row", async () => {
    scale = 1;
    await mount();
    composerOpen = true;
    await render();
    await resize(600);
    expect(compact()).toBe(false);
    pickerHeight = 300;
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".terminal-composer-commands-toggle")!
        .click(),
    );
    await browser.happyDOM.whenAsyncComplete();
    const picker = container.querySelector<HTMLElement>(
      ".terminal-composer-commands",
    )!;
    expect(picker).not.toBeNull();
    expect(
      [...resizeObservers].some((observer) => observer.observed.has(picker)),
    ).toBe(true);
    expect(compact()).toBe(true);
    const bottom = app().style.getPropertyValue(
      "--mobile-controls-compact-bottom",
    );
    container.querySelector<HTMLElement>(".terminal-composer")!.scrollTop = 180;
    await observeResize();
    expect(
      app().style.getPropertyValue("--mobile-controls-compact-bottom"),
    ).toBe(bottom);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Dismiss commands"]')!
        .click(),
    );
    await browser.happyDOM.whenAsyncComplete();
    expect(compact()).toBe(false);
    expect(
      [...resizeObservers].some((observer) => observer.observed.has(picker)),
    ).toBe(false);
  });

  test("compact row pan preserves editing focus until an actual navigation click", async () => {
    scale = 1.5;
    await mount();
    composerOpen = true;
    composerHeight = 330;
    await render();
    await resize(420);
    expect(compact()).toBe(true);
    const input = container.querySelector<HTMLTextAreaElement>(
      ".terminal-composer-input",
    )!;
    const button = container.querySelector<HTMLButtonElement>(
      ".mobile-workspace-tools button",
    )!;
    await act(async () => input.focus());
    const mouse = new browser.MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      button.dispatchEvent(
        new browser.PointerEvent("pointerdown", {
          pointerType: "touch",
          bubbles: true,
        }) as unknown as PointerEvent,
      );
      button.dispatchEvent(mouse as unknown as MouseEvent);
      button.dispatchEvent(
        new browser.PointerEvent("pointermove", {
          pointerType: "touch",
          clientX: 50,
          bubbles: true,
        }) as unknown as PointerEvent,
      );
      button.dispatchEvent(
        new browser.PointerEvent("pointerup", {
          pointerType: "touch",
          bubbles: true,
        }) as unknown as PointerEvent,
      );
    });
    expect(mouse.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(compact()).toBe(true);
    expect(input.value).toBe("unfinished draft");
    await act(async () => button.click());
    expect(document.activeElement).not.toBe(input);
    expect(input.value).toBe("unfinished draft");
  });

  test("forced mobile layout is honored independently of media-query width", async () => {
    scale = 1;
    await mount();
    // The root layout preference is authoritative; this fixture's matchMedia
    // returns true for desktop-size queries too, as on a wide forced-mobile tab.
    expect(matchMedia("(min-width: 1024px)").matches).toBe(true);
    await resize(450);
    expect(offset()).toBeGreaterThan(0);
    expect(saves).toEqual([]);
  });

  test("hidden Composer and assistant view do not impose invisible geometry", async () => {
    scale = 1;
    await mount();
    composerOpen = true;
    composerHeight = 700;
    composerHidden = true;
    await render();
    expect(offset()).toBe(0);
    expect(compact()).toBe(false);
    composerHidden = false;
    assistant = true;
    await render();
    expect(compact()).toBe(false);
    expect(saves).toEqual([]);
  });

  test("collapse and drag preserve active draft, selection, and composition; dismissed-keyboard touch still retires focus", async () => {
    scale = 1;
    await mount();
    composerOpen = true;
    await render();
    await resize(600);
    const input = container.querySelector<HTMLTextAreaElement>(
      ".terminal-composer-input",
    )!;
    await act(async () => {
      input.focus();
      input.setSelectionRange(2, 8);
      input.dispatchEvent(
        new browser.CompositionEvent("compositionstart", {
          bubbles: true,
        }) as unknown as CompositionEvent,
      );
    });
    const mouse = new browser.MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    await act(async () =>
      toggle().dispatchEvent(mouse as unknown as MouseEvent),
    );
    expect(mouse.defaultPrevented).toBe(true);
    await act(async () => toggle().click());
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("unfinished draft");
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 8]);
    expect(
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Send draft to the terminal"]',
      )!.disabled,
    ).toBe(true);
    await pointer("pointerdown", 350, 300);
    await pointer("pointermove", 30, 300);
    await pointer("pointerup", 30, 300);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("unfinished draft");
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 8]);
    document.documentElement.classList.remove("keyboard-open");
    await act(async () =>
      toggle().dispatchEvent(
        new browser.PointerEvent("pointerdown", {
          pointerType: "touch",
          bubbles: true,
        }) as unknown as PointerEvent,
      ),
    );
    expect(document.activeElement).not.toBe(input);
  });
}

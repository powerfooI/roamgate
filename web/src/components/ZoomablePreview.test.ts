import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

if (process.env.ROAMGATE_VISUAL_PREVIEW_DOM_TEST !== "1") {
  test("visual preview regressions in an isolated runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_VISUAL_PREVIEW_DOM_TEST: "1" },
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
    "Event",
    "KeyboardEvent",
    "WheelEvent",
    "localStorage",
  ] as const) {
    Object.defineProperty(globalThis, key, {
      value: key === "window" ? browser : browser[key],
      writable: true,
      configurable: true,
    });
  }
  Object.assign(globalThis, {
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const inlineSize = { width: 432, height: 360 };
  const fullscreenSize = { width: 1232, height: 632 };
  for (const [property, dimension] of [
    ["clientWidth", "width"],
    ["clientHeight", "height"],
  ] as const) {
    Object.defineProperty(browser.HTMLElement.prototype, property, {
      get(this: HTMLElement) {
        return (this.closest("dialog") ? fullscreenSize : inlineSize)[
          dimension
        ];
      },
      configurable: true,
    });
  }
  Object.defineProperty(browser.HTMLElement.prototype, "offsetHeight", {
    get() {
      return 876;
    },
    configurable: true,
  });
  // happy-dom has dialog behavior but no layout or ResizeObserver delivery.
  const observers = new Map<Element, () => void>();
  Object.assign(globalThis, {
    ResizeObserver: class {
      target: Element | null = null;
      constructor(private callback: () => void) {}
      observe(target: Element) {
        this.target = target;
        observers.set(target, this.callback);
      }
      disconnect() {
        if (this.target) observers.delete(this.target);
      }
    },
  });
  const { act, createElement: h, Fragment } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ZoomablePreview } = await import("./ZoomablePreview");
  const { AgentMessageDialog } = await import("./AgentMessageDialog");
  let root: Root | null = null;
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    document.body.replaceChildren();
    await browser.happyDOM.whenAsyncComplete();
    expect(observers.size).toBe(0);
  });
  afterAll(async () => browser.happyDOM.close());

  test("shows tall diagrams in full and keeps zoom, focus and Escape working through fullscreen", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    let closedMessages = 0;
    const preview = (fitToWidth: boolean) =>
      h(ZoomablePreview, {
        dimensions: { width: 800, height: 1600 },
        label: "Diagram",
        fitToWidth,
        children: h(
          "svg",
          { id: "test-diagram" },
          h("path", { d: "M0 0L800 1600" }),
        ),
      });
    await act(async () =>
      root!.render(
        h(
          Fragment,
          null,
          h(AgentMessageDialog, {
            message: {
              id: "message",
              role: "user",
              text: "A diagram",
              sent_at: "2026-10-02T00:00:00Z",
            },
            onClose: () => {
              closedMessages++;
            },
          }),
          preview(true),
        ),
      ),
    );
    await browser.happyDOM.whenAsyncComplete();
    const region = () =>
      document.querySelector<HTMLElement>(".visual-preview")!;
    const viewport = () =>
      document.querySelector<HTMLElement>(".visual-preview-viewport")!;
    const zoom = () => document.querySelector("output")!.textContent;
    const button = (label: string) =>
      document.querySelector<HTMLButtonElement>(`button[title="${label}"]`)!;
    const wheel = async () => {
      const event = new WheelEvent("wheel", {
        deltaY: -100,
        bubbles: true,
        cancelable: true,
      });
      // happy-dom's WheelEvent does not implement modifier keys.
      Object.defineProperty(event, "ctrlKey", { value: true });
      await act(async () => viewport().dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
    };

    expect(zoom()).toBe("50%");
    expect(region().style.getPropertyValue("--visual-preview-height")).toBe(
      "832px",
    );
    inlineSize.width = 832;
    await act(async () => observers.get(viewport())!());
    expect(zoom()).toBe("100%");
    expect(region().style.getPropertyValue("--visual-preview-height")).toBe(
      "1632px",
    );
    inlineSize.width = 432;
    await act(async () => observers.get(viewport())!());
    await wheel();
    expect(Number.parseInt(zoom()!, 10)).toBeGreaterThan(50);
    await act(async () => button("Fit preview").click());
    const inlineViewport = viewport();
    button("Fullscreen").focus();
    await act(async () => button("Fullscreen").click());
    const dialog = document.querySelector<HTMLDialogElement>("dialog")!;
    expect(dialog.open).toBe(true);
    expect(document.querySelectorAll("#test-diagram")).toHaveLength(1);
    expect(inlineViewport.isConnected).toBe(false);
    expect(zoom()).toBe("38%");
    fullscreenSize.height = 832;
    await act(async () => observers.get(viewport())!());
    expect(zoom()).toBe("50%");
    await wheel();
    expect(Number.parseInt(zoom()!, 10)).toBeGreaterThan(50);
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    await act(async () =>
      button("Exit fullscreen (Esc)").dispatchEvent(escape),
    );
    expect(closedMessages).toBe(0);
    expect(escape.defaultPrevented).toBe(false);
    // Browsers follow unhandled Escape with cancel; happy-dom needs the event.
    await act(async () =>
      dialog.dispatchEvent(new Event("cancel", { cancelable: true })),
    );
    expect(document.querySelector("dialog")).toBeNull();
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(button("Fullscreen"));
    expect(document.querySelectorAll("#test-diagram")).toHaveLength(1);
    await act(async () => button("Fit preview").click());
    expect(zoom()).toBe("50%");
    await wheel();
    expect(Number.parseInt(zoom()!, 10)).toBeGreaterThan(50);
    await act(async () => button("Fullscreen").click());
    await act(async () => button("Exit fullscreen (Esc)").click());
    expect(document.activeElement).toBe(button("Fullscreen"));
    await act(async () =>
      button("Fullscreen").dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(closedMessages).toBe(1);

    await act(async () => root!.render(preview(false)));
    expect(zoom()).toBe("21%");
    expect(region().style.getPropertyValue("--visual-preview-height")).toBe(
      "420px",
    );
  });

  test("keeps fullscreen modal and usable without native dialog methods", async () => {
    const prototype = browser.HTMLDialogElement.prototype;
    const methods = ["showModal", "close"] as const;
    const descriptors = methods.map((method) =>
      Object.getOwnPropertyDescriptor(prototype, method),
    );
    const container = document.createElement("div");
    container.setAttribute("aria-hidden", "false");
    const outside = document.createElement("button");
    const hidden = document.createElement("div");
    hidden.setAttribute("aria-hidden", "true");
    document.body.append(container, outside, hidden);
    root = createRoot(container);
    let closedMessages = 0;
    const button = (title: string) =>
      document.querySelector<HTMLButtonElement>(`button[title="${title}"]`)!;
    const viewport = () =>
      document.querySelector<HTMLElement>(".visual-preview-viewport")!;
    const key = async (key: string, shiftKey = false) => {
      const event = new KeyboardEvent("keydown", {
        key,
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      await act(async () => document.activeElement!.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
    };
    try {
      for (const method of methods) Reflect.deleteProperty(prototype, method);
      await act(async () =>
        root!.render(
          h(
            Fragment,
            null,
            h(AgentMessageDialog, {
              message: {
                id: "fallback-message",
                role: "user",
                text: "A diagram",
                sent_at: "2026-10-02T00:00:00Z",
              },
              onClose: () => {
                closedMessages++;
              },
            }),
            h(ZoomablePreview, {
              dimensions: { width: 800, height: 1600 },
              label: "Diagram",
              fitToWidth: true,
              children: h("svg"),
            }),
          ),
        ),
      );
      await browser.happyDOM.whenAsyncComplete();
      await act(async () => button("Fullscreen").click());
      const dialog = document.querySelector<HTMLDialogElement>("dialog")!;
      expect(dialog.open).toBe(true);
      expect(dialog.getAttribute("role")).toBe("dialog");
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      expect(container.getAttribute("aria-hidden")).toBe("true");
      expect(outside.getAttribute("aria-hidden")).toBe("true");
      outside.focus();
      expect(dialog.contains(document.activeElement)).toBe(true);
      viewport().focus();
      await key("Tab");
      expect(document.activeElement).toBe(button("Zoom out"));
      await key("Tab", true);
      expect(document.activeElement).toBe(viewport());
      const initialZoom = Number.parseInt(
        document.querySelector("output")!.textContent!,
        10,
      );
      const wheel = new WheelEvent("wheel", {
        deltaY: -100,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(wheel, "ctrlKey", { value: true });
      await act(async () => viewport().dispatchEvent(wheel));
      expect(wheel.defaultPrevented).toBe(true);
      expect(
        Number.parseInt(document.querySelector("output")!.textContent!, 10),
      ).toBeGreaterThan(initialZoom);
      await key("Escape");
      expect(document.querySelector("dialog")).toBeNull();
      expect(document.activeElement).toBe(button("Fullscreen"));
      expect(container.getAttribute("aria-hidden")).toBe("false");
      expect(outside.hasAttribute("aria-hidden")).toBe(false);
      expect(hidden.getAttribute("aria-hidden")).toBe("true");
      await act(async () => button("Fullscreen").click());
      await act(async () => button("Exit fullscreen (Esc)").click());
      expect(document.querySelector("dialog")).toBeNull();
      expect(document.activeElement).toBe(button("Fullscreen"));
      expect(closedMessages).toBe(0);
    } finally {
      await act(async () => root?.unmount());
      root = null;
      for (let index = 0; index < methods.length; index++) {
        const descriptor = descriptors[index];
        if (descriptor)
          Object.defineProperty(prototype, methods[index]!, descriptor);
      }
    }
  });
}

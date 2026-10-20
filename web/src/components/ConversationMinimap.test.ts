import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";

// React's event setup must see this DOM without changing other tests' globals.
if (process.env.ROAMGATE_CONVERSATION_MINIMAP_DOM_TEST !== "1") {
  test("conversation minimap in an isolated runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_CONVERSATION_MINIMAP_DOM_TEST: "1" },
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
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  Object.defineProperties(browser, {
    requestAnimationFrame: {
      value: (callback: FrameRequestCallback) => {
        frames.set(++frameId, callback);
        return frameId;
      },
    },
    cancelAnimationFrame: { value: (id: number) => frames.delete(id) },
    ResizeObserver: {
      value: class {
        observe() {}
        disconnect() {}
      },
    },
    // Reduced motion keeps the track's follow scroll synchronous.
    matchMedia: { value: () => ({ matches: true }) },
  });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Element",
    "Node",
    "Event",
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
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const { act, createElement: h } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ConversationMinimap } = await import("./ConversationMinimap");

  afterAll(async () => {
    await browser.happyDOM.close();
  });

  const flushFrames = async () => {
    await act(async () => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(0));
    });
  };

  test("an overflowing strip follows the viewport, pans, and maps scrolled positions", async () => {
    // Twenty entries with an unindexed tool block after the second one, the
    // way the History chat view interleaves them.
    const entries = Array.from({ length: 20 }, (_, index) => ({
      id: `entry-${index}`,
      role: index % 2 ? ("assistant" as const) : ("user" as const),
      label: index % 2 ? "Assistant" : "You",
      text: `Message ${index}`,
    }));
    const scroller = document.createElement("div");
    const items = document.createElement("div");
    scroller.append(items);
    entries.forEach((_, index) => {
      if (index === 2) items.append(document.createElement("div"));
      const item = document.createElement("div");
      item.dataset.sequence = String(index + 1);
      items.append(item);
    });
    let scrollerTop = 0;
    Object.defineProperties(scroller, {
      scrollTop: { get: () => scrollerTop },
      scrollHeight: { get: () => items.children.length * 50 },
    });
    scroller.getBoundingClientRect = () =>
      new browser.DOMRect(0, 100, 400, 200) as DOMRect;
    Array.from(items.children).forEach((child, position) => {
      child.getBoundingClientRect = () =>
        new browser.DOMRect(
          0,
          100 + position * 50 - scrollerTop,
          400,
          40,
        ) as DOMRect;
    });

    const container = document.createElement("div");
    document.body.append(container, scroller);
    const root = createRoot(container);
    const selected: number[] = [];
    await act(async () =>
      root.render(
        h(ConversationMinimap, {
          entries,
          scrollerRef: { current: scroller },
          itemsRef: { current: items },
          orientation: "horizontal",
          label: "Jump to message",
          onSelect: (index: number) => selected.push(index),
        }),
      ),
    );
    const track = container.querySelector<HTMLDivElement>(
      ".conversation-minimap-track",
    )!;
    // A 40px strip holding twenty 4px marks scrolls along its 80px.
    let trackLeft = 0;
    const captured = new Set<number>();
    Object.defineProperties(track, {
      clientWidth: { get: () => 40 },
      scrollWidth: { get: () => 80 },
      scrollLeft: {
        get: () => trackLeft,
        set: (next: number) => {
          trackLeft = Math.max(0, Math.min(40, next));
        },
      },
    });
    track.getBoundingClientRect = () =>
      new browser.DOMRect(0, 400, 40, 28) as DOMRect;
    track.scrollTo = ((options: ScrollToOptions) => {
      track.scrollLeft = options.left!;
    }) as HTMLElement["scrollTo"];
    track.setPointerCapture = (id: number) => captured.add(id);
    track.hasPointerCapture = (id: number) => captured.has(id);
    track.releasePointerCapture = (id: number) => captured.delete(id);
    const visible = () =>
      Array.from(
        container.querySelectorAll<HTMLElement>(
          ".conversation-minimap-mark.is-visible",
        ),
        (mark) => mark.dataset.entryId,
      );
    const dispatch = async (event: Event) => {
      await act(async () => track.dispatchEvent(event));
    };
    const pointer = (type: string, clientX: number, buttons = 1) =>
      new browser.PointerEvent(type, {
        clientX,
        clientY: 410,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
        buttons,
        bubbles: true,
      }) as unknown as Event;
    const click = (clientX: number) =>
      new browser.MouseEvent("click", {
        clientX,
        clientY: 410,
        bubbles: true,
      }) as unknown as Event;

    try {
      await flushFrames();
      // The tool block is in view but carries no sequence.
      expect(visible()).toEqual(["entry-0", "entry-1", "entry-2"]);
      expect(track.getAttribute("aria-valuenow")).toBe("1");
      expect(trackLeft).toBe(0);

      scrollerTop = 600;
      await act(async () => {
        scroller.dispatchEvent(new browser.Event("scroll") as unknown as Event);
      });
      await flushFrames();
      expect(visible()).toEqual([
        "entry-11",
        "entry-12",
        "entry-13",
        "entry-14",
      ]);
      // Marks 11-14 span 44-60px, so the strip centers them.
      expect(trackLeft).toBe(32);

      await dispatch(click(10));
      expect(selected).toEqual([10]);
      expect(
        container.querySelector("[role='tooltip']")?.textContent,
      ).toContain("Message 10");

      await dispatch(pointer("pointerdown", 20));
      await dispatch(pointer("pointermove", 5));
      expect(trackLeft).toBe(40);
      await dispatch(pointer("pointerup", 5, 0));
      // The click that ends a pan does not jump.
      await dispatch(click(5));
      expect(selected).toEqual([10]);
      await dispatch(pointer("pointerdown", 2));
      await dispatch(pointer("pointerup", 2, 0));
      await dispatch(click(2));
      expect(selected).toEqual([10, 10]);

      const key = async (value: string) => {
        const event = new browser.KeyboardEvent("keydown", {
          key: value,
          bubbles: true,
          cancelable: true,
        });
        await dispatch(event as unknown as Event);
        expect(event.defaultPrevented).toBe(true);
      };
      await key("PageDown");
      await key("PageUp");
      await key("End");
      await key("ArrowLeft");
      await key("Home");
      // Both arrow pairs step through the strip.
      await key("ArrowDown");
      await key("ArrowUp");
      expect(selected).toEqual([10, 10, 14, 10, 19, 18, 0, 1, 0]);

      // The strip holds still under a press, even as the conversation
      // moves, and releasing does not snap it back.
      await dispatch(pointer("pointerdown", 20));
      scrollerTop = 0;
      await act(async () => {
        scroller.dispatchEvent(new browser.Event("scroll") as unknown as Event);
      });
      await flushFrames();
      expect(visible()).toEqual(["entry-0", "entry-1", "entry-2"]);
      expect(trackLeft).toBe(40);
      await dispatch(pointer("pointerup", 20, 0));
      expect(trackLeft).toBe(40);
      await dispatch(click(20));
      expect(selected[selected.length - 1]).toBe(15);

      // A pan keeps the strip where the user dragged it, away from the
      // in-view marks, so a distant mark stays reachable by a later tap.
      await dispatch(pointer("pointerdown", 0));
      await dispatch(pointer("pointermove", 30));
      await dispatch(pointer("pointerup", 30, 0));
      expect(trackLeft).toBe(10);
      await dispatch(click(30));
      expect(selected[selected.length - 1]).toBe(15);
      await dispatch(pointer("pointerdown", 30));
      await dispatch(pointer("pointerup", 30, 0));
      expect(trackLeft).toBe(10);
      await dispatch(click(30));
      expect(selected[selected.length - 1]).toBe(10);
      // So does a native touch pan, which ends in pointercancel.
      await dispatch(
        new browser.PointerEvent("pointerdown", {
          clientX: 20,
          pointerId: 2,
          pointerType: "touch",
          isPrimary: true,
          button: 0,
          bubbles: true,
        }) as unknown as Event,
      );
      await dispatch(
        new browser.PointerEvent("pointercancel", {
          pointerId: 2,
          pointerType: "touch",
          bubbles: true,
        }) as unknown as Event,
      );
      expect(trackLeft).toBe(10);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      scroller.remove();
    }
  });
}

import { expect, mock, spyOn, test } from "bun:test";
import * as React from "react";
import type { MobileControlsPlacement } from "../mobileControlsPlacement";
import { useMobileControlsDrag } from "./useMobileControlsDrag";

for (const scale of [1, 1.25, 1.5]) {
  test(`mobile control geometry and drag lifecycle at ${scale * 100}% UI scale`, () => {
    const globals = [
      "document",
      "window",
      "getComputedStyle",
      "matchMedia",
    ] as const;
    const previous = globals.map((key) =>
      Object.getOwnPropertyDescriptor(globalThis, key),
    );
    const effects: React.EffectCallback[] = [];
    const layoutEffects: React.EffectCallback[] = [];
    const cleanups: Array<() => void> = [];
    const listeners = new Map<string, (event: unknown) => void>();
    const styles = new Map<string, string>();
    let placement: MobileControlsPlacement = { side: "right", offsetY: 0 };
    let appliedOffset = 0;
    let appBottom = 844;
    const setOffset = mock((offset: number) => {
      appliedOffset = offset;
    });
    const animate = mock((frames: Keyframe[]) => ({ frames, cancel() {} }));
    const rect = () => ({
      left:
        (placement.side === "right" ? 250 : 8) * scale +
        Number.parseFloat(styles.get("--mobile-controls-drag-x") ?? "0") *
          scale,
      top:
        appBottom -
        (300 + appliedOffset) * scale +
        Number.parseFloat(styles.get("--mobile-controls-drag-y") ?? "0") *
          scale,
    });
    const element = {
      offsetHeight: 200,
      getBoundingClientRect: rect,
      animate,
    };
    // The shortcut cancels UI zoom, unlike the topbar.
    const header = {
      getBoundingClientRect: () => ({ bottom: 60 * scale, height: 60 * scale }),
    };
    const shortcut = {
      getBoundingClientRect: () => ({ bottom: 140, height: 44 }),
    };
    const app = {
      offsetWidth: 320,
      getBoundingClientRect: () => ({ width: 320 * scale, bottom: appBottom }),
      querySelectorAll: (selector: string) =>
        selector.includes("mobile-terminal-controls")
          ? [element]
          : selector.includes("terminal-mobile-keys-toggle")
            ? [header, shortcut]
            : [header],
      classList: { add() {}, remove() {} },
      style: {
        setProperty: (key: string, value: string) => styles.set(key, value),
        removeProperty: (key: string) => styles.delete(key),
      },
    };
    const toggle = {
      addEventListener: (type: string, listener: (event: unknown) => void) =>
        listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
      setPointerCapture() {},
    };
    Object.defineProperties(globalThis, {
      document: {
        configurable: true,
        value: {
          documentElement: { dataset: { layout: "mobile" } },
          createElement: () => ({
            setAttribute() {},
            style: {},
            offsetHeight: 20,
          }),
          body: { append() {} },
        },
      },
      window: {
        configurable: true,
        value: { innerWidth: 320 * scale, innerHeight: 844 },
      },
      getComputedStyle: {
        configurable: true,
        value: () => ({ display: "block", bottom: "100px" }),
      },
      matchMedia: { configurable: true, value: () => ({ matches: false }) },
    });
    const spies = [
      spyOn(React, "useState").mockImplementation(() => [0, setOffset]),
      spyOn(React, "useRef").mockImplementation((current) => ({ current })),
      spyOn(React, "useEffect").mockImplementation((effect) => {
        effects.push(effect);
      }),
      spyOn(React, "useLayoutEffect").mockImplementation((effect) => {
        layoutEffects.push(effect);
      }),
    ];
    const pointer = (type: string, x: number, y: number) =>
      listeners.get(type)!({
        clientX: x,
        clientY: y,
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
        pointerId: 1,
      });
    const touch = (type: string, x: number, y: number) => {
      const event = {
        touches: [{ clientX: x, clientY: y }],
        changedTouches: [{ clientX: x, clientY: y }],
        cancelable: true,
        preventDefault: mock(() => {}),
      };
      listeners.get(type)!(event);
      return event;
    };
    try {
      useMobileControlsDrag({
        enabled: true,
        appRef: { current: app as unknown as HTMLElement },
        toggleRef: { current: toggle as unknown as HTMLElement },
        placement,
        onPlacementChange: (next) => {
          placement = next;
        },
      });
      for (const effect of [...layoutEffects, ...effects]) {
        const cleanup = effect();
        if (cleanup) cleanups.push(cleanup);
      }
      expect(appliedOffset).toBe(0);
      const startX = 280 * scale;
      pointer("pointerdown", startX, 500);
      pointer("pointermove", startX - 7, 500);
      expect(styles.size).toBe(0); // Threshold stays in viewport pixels.
      pointer("pointermove", startX, -1000);
      expect(Number.parseFloat(styles.get("--mobile-controls-drag-y")!)).toBe(
        -Math.round(844 / scale - 300 - 60 - 8),
      );
      pointer("pointermove", startX, 2000);
      expect(Number.parseFloat(styles.get("--mobile-controls-drag-y")!)).toBe(
        72,
      );
      pointer("pointermove", startX - 120, 410);
      expect(
        Number.parseFloat(styles.get("--mobile-controls-drag-x")!),
      ).toBeCloseTo(-120 / scale);
      expect(Number.parseFloat(styles.get("--mobile-controls-drag-y")!)).toBe(
        -Math.round(90 / scale),
      );
      const before = rect();
      pointer("pointerup", 10, 410);
      expect(placement).toEqual({
        side: "left",
        offsetY: Math.round(90 / scale),
      });
      expect(styles.size).toBe(0);
      const after = rect();
      const frames = animate.mock.calls[0]![0];
      const [dx, dy] = String(frames[0]!.translate)
        .split(" ")
        .map(Number.parseFloat);
      expect(after.left + dx! * scale).toBeCloseTo(before.left);
      expect(after.top + dy! * scale).toBeCloseTo(before.top);

      touch("touchstart", startX, 500);
      touch("touchmove", startX - 120, 410);
      expect(touch("touchend", 10, 410).preventDefault).toHaveBeenCalledTimes(
        1,
      );
      const click = {
        detail: 0,
        preventDefault: mock(() => {}),
        stopPropagation: mock(() => {}),
      };
      listeners.get("click")!(click);
      expect(click.preventDefault).not.toHaveBeenCalled();
      expect(click.stopPropagation).not.toHaveBeenCalled();
      // Compatibility pointer clicks must still be suppressed after a drag.
      listeners.get("click")!({ ...click, detail: 1 });
      expect(click.preventDefault).toHaveBeenCalledTimes(1);
      expect(click.stopPropagation).toHaveBeenCalledTimes(1);

      // This layout callback sees the original stored offset (0). Resize
      // during a drag defers clamping; every cancellation path must retry it.
      for (const cancelEvent of [
        "touchcancel",
        "pointercancel",
        "lostpointercapture",
      ]) {
        appBottom = 844;
        layoutEffects[1]!();
        if (cancelEvent === "touchcancel") {
          touch("touchstart", startX, 500);
          touch("touchmove", startX - 120, 410);
        } else {
          pointer("pointerdown", startX, 500);
          pointer("pointermove", startX - 120, 410);
        }
        appBottom = 400;
        setOffset.mockClear();
        layoutEffects[1]!();
        expect(setOffset).not.toHaveBeenCalled();
        const savedPlacement = placement;
        listeners.get(cancelEvent)!({ pointerType: "mouse" });
        expect(setOffset).toHaveBeenCalledTimes(1);
        expect(appliedOffset).toBe(
          Math.round(400 / scale - 300 - Math.max(60, 140 / scale) - 8),
        );
        expect(styles.size).toBe(0);
        expect(placement).toBe(savedPlacement);
      }

      setOffset.mockClear();
      for (const cleanup of cleanups.splice(0).reverse()) cleanup();
      expect(setOffset).not.toHaveBeenCalled();
      expect(listeners.size).toBe(0);
    } finally {
      for (const cleanup of cleanups.reverse()) cleanup();
      for (const spy of spies.reverse()) spy.mockRestore();
      globals.forEach((key, index) => {
        const descriptor = previous[index];
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      });
    }
  });
}

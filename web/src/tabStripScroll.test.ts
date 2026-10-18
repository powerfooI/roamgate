import { describe, expect, test } from "bun:test";
import {
  tabRevealScrollLeft,
  tabStripOverflow,
  tabStripWheelScrollLeft,
} from "./tabStripScroll";

const strip = (scrollLeft: number, scrollWidth = 1000, clientWidth = 400) => ({
  scrollLeft,
  scrollWidth,
  clientWidth,
});

const wheel = (deltaY: number, overrides = {}) => ({
  deltaX: 0,
  deltaY,
  deltaMode: 0,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  ...overrides,
});

describe("tabStripOverflow", () => {
  test("reports no hidden tabs when everything fits", () => {
    expect(tabStripOverflow(strip(0, 400))).toEqual({
      start: false,
      end: false,
    });
  });

  test("reports the edges that hide tabs", () => {
    expect(tabStripOverflow(strip(0))).toEqual({ start: false, end: true });
    expect(tabStripOverflow(strip(300))).toEqual({ start: true, end: true });
    expect(tabStripOverflow(strip(600))).toEqual({ start: true, end: false });
  });

  test("ignores sub-pixel remainders at either edge", () => {
    expect(tabStripOverflow(strip(0.5))).toEqual({ start: false, end: true });
    expect(tabStripOverflow(strip(599.5))).toEqual({
      start: true,
      end: false,
    });
  });
});

describe("tabStripWheelScrollLeft", () => {
  test("turns a vertical wheel into horizontal travel", () => {
    expect(tabStripWheelScrollLeft(strip(100), wheel(120))).toBe(220);
    expect(tabStripWheelScrollLeft(strip(100), wheel(-60))).toBe(40);
  });

  test("scales line and page delta modes", () => {
    expect(tabStripWheelScrollLeft(strip(0), wheel(3, { deltaMode: 1 }))).toBe(
      120,
    );
    expect(tabStripWheelScrollLeft(strip(0), wheel(1, { deltaMode: 2 }))).toBe(
      400,
    );
  });

  test("clamps to the strip's scroll range", () => {
    expect(tabStripWheelScrollLeft(strip(550), wheel(120))).toBe(600);
    expect(tabStripWheelScrollLeft(strip(30), wheel(-120))).toBe(0);
  });

  test("leaves the event to the browser when the strip cannot move", () => {
    expect(tabStripWheelScrollLeft(strip(0, 400), wheel(120))).toBe(null);
    expect(tabStripWheelScrollLeft(strip(600), wheel(120))).toBe(null);
    expect(tabStripWheelScrollLeft(strip(0), wheel(-120))).toBe(null);
  });

  test("leaves native horizontal, Shift, and zoom gestures alone", () => {
    expect(tabStripWheelScrollLeft(strip(100), wheel(10, { deltaX: 40 }))).toBe(
      null,
    );
    expect(
      tabStripWheelScrollLeft(strip(100), wheel(120, { shiftKey: true })),
    ).toBe(null);
    expect(
      tabStripWheelScrollLeft(strip(100), wheel(120, { ctrlKey: true })),
    ).toBe(null);
    expect(
      tabStripWheelScrollLeft(strip(100), wheel(120, { metaKey: true })),
    ).toBe(null);
  });
});

describe("tabRevealScrollLeft", () => {
  test("keeps a visible tab where it is", () => {
    expect(tabRevealScrollLeft(strip(100), { left: 200, width: 100 })).toBe(
      null,
    );
  });

  test("scrolls a tab past the end into view, clear of the fade", () => {
    expect(tabRevealScrollLeft(strip(0), { left: 500, width: 100 })).toBe(224);
  });

  test("scrolls a tab before the start into view, clear of the fade", () => {
    expect(tabRevealScrollLeft(strip(400), { left: 300, width: 100 })).toBe(
      276,
    );
  });

  test("treats a tab under the edge fade as hidden", () => {
    // Fully inside the viewport, but its last 14px sit under the end fade.
    expect(tabRevealScrollLeft(strip(0), { left: 290, width: 100 })).toBe(14);
  });

  test("clamps to the strip's scroll range", () => {
    expect(tabRevealScrollLeft(strip(300), { left: 4, width: 80 })).toBe(0);
    expect(tabRevealScrollLeft(strip(0), { left: 900, width: 100 })).toBe(600);
  });

  test("aligns the start of a tab wider than the strip", () => {
    expect(tabRevealScrollLeft(strip(0), { left: 200, width: 500 })).toBe(176);
  });
});

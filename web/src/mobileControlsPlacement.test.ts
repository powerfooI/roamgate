import { describe, expect, test } from "bun:test";
import {
  clampMobileControlsOffset,
  DEFAULT_MOBILE_CONTROLS_PLACEMENT,
  mobileControlsSideForRelease,
  parseMobileControlsPlacement,
  readMobileControlsPlacement,
  writeMobileControlsPlacement,
} from "./mobileControlsPlacement";

describe("mobile controls placement storage", () => {
  test("parses valid placements and rounds offsets", () => {
    expect(
      parseMobileControlsPlacement('{"side":"left","offsetY":120.6}'),
    ).toEqual({ side: "left", offsetY: 121 });
    expect(
      parseMobileControlsPlacement('{"side":"right","offsetY":-40}'),
    ).toEqual({ side: "right", offsetY: -40 });
  });

  test.each([
    null,
    "",
    "not json",
    "[]",
    "null",
    '{"side":"top","offsetY":0}',
    '{"side":"left"}',
    '{"side":"left","offsetY":"12"}',
    '{"side":"left","offsetY":1e9}',
  ])("falls back to the default for %p", (raw) => {
    expect(parseMobileControlsPlacement(raw)).toEqual(
      DEFAULT_MOBILE_CONTROLS_PLACEMENT,
    );
  });

  test("round-trips through storage and tolerates throwing storage", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
    writeMobileControlsPlacement({ side: "left", offsetY: 33.2 }, storage);
    expect(readMobileControlsPlacement(storage)).toEqual({
      side: "left",
      offsetY: 33,
    });
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readMobileControlsPlacement(broken)).toEqual(
      DEFAULT_MOBILE_CONTROLS_PLACEMENT,
    );
    expect(() =>
      writeMobileControlsPlacement({ side: "right", offsetY: 0 }, broken),
    ).not.toThrow();
  });
});

describe("clampMobileControlsOffset", () => {
  // The stack spans y = 400..700 at offset 0 and may use y = 8..836.
  const bounds = { top: 400, bottom: 700, minTop: 8, maxBottom: 836 };

  test("keeps offsets that fit", () => {
    expect(clampMobileControlsOffset(0, bounds)).toBe(0);
    expect(clampMobileControlsOffset(250, bounds)).toBe(250);
    expect(clampMobileControlsOffset(-100, bounds)).toBe(-100);
  });

  test("stops at the top and bottom margins", () => {
    expect(clampMobileControlsOffset(1_000, bounds)).toBe(392);
    expect(clampMobileControlsOffset(-1_000, bounds)).toBe(-136);
  });

  test("pins a stack taller than the viewport to the top", () => {
    const tiny = { top: 100, bottom: 400, minTop: 8, maxBottom: 192 };
    expect(clampMobileControlsOffset(-50, tiny)).toBe(92);
    expect(clampMobileControlsOffset(500, tiny)).toBe(92);
  });
});

test("releases on the nearer half", () => {
  expect(mobileControlsSideForRelease(10, 390)).toBe("left");
  expect(mobileControlsSideForRelease(194, 390)).toBe("left");
  expect(mobileControlsSideForRelease(195, 390)).toBe("right");
  expect(mobileControlsSideForRelease(380, 390)).toBe("right");
});

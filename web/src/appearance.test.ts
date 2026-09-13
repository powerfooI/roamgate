import { describe, expect, test } from "bun:test";
import {
  clampUiScale,
  normalizeAccentColor,
  normalizeThemePreference,
  normalizeUiScale,
  normalizeZenMode,
  resolveSystemTheme,
  serializeZenMode,
  UI_SCALE_DEFAULT,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
} from "./appearance";

const matches = (value: boolean) => ({ matches: value });

describe("appearance preferences", () => {
  test("accepts supported accent colors", () => {
    expect(normalizeAccentColor("neutral")).toBe("neutral");
    expect(normalizeAccentColor("teal")).toBe("teal");
    expect(normalizeAccentColor("amber")).toBe("amber");
    expect(normalizeAccentColor("violet")).toBe("violet");
  });

  test("falls back to the original neutral theme for missing or unknown values", () => {
    expect(normalizeAccentColor(null)).toBe("neutral");
    expect(normalizeAccentColor("")).toBe("neutral");
    expect(normalizeAccentColor("orange")).toBe("neutral");
  });

  test("accepts supported theme preferences, including system", () => {
    expect(normalizeThemePreference("dark")).toBe("dark");
    expect(normalizeThemePreference("light")).toBe("light");
    expect(normalizeThemePreference("system")).toBe("system");
  });

  test("falls back to the dark theme for missing or unknown values", () => {
    expect(normalizeThemePreference(null)).toBe("dark");
    expect(normalizeThemePreference("")).toBe("dark");
    expect(normalizeThemePreference("auto")).toBe("dark");
  });

  test("resolves the system theme from the color-scheme media query", () => {
    expect(resolveSystemTheme(matches(true))).toBe("light");
    expect(resolveSystemTheme(matches(false))).toBe("dark");
  });
});

describe("clampUiScale", () => {
  test("keeps in-range values on the step grid", () => {
    expect(clampUiScale(100)).toBe(100);
    expect(clampUiScale(125)).toBe(125);
  });

  test("rounds values to the nearest step", () => {
    expect(clampUiScale(103)).toBe(105);
    expect(clampUiScale(102)).toBe(100);
  });

  test("clamps to the supported range", () => {
    expect(clampUiScale(10)).toBe(UI_SCALE_MIN);
    expect(clampUiScale(500)).toBe(UI_SCALE_MAX);
  });

  test("falls back to the default for non-finite values", () => {
    expect(clampUiScale(Number.NaN)).toBe(UI_SCALE_DEFAULT);
    expect(clampUiScale(Number.POSITIVE_INFINITY)).toBe(UI_SCALE_DEFAULT);
  });
});

describe("normalizeUiScale", () => {
  test("defaults when nothing is stored", () => {
    expect(normalizeUiScale(null)).toBe(UI_SCALE_DEFAULT);
  });

  test("defaults for unparsable stored values", () => {
    expect(normalizeUiScale("large")).toBe(UI_SCALE_DEFAULT);
  });

  test("parses and clamps stored values", () => {
    expect(normalizeUiScale("110")).toBe(110);
    expect(normalizeUiScale("999")).toBe(UI_SCALE_MAX);
  });
});

describe("zen mode", () => {
  test("stays off until it is stored", () => {
    expect(normalizeZenMode(null)).toBe(false);
    expect(normalizeZenMode("")).toBe(false);
    expect(normalizeZenMode("true")).toBe(false);
  });

  test("round-trips through storage", () => {
    expect(normalizeZenMode(serializeZenMode(true))).toBe(true);
    expect(normalizeZenMode(serializeZenMode(false))).toBe(false);
  });
});

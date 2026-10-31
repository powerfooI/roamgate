/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import {
  UI_SETTING_MAX_BYTES,
  uiSettingKeyIsValid,
  uiSettingValueError,
} from "./gui-settings";

describe("interface preference validation", () => {
  test("accepts namespace identifiers and refuses addressing tricks", () => {
    expect(uiSettingKeyIsValid("keyboardShortcuts")).toBe(true);
    expect(uiSettingKeyIsValid("terminal.theme")).toBe(true);
    expect(uiSettingKeyIsValid("sidebar-order_2")).toBe(true);

    expect(uiSettingKeyIsValid("")).toBe(false);
    expect(uiSettingKeyIsValid("2fast")).toBe(false);
    expect(uiSettingKeyIsValid("../escape")).toBe(false);
    expect(uiSettingKeyIsValid("has space")).toBe(false);
    expect(uiSettingKeyIsValid("a".repeat(65))).toBe(false);
    expect(uiSettingKeyIsValid(7)).toBe(false);
  });

  test("refuses values that cannot survive a round trip through the file", () => {
    expect(uiSettingValueError({ active: "auto", presets: [] })).toBeNull();
    expect(uiSettingValueError(null)).toBeNull();
    expect(uiSettingValueError(undefined)).toBeNull();

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(uiSettingValueError(cyclic)).toContain("JSON-serializable");
    expect(uiSettingValueError(() => undefined)).toContain("JSON-serializable");
  });

  test("caps a preference so it cannot be used as a data store", () => {
    const large = { blob: "x".repeat(UI_SETTING_MAX_BYTES) };
    expect(uiSettingValueError(large)).toContain(
      `limit is ${UI_SETTING_MAX_BYTES}`,
    );
    expect(uiSettingValueError({ blob: "x".repeat(1000) })).toBeNull();
  });
});

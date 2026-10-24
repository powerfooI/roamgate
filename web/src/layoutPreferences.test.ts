import { describe, expect, test } from "bun:test";
import {
  layoutUrlOverride,
  parseLayoutPreferences,
  resolveMobileLayout,
} from "./layoutPreferences";

const defaults = parseLayoutPreferences(null);

describe("layout preferences", () => {
  test("keeps independent sidebar orders and tolerates invalid storage", () => {
    for (const raw of [
      null,
      "bad json",
      "null",
      "[]",
      "42",
      '{"mode":"invalid","mobileBreakpoint":"900"}',
    ]) {
      expect(parseLayoutPreferences(raw)).toEqual(defaults);
    }
    expect(defaults.mobileSidebarOrder).toBe("agents-first");
    expect(defaults.desktopSidebarOrder).toBe("workspaces-first");
    expect(
      parseLayoutPreferences(
        JSON.stringify({
          mobileSidebarOrder: "workspaces-first",
          desktopSidebarOrder: "agents-first",
        }),
      ),
    ).toMatchObject({
      mobileSidebarOrder: "workspaces-first",
      desktopSidebarOrder: "agents-first",
    });
  });

  test("uses an inclusive customizable breakpoint for unfolded phones", () => {
    expect(resolveMobileLayout(768, defaults)).toBe(true);
    expect(resolveMobileLayout(769, defaults)).toBe(false);
    const preferences = { ...defaults, mobileBreakpoint: 1100 };
    expect(resolveMobileLayout(1000, preferences)).toBe(true);
    expect(resolveMobileLayout(1100, preferences)).toBe(true);
    expect(resolveMobileLayout(1101, preferences)).toBe(false);
    // A phone on its side: wide, but short on a touch screen.
    expect(resolveMobileLayout(915, defaults, "", true)).toBe(true);
    expect(
      resolveMobileLayout(915, { ...defaults, mode: "desktop" }, "", true),
    ).toBe(false);
    expect(
      parseLayoutPreferences('{"mobileBreakpoint":0}').mobileBreakpoint,
    ).toBe(320);
    expect(
      parseLayoutPreferences('{"mobileBreakpoint":9999}').mobileBreakpoint,
    ).toBe(2560);
    expect(
      parseLayoutPreferences('{"mobileBreakpoint":900.2}').mobileBreakpoint,
    ).toBe(900);
  });

  test("URL overrides win over saved modes without depending on viewport width", () => {
    expect(resolveMobileLayout(2000, { ...defaults, mode: "mobile" })).toBe(
      true,
    );
    expect(resolveMobileLayout(350, { ...defaults, mode: "desktop" })).toBe(
      false,
    );
    expect(
      resolveMobileLayout(
        1000,
        { ...defaults, mode: "desktop" },
        "?layout=mobile",
      ),
    ).toBe(true);
    expect(
      resolveMobileLayout(
        350,
        { ...defaults, mode: "mobile" },
        "?layout=desktop",
      ),
    ).toBe(false);
    expect(
      resolveMobileLayout(
        1000,
        { ...defaults, mode: "mobile" },
        "?layout=auto",
      ),
    ).toBe(false);
    expect(
      resolveMobileLayout(
        1000,
        { ...defaults, mode: "mobile" },
        "?layout=invalid",
      ),
    ).toBe(true);
    expect(layoutUrlOverride("?debugViewport=1&layout=mobile")).toBe("mobile");
    expect(layoutUrlOverride("?mobile=1")).toBeNull();
  });
});

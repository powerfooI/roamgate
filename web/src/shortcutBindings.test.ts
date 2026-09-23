import { describe, expect, test } from "bun:test";
import {
  defaultShortcutBindings,
  detectShortcutPlatform,
  formatShortcut,
  matchesShortcut,
  normalizeShortcut,
  SHORTCUT_IDS,
  shortcutConflicts,
  shortcutFromEvent,
  validateShortcutKeys,
  type ShortcutBindings,
  type ShortcutEvent,
} from "./shortcutBindings";
import { SHORTCUT_CATALOG } from "./shortcutCatalog";
import {
  exportShortcutPreset,
  importShortcutPreset,
  parseShortcutPreferences,
  resolveShortcutPreset,
  validateShortcutPreset,
} from "./shortcutPreferences";
import { tabShortcutAction } from "./tabShortcuts";
import { paneShortcutAction } from "./paneShortcuts";
import { terminalShortcutSequence } from "./terminalKeys";

const event = (overrides: Partial<ShortcutEvent> = {}): ShortcutEvent => ({
  key: "k",
  code: "KeyK",
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  ...overrides,
});
const linux = () => defaultShortcutBindings("linux");
const preset = () => ({
  id: "custom-test",
  name: "My keyboard",
  base: "linux" as const,
  bindings: linux(),
});

describe("platform shortcut maps", () => {
  test("detects desktop and mobile client platforms", () => {
    expect(
      detectShortcutPlatform({ platform: "MacIntel", userAgent: "Macintosh" }),
    ).toBe("mac");
    expect(detectShortcutPlatform({ userAgent: "iPhone" })).toBe("mac");
    expect(
      detectShortcutPlatform({ userAgentData: { platform: "Windows" } }),
    ).toBe("windows");
    expect(
      detectShortcutPlatform({ platform: "Linux armv8", userAgent: "Android" }),
    ).toBe("linux");
  });
  test("every preset and catalog entry covers the same actions without conflicts", () => {
    expect(SHORTCUT_CATALOG.map((item) => item.id).sort()).toEqual(
      [...SHORTCUT_IDS].sort(),
    );
    for (const platform of ["mac", "windows", "linux"] as const) {
      const bindings = defaultShortcutBindings(platform);
      expect(
        validateShortcutPreset({ ...preset(), base: platform, bindings })
          .bindings,
      ).toEqual(bindings);
      for (const id of SHORTCUT_IDS)
        expect(shortcutConflicts(id, bindings[id], bindings)).toEqual([]);
    }
  });
  test("automatic follows the current device while explicit and custom choices persist", () => {
    const prefs = { version: 1 as const, active: "auto", presets: [preset()] };
    expect(resolveShortcutPreset(prefs, "mac").bindings["tab.create"]).toEqual([
      "Meta+T",
    ]);
    expect(
      resolveShortcutPreset(prefs, "windows").bindings["tab.create"],
    ).toEqual(["Ctrl+Alt+T"]);
    expect(
      resolveShortcutPreset({ ...prefs, active: "mac" }, "linux").base,
    ).toBe("mac");
    expect(
      resolveShortcutPreset({ ...prefs, active: "custom-test" }, "mac").name,
    ).toBe("My keyboard");
  });
  test("formats modifiers for the device, including intentionally selected foreign presets", () => {
    expect(formatShortcut("Alt+Meta+ArrowLeft", "mac")).toBe("Option+Cmd+Left");
    expect(formatShortcut("Alt+Meta+ArrowLeft", "windows")).toBe(
      "Alt+Win+Left",
    );
    expect(formatShortcut("Meta+K", "linux")).toBe("Super+K");
  });
});

describe("shortcut matching and validation", () => {
  test("Linux navigation avoids the desktop terminal and show-desktop combinations", () => {
    const bindings = linux();
    const key = {
      key: "t",
      code: "KeyT",
      ctrlKey: true,
      altKey: true,
      shiftKey: false,
      metaKey: false,
    };
    expect(tabShortcutAction(key, bindings)).toBeNull();
    expect(tabShortcutAction({ ...key, shiftKey: true }, bindings)).toBe(
      "create",
    );
    expect(
      paneShortcutAction({ ...key, key: "d", code: "KeyD" }, bindings),
    ).toBeNull();
    expect(
      paneShortcutAction(
        { ...key, key: "d", code: "KeyD", shiftKey: true },
        bindings,
      ),
    ).toEqual({ type: "split", direction: "right" });
  });

  test("matches physical letter and number keys with exact modifiers", () => {
    expect(shortcutFromEvent(event({ key: "˚", altKey: true }))).toBe("Alt+K");
    expect(
      shortcutFromEvent(
        event({ key: "!", code: "Digit1", shiftKey: true, ctrlKey: true }),
      ),
    ).toBe("Ctrl+Shift+1");
    expect(
      matchesShortcut(
        event({ ctrlKey: true, altKey: true }),
        "command.menu",
        linux(),
      ),
    ).toBe(true);
    expect(
      matchesShortcut(
        event({ ctrlKey: true, altKey: true, shiftKey: true }),
        "command.menu",
        linux(),
      ),
    ).toBe(false);
    expect(normalizeShortcut("shift + command + k")).toBe("Meta+Shift+K");
  });
  test("leaves IME and AltGraph input alone", () => {
    expect(
      shortcutFromEvent(
        event({ ctrlKey: true, altKey: true, isComposing: true }),
      ),
    ).toBeNull();
    expect(shortcutFromEvent(event({ keyCode: 229 }))).toBeNull();
    // AltGraph producing an alternate character stays text input.
    expect(
      shortcutFromEvent(
        event({
          key: "@",
          code: "Digit2",
          ctrlKey: true,
          altKey: true,
          getModifierState: (key) => key === "AltGraph",
        }),
      ),
    ).toBeNull();
    // Plain Ctrl+Alt on Windows AltGr layouts also reports AltGraph; bindings
    // must still match when the key agrees with the physical code.
    const altGrCtrlAlt = event({
      ctrlKey: true,
      altKey: true,
      getModifierState: (key) => key === "AltGraph",
    });
    expect(shortcutFromEvent(altGrCtrlAlt)).toBe("Ctrl+Alt+K");
    expect(matchesShortcut(altGrCtrlAlt, "command.menu", linux())).toBe(true);
  });
  test("rejects malformed, unmodified printable, pointer-only, and dismissal bindings", () => {
    for (const key of [
      "Ctrl+Ctrl+K",
      "Ctrl+Bogus",
      "K",
      "Shift+K",
      "Escape",
      "Ctrl+Click",
    ]) {
      expect(() => validateShortcutKeys("command.menu", [key])).toThrow();
    }
    expect(() => validateShortcutKeys("terminal.link", ["Ctrl+K"])).toThrow();
    expect(validateShortcutKeys("terminal.link", ["Option+Click"])).toEqual([
      "Alt+Click",
    ]);
    expect(validateShortcutKeys("command.menu", [])).toEqual([]);
  });
  test("detects collisions across active contexts but permits independent contexts", () => {
    expect(shortcutConflicts("tab.create", ["Ctrl+Alt+K"], linux())).toContain(
      "command.menu",
    );
    expect(shortcutConflicts("tab.create", ["Ctrl+A"], linux())).toContain(
      "terminal.lineStart",
    );
    expect(shortcutConflicts("preview.selectAll", ["Ctrl+A"], linux())).toEqual(
      [],
    );
    expect(shortcutConflicts("command.1", ["Ctrl+Alt+1"], linux())).toEqual([]);
  });
  test("tab and pane handlers use edited keys and stop recognizing the old combination", () => {
    const bindings = linux();
    bindings["tab.create"] = ["Alt+F8"];
    const baseEvent = {
      key: "t",
      code: "KeyT",
      ctrlKey: true,
      altKey: true,
      metaKey: false,
      shiftKey: false,
    };
    expect(tabShortcutAction(baseEvent, bindings)).toBeNull();
    expect(
      tabShortcutAction(
        { ...baseEvent, key: "F8", code: "F8", ctrlKey: false },
        bindings,
      ),
    ).toBe("create");
    bindings["pane.left"] = ["Alt+F9"];
    expect(
      paneShortcutAction(
        { ...baseEvent, key: "F9", code: "F9", ctrlKey: false },
        bindings,
      ),
    ).toEqual({ type: "focus", direction: "left" });
    bindings["pane.left"] = [];
    expect(
      paneShortcutAction(
        { ...baseEvent, key: "F9", code: "F9", ctrlKey: false },
        bindings,
      ),
    ).toBeNull();
  });
  test("terminal remapping preserves bytes and does not send on keyup or composition", () => {
    const bindings = linux();
    bindings["terminal.multiline"] = ["Ctrl+Alt+Enter"];
    const key = {
      type: "keydown",
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      ctrlKey: true,
      altKey: true,
      shiftKey: false,
      metaKey: false,
      isComposing: false,
    };
    expect(terminalShortcutSequence(key, bindings)).toBe("\x1b[13;2u");
    expect(
      terminalShortcutSequence(
        { ...key, ctrlKey: false, altKey: false, shiftKey: true },
        bindings,
      ),
    ).toBeNull();
    expect(
      terminalShortcutSequence({ ...key, type: "keyup" }, bindings),
    ).toBeNull();
    expect(
      terminalShortcutSequence({ ...key, isComposing: true }, bindings),
    ).toBeNull();
    bindings["terminal.multiline"] = [];
    expect(terminalShortcutSequence(key, bindings)).toBeNull();
  });
});

describe("shortcut preset persistence and exchange", () => {
  test("roundtrips custom bindings and unassigned actions", () => {
    const custom = preset();
    custom.bindings["sidebar.toggle"] = [];
    custom.bindings["tab.create"] = ["Alt+F8"];
    const restored = importShortcutPreset(exportShortcutPreset(custom));
    expect(restored).toEqual(custom);
    const preferences = {
      version: 1 as const,
      active: custom.id,
      presets: [custom],
    };
    expect(parseShortcutPreferences(JSON.stringify(preferences))).toEqual(
      preferences,
    );
  });
  test("recovers from malformed browser storage and missing active presets", () => {
    for (const raw of [null, "{", "null", "[]", '{"version":9}'])
      expect(parseShortcutPreferences(raw).active).toBe("auto");
    const bad = { ...preset(), bindings: { "tab.create": ["K"] } };
    const parsed = parseShortcutPreferences(
      JSON.stringify({ version: 1, active: "custom-test", presets: [bad] }),
    );
    expect(parsed.presets).toEqual([]);
    expect(parsed.active).toBe("auto");
  });
  test("rejects conflicting, oversized, unknown-action, and unsupported preset imports atomically", () => {
    const custom = preset();
    custom.bindings["tab.create"] = ["Ctrl+Alt+K"];
    expect(() => importShortcutPreset(exportShortcutPreset(custom))).toThrow(
      "Conflicting",
    );
    expect(() => importShortcutPreset(" ".repeat(100_001))).toThrow("100 KB");
    expect(() =>
      importShortcutPreset('{"format":"herdr-keybindings","version":2}'),
    ).toThrow("version 1");
    expect(() =>
      validateShortcutPreset({ ...preset(), bindings: { alien: ["Ctrl+K"] } }),
    ).toThrow("unknown actions");
    expect(() => validateShortcutPreset({ ...preset(), name: " " })).toThrow(
      "Preset names",
    );
  });
});

test("older presets gain panel shortcuts without replacing saved assignments", () => {
  for (const base of ["mac", "windows", "linux"] as const) {
    const previous = {
      ...preset(),
      base,
      bindings: defaultShortcutBindings(base),
    };
    const bindings: Partial<typeof previous.bindings> = {
      ...previous.bindings,
    };
    delete bindings["inspector.expand"];
    delete bindings["annotations.toggle"];
    const loaded = validateShortcutPreset({ ...previous, bindings });
    expect(loaded.bindings).toEqual(previous.bindings);

    bindings["tab.create"] = previous.bindings["inspector.expand"];
    bindings["tab.close"] = previous.bindings["annotations.toggle"];
    const taken = validateShortcutPreset({ ...previous, bindings });
    expect(taken.bindings["tab.create"]).toEqual(bindings["tab.create"]!);
    expect(taken.bindings["tab.close"]).toEqual(bindings["tab.close"]!);
    expect(taken.bindings["inspector.expand"]).toEqual([]);
    expect(taken.bindings["annotations.toggle"]).toEqual([]);
  }
});

test("older presets keep a key assigned before the popup shortcut existed", () => {
  for (const base of ["mac", "windows", "linux"] as const) {
    const bindings: Partial<ShortcutBindings> = defaultShortcutBindings(base);
    bindings["tab.close"] = bindings["plugin.herdrFloat.toggle"];
    delete bindings["plugin.herdrFloat.toggle"];
    const loaded = validateShortcutPreset({ ...preset(), base, bindings });
    expect(loaded.bindings["tab.close"]).toEqual(bindings["tab.close"]!);
    expect(loaded.bindings["plugin.herdrFloat.toggle"]).toEqual([]);
  }
});

test("older presets gain annotation delivery shortcuts without replacing saved keys", () => {
  for (const base of ["mac", "windows", "linux"] as const) {
    const defaults = defaultShortcutBindings(base);
    const bindings: Partial<typeof defaults> = { ...defaults };
    delete bindings["annotations.copy"];
    delete bindings["annotations.prefill"];
    expect(
      validateShortcutPreset({ ...preset(), base, bindings }).bindings,
    ).toEqual(defaults);

    delete bindings["terminal.copy"];
    bindings["annotation.submit"] = [];
    bindings["composer.send"] = [];
    bindings["tab.create"] = defaults["annotations.copy"];
    bindings["tab.close"] = defaults["annotations.prefill"];
    const loaded = validateShortcutPreset({ ...preset(), base, bindings });
    expect(loaded.bindings["annotations.copy"]).toEqual([]);
    expect(loaded.bindings["annotations.prefill"]).toEqual([]);
    expect(loaded.bindings["tab.create"]).toEqual(defaults["annotations.copy"]);
    expect(loaded.bindings["tab.close"]).toEqual(
      defaults["annotations.prefill"],
    );
  }
});

describe("terminal copy shortcuts", () => {
  test("copies with platform bindings without taking over Ctrl+C", () => {
    for (const platform of ["windows", "linux", "mac"] as const) {
      const bindings = defaultShortcutBindings(platform);
      const copyKey = event({ key: "c", code: "KeyC", ctrlKey: true });
      expect(matchesShortcut(copyKey, "terminal.copy", bindings)).toBe(false);
      if (platform === "mac") {
        expect(
          matchesShortcut(
            { ...copyKey, ctrlKey: false, metaKey: true },
            "terminal.copy",
            bindings,
          ),
        ).toBe(true);
      } else {
        expect(
          matchesShortcut(
            { ...copyKey, shiftKey: true },
            "terminal.copy",
            bindings,
          ),
        ).toBe(true);
        expect(
          matchesShortcut(
            { ...copyKey, key: "Insert", code: "Insert" },
            "terminal.copy",
            bindings,
          ),
        ).toBe(true);
      }
    }
  });

  test("older presets gain only copy defaults that do not conflict with saved assignments", () => {
    const previous = preset();
    const bindings: Partial<typeof previous.bindings> = {
      ...previous.bindings,
    };
    delete bindings["terminal.copy"];
    delete bindings["annotations.copy"];
    delete bindings["annotations.prefill"];
    bindings["tab.create"] = ["Ctrl+Shift+C"];
    const loaded = parseShortcutPreferences(
      JSON.stringify({
        version: 1,
        active: previous.id,
        presets: [{ ...previous, bindings }],
      }),
    );
    expect(loaded.active).toBe(previous.id);
    expect(loaded.presets[0].bindings["tab.create"]).toEqual(["Ctrl+Shift+C"]);
    expect(loaded.presets[0].bindings["terminal.copy"]).toEqual([
      "Ctrl+Insert",
    ]);
    bindings["tab.close"] = ["Ctrl+Insert"];
    const bothTaken = validateShortcutPreset({ ...previous, bindings });
    expect(bothTaken.bindings["terminal.copy"]).toEqual([]);
  });

  test("presets saved before Zen mode keep their keys and load intact", () => {
    const previous = preset();
    const bindings: Partial<typeof previous.bindings> = {
      ...previous.bindings,
    };
    delete bindings["zen.toggle"];
    const loaded = parseShortcutPreferences(
      JSON.stringify({
        version: 1,
        active: previous.id,
        presets: [{ ...previous, bindings }],
      }),
    );
    expect(loaded.presets[0].bindings["zen.toggle"]).toEqual(["Ctrl+Alt+Z"]);

    // A preset that already spent the default key keeps it, and Zen mode
    // arrives unassigned rather than dropping the whole preset.
    bindings["tab.close"] = ["Ctrl+Alt+Z"];
    const taken = parseShortcutPreferences(
      JSON.stringify({
        version: 1,
        active: previous.id,
        presets: [{ ...previous, bindings }],
      }),
    );
    expect(taken.presets).toHaveLength(1);
    expect(taken.presets[0].bindings["tab.close"]).toEqual(["Ctrl+Alt+Z"]);
    expect(taken.presets[0].bindings["zen.toggle"]).toEqual([]);
  });

  test("presets saved before pane zoom keep their keys and load intact", () => {
    const previous = preset();
    const bindings: Partial<typeof previous.bindings> = {
      ...previous.bindings,
    };
    delete bindings["pane.zoom"];
    const loaded = parseShortcutPreferences(
      JSON.stringify({
        version: 1,
        active: previous.id,
        presets: [{ ...previous, bindings }],
      }),
    );
    expect(loaded.presets[0].bindings["pane.zoom"]).toEqual(["Ctrl+Alt+Enter"]);

    // A preset that already spent the default key keeps it, and pane zoom
    // arrives unassigned rather than dropping the whole preset.
    bindings["tab.close"] = ["Ctrl+Alt+Enter"];
    const taken = parseShortcutPreferences(
      JSON.stringify({
        version: 1,
        active: previous.id,
        presets: [{ ...previous, bindings }],
      }),
    );
    expect(taken.presets).toHaveLength(1);
    expect(taken.presets[0].bindings["tab.close"]).toEqual(["Ctrl+Alt+Enter"]);
    expect(taken.presets[0].bindings["pane.zoom"]).toEqual([]);
  });

  test("explicitly unassigned and customized copy keys survive preset round trips", () => {
    for (const keys of [[], ["Ctrl+Alt+C"]]) {
      const saved = preset();
      saved.bindings["terminal.copy"] = keys;
      const loaded = validateShortcutPreset(JSON.parse(JSON.stringify(saved)));
      expect(loaded.bindings["terminal.copy"]).toEqual(keys);
      expect(
        matchesShortcut(
          event({ key: "c", code: "KeyC", ctrlKey: true, shiftKey: true }),
          "terminal.copy",
          loaded.bindings,
        ),
      ).toBe(false);
    }
  });
});

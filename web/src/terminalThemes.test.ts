import { describe, expect, test } from "bun:test";
import { Terminal } from "@xterm/xterm";
import {
  CUSTOM_TERMINAL_THEME_SELECTION_ALPHA,
  MAX_CUSTOM_TERMINAL_THEMES,
  TERMINAL_THEME_PRESETS,
  applyTerminalTheme,
  customTerminalThemeToITheme,
  defaultTerminalThemeId,
  hexToRgba,
  normalizeCustomTerminalThemes,
  normalizeTerminalColor,
  normalizeTerminalThemeSelection,
  parseCustomTerminalThemes,
  parseTerminalThemeSelection,
  resolveTerminalTheme,
  resolveTerminalThemeDefinition,
  serializeCustomTerminalThemes,
  serializeTerminalThemeSelection,
  terminalColorToHex,
  terminalThemeFor,
} from "./terminalThemes";

describe("terminal themes", () => {
  test("preserves explicit backgrounds when Herdr elides repeated SGR", async () => {
    const term = new Terminal({ allowProposedApi: true, cols: 120, rows: 3 });
    try {
      const frame =
        "\x1b[0;39;48;2;40;44;52mA" +
        " ".repeat(100) +
        "\x1b[0;38;2;255;255;255;48;2;80;0;0m X";
      await new Promise<void>((resolve) => term.write(frame, resolve));
      for (const theme of ["light", "dark"] as const) {
        applyTerminalTheme(term, terminalThemeFor(theme));
        const line = term.buffer.active.getLine(0)!;
        expect(line.getCell(100)?.getBgColor()).toBe(0x282c34);
        expect(line.getCell(101)?.getBgColor()).toBe(0x500000);
        expect(line.getCell(102)?.getChars()).toBe("X");
        expect(term.options.theme?.background).toBe(
          terminalThemeFor(theme).background,
        );
      }
    } finally {
      term.dispose();
    }
  });

  test("leaves RGB components and indexed colors to xterm's parser", async () => {
    const term = new Terminal({ allowProposedApi: true });
    try {
      for (const theme of ["light", "dark"] as const) {
        applyTerminalTheme(term, terminalThemeFor(theme));
        await new Promise<void>((resolve) =>
          term.write(
            "\x1b[H\x1b[0;38;2;48;2;200;48;2;40;44;52mX" +
              "\x1b[38;5;208;48;5;17mY",
            resolve,
          ),
        );
        const line = term.buffer.active.getLine(0)!;
        expect(line.getCell(0)?.getFgColor()).toBe(0x3002c8);
        expect(line.getCell(0)?.getBgColor()).toBe(0x282c34);
        expect(line.getCell(1)?.getFgColor()).toBe(208);
        expect(line.getCell(1)?.getBgColor()).toBe(17);
      }
    } finally {
      term.dispose();
    }
  });
});

describe("terminal theme presets", () => {
  test("have unique ids and valid colors", () => {
    const ids = new Set<string>();
    for (const preset of TERMINAL_THEME_PRESETS) {
      expect(ids.has(preset.id)).toBe(false);
      ids.add(preset.id);
      expect(preset.name.length).toBeGreaterThan(0);
      expect(preset.builtin).toBe(true);
      expect(preset.theme.background).toMatch(/^#/);
      expect(preset.theme.foreground).toMatch(/^#/);
    }
  });

  test("keep Roamgate Dark and Roamgate Light as the per-mode defaults", () => {
    for (const mode of ["dark", "light"] as const) {
      expect(defaultTerminalThemeId(mode)).toBe(`herdr-${mode}`);
      const preset = TERMINAL_THEME_PRESETS.find(
        (preset) => preset.id === defaultTerminalThemeId(mode),
      );
      expect(preset?.theme).toEqual(terminalThemeFor(mode));
    }
    expect(terminalThemeFor("dark").background).toBe("#0b0d12");
    expect(terminalThemeFor("dark").red).toBeUndefined();
    expect(terminalThemeFor("light").background).toBe("#f6f7f9");
    expect(terminalThemeFor("light").red).toBe("#cf222e");
  });

  test("include both dark and light variants beyond the defaults", () => {
    const dark = TERMINAL_THEME_PRESETS.filter(
      (preset) => preset.variant === "dark",
    );
    const light = TERMINAL_THEME_PRESETS.filter(
      (preset) => preset.variant === "light",
    );
    expect(dark.length).toBeGreaterThan(1);
    expect(light.length).toBeGreaterThan(1);
  });
});

describe("custom terminal themes", () => {
  test("persists every theme at capacity, including a selected replacement in the freed slot", () => {
    const full = Array.from(
      { length: MAX_CUSTOM_TERMINAL_THEMES },
      (_, index) => ({
        id: `custom-${index}`,
        name: `Custom ${index}`,
        variant: "dark" as const,
        colors: { background: "#000000", foreground: "#ffffff" },
      }),
    );
    expect(
      parseCustomTerminalThemes(serializeCustomTerminalThemes(full)),
    ).toEqual(full);
    const selected = { ...full[0]!, id: "replacement", name: "Replacement" };
    const replaced = [...full.slice(1), selected];
    const restored = parseCustomTerminalThemes(
      serializeCustomTerminalThemes(replaced),
    );
    expect(restored).toEqual(replaced);
    expect(restored.find((theme) => theme.id === selected.id)).toEqual(
      selected,
    );
  });
  test("round-trip through serialize and parse", () => {
    const themes = [
      {
        id: "custom-1",
        name: "My Theme",
        variant: "dark" as const,
        colors: {
          background: "#101010",
          foreground: "#eeeeee",
          red: "#ff0000",
        },
      },
    ];
    expect(
      parseCustomTerminalThemes(serializeCustomTerminalThemes(themes)),
    ).toEqual(themes);
  });

  test("drops invalid entries, normalizes colors, and dedupes ids", () => {
    const themes = normalizeCustomTerminalThemes([
      null,
      {
        id: "ok",
        name: "Ok",
        variant: "dark",
        colors: { background: "#ABC", foreground: "#EEEEEE" },
      },
      {
        id: "ok",
        name: "Dupe",
        variant: "dark",
        colors: { background: "#111111", foreground: "#222222" },
      },
      {
        id: "herdr-dark",
        name: "Preset clash",
        variant: "dark",
        colors: { background: "#111111", foreground: "#222222" },
      },
      {
        id: "no-fg",
        name: "Missing fg",
        variant: "dark",
        colors: { background: "#111111" },
      },
      {
        id: "mixed",
        name: "Mixed",
        variant: "light",
        colors: {
          background: "#fafafa",
          foreground: "#333333",
          red: "red",
          cursor: "#ABCDEF99",
          bogus: "#123456",
        },
      },
    ]);
    expect(themes.map((theme) => theme.id)).toEqual([
      "ok",
      "ok-2",
      "herdr-dark-2",
      "mixed",
    ]);
    expect(themes[0].colors.background).toBe("#aabbcc");
    expect(themes[3].colors.red).toBeUndefined();
    expect(themes[3].colors.cursor).toBe("#abcdef99");
    expect(themes[3].variant).toBe("light");
  });

  test("caps the number of custom themes", () => {
    const many = Array.from(
      { length: MAX_CUSTOM_TERMINAL_THEMES + 5 },
      (_, index) => ({
        id: `theme-${index}`,
        name: `Theme ${index}`,
        variant: "dark",
        colors: { background: "#111111", foreground: "#eeeeee" },
      }),
    );
    expect(normalizeCustomTerminalThemes(many)).toHaveLength(
      MAX_CUSTOM_TERMINAL_THEMES,
    );
  });

  test("parses corrupt storage safely", () => {
    expect(parseCustomTerminalThemes(null)).toEqual([]);
    expect(parseCustomTerminalThemes("{oops")).toEqual([]);
    expect(parseCustomTerminalThemes('{"not":"an array"}')).toEqual([]);
  });

  test("renders selection with translucency", () => {
    const theme = customTerminalThemeToITheme({
      id: "custom-1",
      name: "Mine",
      variant: "dark",
      colors: {
        background: "#101010",
        foreground: "#eeeeee",
        selectionBackground: "#3388ff",
      },
    });
    expect(theme.selectionBackground).toBe(
      `rgba(51,136,255,${CUSTOM_TERMINAL_THEME_SELECTION_ALPHA})`,
    );
    expect(theme.background).toBe("#101010");
  });
});

describe("terminal theme selection", () => {
  test("falls back to per-mode defaults for missing or invalid values", () => {
    expect(parseTerminalThemeSelection(null)).toEqual({
      dark: "herdr-dark",
      light: "herdr-light",
    });
    expect(parseTerminalThemeSelection("{oops")).toEqual({
      dark: "herdr-dark",
      light: "herdr-light",
    });
    expect(
      normalizeTerminalThemeSelection({ dark: 42, light: "dracula" }),
    ).toEqual({
      dark: "herdr-dark",
      light: "dracula",
    });
  });

  test("round-trips through serialize and parse", () => {
    const selection = { dark: "nord", light: "solarized-light" };
    expect(
      parseTerminalThemeSelection(serializeTerminalThemeSelection(selection)),
    ).toEqual(selection);
  });

  test("resolves presets and custom themes per mode with default fallback", () => {
    const custom = normalizeCustomTerminalThemes([
      {
        id: "custom-1",
        name: "Mine",
        variant: "dark",
        colors: { background: "#101010", foreground: "#eeeeee" },
      },
    ]);
    expect(
      resolveTerminalTheme(
        "dark",
        { dark: "dracula", light: "github-light" },
        [],
      ).background,
    ).toBe("#282a36");
    expect(
      resolveTerminalTheme(
        "dark",
        { dark: "custom-1", light: "herdr-light" },
        custom,
      ).background,
    ).toBe("#101010");
    // Unknown id (e.g. a deleted custom theme) falls back to the mode default.
    expect(
      resolveTerminalTheme("light", { dark: "custom-1", light: "gone" }, custom)
        .background,
    ).toBe("#f6f7f9");
    expect(
      resolveTerminalThemeDefinition(
        "light",
        { dark: "custom-1", light: "gone" },
        custom,
      ).id,
    ).toBe("herdr-light");
  });
});

describe("terminal color helpers", () => {
  test("normalizeTerminalColor accepts hex and expands shorthand", () => {
    expect(normalizeTerminalColor("#ABC")).toBe("#aabbcc");
    expect(normalizeTerminalColor(" #12AB34 ")).toBe("#12ab34");
    expect(normalizeTerminalColor("#12ab34cd")).toBe("#12ab34cd");
    expect(normalizeTerminalColor("red")).toBeNull();
    expect(normalizeTerminalColor("rgba(1,2,3,0.5)")).toBeNull();
    expect(normalizeTerminalColor(42)).toBeNull();
  });

  test("hexToRgba converts hex channels", () => {
    expect(hexToRgba("#3388ff", 0.3)).toBe("rgba(51,136,255,0.3)");
    expect(hexToRgba("#38f", 0.5)).toBe("rgba(51,136,255,0.5)");
  });

  test("terminalColorToHex extracts hex from presets and rgba", () => {
    expect(terminalColorToHex("#ABCDEF")).toBe("#abcdef");
    expect(terminalColorToHex("rgba(110,168,255,0.3)")).toBe("#6ea8ff");
    expect(terminalColorToHex(undefined)).toBe("");
    expect(terminalColorToHex("not-a-color")).toBe("");
  });
});

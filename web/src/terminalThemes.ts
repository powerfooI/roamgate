import type { ITheme, Terminal } from "@xterm/xterm";
import type { ResolvedTheme } from "./appearance";

export const TERMINAL_THEME_SELECTION_STORAGE_KEY = "terminalThemeSelection.v1";
export const CUSTOM_TERMINAL_THEMES_STORAGE_KEY = "customTerminalThemes.v1";
export const MAX_CUSTOM_TERMINAL_THEMES = 24;
export const MAX_TERMINAL_THEME_NAME_LENGTH = 40;
export const CUSTOM_TERMINAL_THEME_SELECTION_ALPHA = 0.3;

// Dark keeps the historical palette exactly: only background, foreground,
// cursor, and selection are overridden; ANSI colors stay at xterm defaults.
const DARK_TERMINAL_THEME: ITheme = {
  background: "#0b0d12",
  foreground: "#c9cdd6",
  cursor: "#c9cdd6",
  overviewRulerBorder: "rgba(0,0,0,0)",
  selectionBackground: "rgba(110,168,255,0.3)",
};

// The default dark terminal on a black background, for the app's black
// background option.
const BLACK_TERMINAL_THEME: ITheme = {
  ...DARK_TERMINAL_THEME,
  background: "#000000",
  foreground: "#d4d4d4",
  cursor: "#d4d4d4",
  selectionBackground: "rgba(255,255,255,0.22)",
};

// Light mode needs the full 16-color ANSI palette: the dark-oriented default
// palette (bright blues, greens, yellows) is unreadable on a light background.
const LIGHT_TERMINAL_THEME: ITheme = {
  background: "#f6f7f9",
  foreground: "#2b3245",
  cursor: "#2b3245",
  overviewRulerBorder: "rgba(0,0,0,0)",
  selectionBackground: "rgba(46,125,233,0.25)",
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#7d4e00",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#9a6700",
  brightBlue: "#0550ae",
  brightMagenta: "#6639ba",
  brightCyan: "#0a6b74",
  brightWhite: "#8c959f",
};

export type TerminalThemeDefinition = {
  id: string;
  name: string;
  variant: ResolvedTheme;
  builtin: boolean;
  theme: ITheme;
};

export type TerminalThemeSelection = {
  dark: string;
  light: string;
};

const NO_RULER_BORDER = "rgba(0,0,0,0)";

export const TERMINAL_THEME_PRESETS: readonly TerminalThemeDefinition[] = [
  {
    // Persisted preset IDs stay stable for existing theme selections/exports.
    id: "herdr-dark",
    name: "Roamgate Dark",
    variant: "dark",
    builtin: true,
    theme: DARK_TERMINAL_THEME,
  },
  {
    id: "roamgate-black",
    name: "Roamgate Black",
    variant: "dark",
    builtin: true,
    theme: BLACK_TERMINAL_THEME,
  },
  {
    id: "herdr-light",
    name: "Roamgate Light",
    variant: "light",
    builtin: true,
    theme: LIGHT_TERMINAL_THEME,
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    variant: "dark",
    builtin: true,
    theme: {
      background: "#002b36",
      foreground: "#839496",
      cursor: "#839496",
      cursorAccent: "#002b36",
      overviewRulerBorder: NO_RULER_BORDER,
      selectionBackground: "rgba(88,110,117,0.35)",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#002b36",
      brightRed: "#cb4b16",
      brightGreen: "#586e75",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    variant: "dark",
    builtin: true,
    theme: {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#f8f8f2",
      cursorAccent: "#282a36",
      overviewRulerBorder: NO_RULER_BORDER,
      selectionBackground: "rgba(68,71,90,0.6)",
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
      brightBlack: "#6272a4",
      brightRed: "#ff6e6e",
      brightGreen: "#69ff94",
      brightYellow: "#ffffa5",
      brightBlue: "#d6acff",
      brightMagenta: "#ff92df",
      brightCyan: "#a4ffff",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "one-dark",
    name: "One Dark",
    variant: "dark",
    builtin: true,
    theme: {
      background: "#282c34",
      foreground: "#abb2bf",
      cursor: "#528bff",
      cursorAccent: "#282c34",
      overviewRulerBorder: NO_RULER_BORDER,
      selectionBackground: "rgba(62,68,81,0.9)",
      black: "#3f4451",
      red: "#e06c75",
      green: "#98c379",
      yellow: "#d19a66",
      blue: "#61afef",
      magenta: "#c678dd",
      cyan: "#56b6c2",
      white: "#abb2bf",
      brightBlack: "#5c6370",
      brightRed: "#e06c75",
      brightGreen: "#98c379",
      brightYellow: "#d19a66",
      brightBlue: "#61afef",
      brightMagenta: "#c678dd",
      brightCyan: "#56b6c2",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "nord",
    name: "Nord",
    variant: "dark",
    builtin: true,
    theme: {
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#d8dee9",
      cursorAccent: "#2e3440",
      overviewRulerBorder: NO_RULER_BORDER,
      selectionBackground: "rgba(67,76,94,0.7)",
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
      brightBlack: "#4c566a",
      brightRed: "#bf616a",
      brightGreen: "#a3be8c",
      brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1",
      brightMagenta: "#b48ead",
      brightCyan: "#8fbcbb",
      brightWhite: "#eceff4",
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    variant: "dark",
    builtin: true,
    theme: {
      background: "#1a1b26",
      foreground: "#c0caf5",
      cursor: "#c0caf5",
      cursorAccent: "#1a1b26",
      overviewRulerBorder: NO_RULER_BORDER,
      selectionBackground: "rgba(51,70,124,0.6)",
      black: "#15161e",
      red: "#f7768e",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#7dcfff",
      white: "#a9b1d6",
      brightBlack: "#414868",
      brightRed: "#f7768e",
      brightGreen: "#9ece6a",
      brightYellow: "#e0af68",
      brightBlue: "#7aa2f7",
      brightMagenta: "#bb9af7",
      brightCyan: "#7dcfff",
      brightWhite: "#c0caf5",
    },
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    variant: "dark",
    builtin: true,
    theme: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      cursorAccent: "#1e1e2e",
      overviewRulerBorder: NO_RULER_BORDER,
      selectionBackground: "rgba(88,91,112,0.5)",
      black: "#45475a",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      magenta: "#f5c2e7",
      cyan: "#94e2d5",
      white: "#bac2de",
      brightBlack: "#585b70",
      brightRed: "#f38ba8",
      brightGreen: "#a6e3a1",
      brightYellow: "#f9e2af",
      brightBlue: "#89b4fa",
      brightMagenta: "#f5c2e7",
      brightCyan: "#94e2d5",
      brightWhite: "#a6adc8",
    },
  },
  {
    id: "github-dark",
    name: "GitHub Dark",
    variant: "dark",
    builtin: true,
    theme: {
      background: "#0d1117",
      foreground: "#e6edf3",
      cursor: "#e6edf3",
      cursorAccent: "#0d1117",
      overviewRulerBorder: NO_RULER_BORDER,
      selectionBackground: "rgba(56,139,253,0.4)",
      black: "#484f58",
      red: "#ff7b72",
      green: "#3fb950",
      yellow: "#d29922",
      blue: "#58a6ff",
      magenta: "#bc8cff",
      cyan: "#39c5cf",
      white: "#b1bac4",
      brightBlack: "#6e7681",
      brightRed: "#ffa198",
      brightGreen: "#56d364",
      brightYellow: "#e3b341",
      brightBlue: "#79c0ff",
      brightMagenta: "#d2a8ff",
      brightCyan: "#56d4dd",
      brightWhite: "#f0f6fc",
    },
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    variant: "light",
    builtin: true,
    theme: {
      background: "#fdf6e3",
      foreground: "#657b83",
      cursor: "#657b83",
      cursorAccent: "#fdf6e3",
      overviewRulerBorder: NO_RULER_BORDER,
      selectionBackground: "rgba(238,232,213,0.9)",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#002b36",
      brightRed: "#cb4b16",
      brightGreen: "#93a1a1",
      brightYellow: "#839496",
      brightBlue: "#657b83",
      brightMagenta: "#6c71c4",
      brightCyan: "#586e75",
      brightWhite: "#fdf6e3",
    },
  },
  {
    id: "github-light",
    name: "GitHub Light",
    variant: "light",
    builtin: true,
    theme: {
      background: "#ffffff",
      foreground: "#1f2328",
      cursor: "#1f2328",
      cursorAccent: "#ffffff",
      overviewRulerBorder: NO_RULER_BORDER,
      selectionBackground: "rgba(9,105,218,0.2)",
      black: "#24292f",
      red: "#cf222e",
      green: "#116329",
      yellow: "#4d2d00",
      blue: "#0969da",
      magenta: "#8250df",
      cyan: "#1b7c83",
      white: "#6e7781",
      brightBlack: "#57606a",
      brightRed: "#a40e26",
      brightGreen: "#1a7f37",
      brightYellow: "#9a6700",
      brightBlue: "#218bff",
      brightMagenta: "#a475f9",
      brightCyan: "#3192aa",
      brightWhite: "#8c959f",
    },
  },
  {
    id: "one-light",
    name: "One Light",
    variant: "light",
    builtin: true,
    theme: {
      background: "#fafafa",
      foreground: "#383a42",
      cursor: "#526eff",
      cursorAccent: "#fafafa",
      overviewRulerBorder: NO_RULER_BORDER,
      selectionBackground: "rgba(56,58,66,0.12)",
      black: "#383a42",
      red: "#e45649",
      green: "#50a14f",
      yellow: "#c18401",
      blue: "#0184bc",
      magenta: "#a626a4",
      cyan: "#0997b3",
      white: "#a0a1a7",
      brightBlack: "#696c77",
      brightRed: "#e45649",
      brightGreen: "#50a14f",
      brightYellow: "#c18401",
      brightBlue: "#0184bc",
      brightMagenta: "#a626a4",
      brightCyan: "#0997b3",
      brightWhite: "#d3d3d3",
    },
  },
];

export const TERMINAL_ANSI_COLOR_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

export const TERMINAL_BASE_COLOR_KEYS = [
  "background",
  "foreground",
  "cursor",
  "cursorAccent",
  "selectionBackground",
] as const;

export type TerminalThemeColorKey =
  | (typeof TERMINAL_BASE_COLOR_KEYS)[number]
  | (typeof TERMINAL_ANSI_COLOR_KEYS)[number];

const TERMINAL_THEME_COLOR_KEYS: readonly TerminalThemeColorKey[] = [
  ...TERMINAL_BASE_COLOR_KEYS,
  ...TERMINAL_ANSI_COLOR_KEYS,
];

export type CustomTerminalTheme = {
  id: string;
  name: string;
  variant: ResolvedTheme;
  colors: Partial<Record<TerminalThemeColorKey, string>>;
};

const presetById = new Map(
  TERMINAL_THEME_PRESETS.map((preset) => [preset.id, preset]),
);

export function defaultTerminalThemeId(variant: ResolvedTheme): string {
  return variant === "light" ? "herdr-light" : "herdr-dark";
}

export function terminalThemeFor(resolvedTheme: ResolvedTheme): ITheme {
  return resolvedTheme === "light" ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME;
}

export function normalizeTerminalColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(trimmed)) {
    return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`;
  }
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(trimmed)) return trimmed;
  return null;
}

export function hexToRgba(hex: string, alpha: number): string {
  const normalized = normalizeTerminalColor(hex);
  if (!normalized) return hex;
  const red = Number.parseInt(normalized.slice(1, 3), 16);
  const green = Number.parseInt(normalized.slice(3, 5), 16);
  const blue = Number.parseInt(normalized.slice(5, 7), 16);
  return `rgba(${red},${green},${blue},${alpha})`;
}

// Native color inputs and most palette sources work in hex; rgba() presets keep
// only their RGB channels when a user duplicates them into a custom theme.
export function terminalColorToHex(value: string | undefined): string {
  if (!value) return "";
  const hex = normalizeTerminalColor(value);
  if (hex) return hex.slice(0, 7);
  const rgba = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(
    value.trim(),
  );
  if (!rgba) return "";
  const channel = (raw: string) =>
    Math.min(255, Number.parseInt(raw, 10)).toString(16).padStart(2, "0");
  return `#${channel(rgba[1])}${channel(rgba[2])}${channel(rgba[3])}`;
}

export function customTerminalThemeToITheme(
  custom: CustomTerminalTheme,
): ITheme {
  const theme: ITheme = { overviewRulerBorder: NO_RULER_BORDER };
  for (const key of TERMINAL_THEME_COLOR_KEYS) {
    const value = custom.colors[key];
    if (!value) continue;
    theme[key] =
      key === "selectionBackground"
        ? hexToRgba(value, CUSTOM_TERMINAL_THEME_SELECTION_ALPHA)
        : value;
  }
  return theme;
}

function normalizeThemeName(value: unknown): string {
  if (typeof value !== "string") return "Custom theme";
  const clipped = Array.from(value.trim())
    .slice(0, MAX_TERMINAL_THEME_NAME_LENGTH)
    .join("");
  return clipped || "Custom theme";
}

function normalizeCustomThemeId(
  value: unknown,
  index: number,
  usedIds: Set<string>,
): string {
  const requested =
    typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value)
      ? value
      : `custom-theme-${index + 1}`;
  let id = requested;
  let suffix = 2;
  while (usedIds.has(id) || presetById.has(id)) {
    id = `${requested}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(id);
  return id;
}

export function normalizeCustomTerminalTheme(
  value: unknown,
  index: number,
  usedIds: Set<string>,
): CustomTerminalTheme | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const rawColors =
    raw.colors && typeof raw.colors === "object"
      ? (raw.colors as Record<string, unknown>)
      : null;
  if (!rawColors) return null;
  const colors: Partial<Record<TerminalThemeColorKey, string>> = {};
  for (const key of TERMINAL_THEME_COLOR_KEYS) {
    const color = normalizeTerminalColor(rawColors[key]);
    if (color) colors[key] = color;
  }
  // A theme without background and foreground cannot render legibly.
  if (!colors.background || !colors.foreground) return null;
  return {
    id: normalizeCustomThemeId(raw.id, index, usedIds),
    name: normalizeThemeName(raw.name),
    variant: raw.variant === "light" ? "light" : "dark",
    colors,
  };
}

export function normalizeCustomTerminalThemes(
  value: unknown,
): CustomTerminalTheme[] {
  if (!Array.isArray(value)) return [];
  const usedIds = new Set<string>();
  const themes: CustomTerminalTheme[] = [];
  for (
    let index = 0;
    index < Math.min(value.length, MAX_CUSTOM_TERMINAL_THEMES);
    index += 1
  ) {
    const theme = normalizeCustomTerminalTheme(value[index], index, usedIds);
    if (theme) themes.push(theme);
  }
  return themes;
}

export function parseCustomTerminalThemes(
  raw: string | null,
): CustomTerminalTheme[] {
  if (!raw) return [];
  try {
    return normalizeCustomTerminalThemes(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function serializeCustomTerminalThemes(
  themes: CustomTerminalTheme[],
): string {
  return JSON.stringify(normalizeCustomTerminalThemes(themes));
}

export function normalizeTerminalThemeSelection(
  value: unknown,
): TerminalThemeSelection {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    dark:
      typeof raw.dark === "string" && raw.dark
        ? raw.dark
        : defaultTerminalThemeId("dark"),
    light:
      typeof raw.light === "string" && raw.light
        ? raw.light
        : defaultTerminalThemeId("light"),
  };
}

export function parseTerminalThemeSelection(
  raw: string | null,
): TerminalThemeSelection {
  if (!raw) return normalizeTerminalThemeSelection(null);
  try {
    return normalizeTerminalThemeSelection(JSON.parse(raw));
  } catch {
    return normalizeTerminalThemeSelection(null);
  }
}

export function serializeTerminalThemeSelection(
  selection: TerminalThemeSelection,
): string {
  return JSON.stringify(normalizeTerminalThemeSelection(selection));
}

export function terminalThemeById(
  id: string,
  customThemes: CustomTerminalTheme[],
): TerminalThemeDefinition | null {
  const preset = presetById.get(id);
  if (preset) return preset;
  const custom = customThemes.find((theme) => theme.id === id);
  if (!custom) return null;
  return {
    id: custom.id,
    name: custom.name,
    variant: custom.variant,
    builtin: false,
    theme: customTerminalThemeToITheme(custom),
  };
}

export function resolveTerminalThemeDefinition(
  resolvedTheme: ResolvedTheme,
  selection: TerminalThemeSelection,
  customThemes: CustomTerminalTheme[],
): TerminalThemeDefinition {
  const selected = terminalThemeById(selection[resolvedTheme], customThemes);
  if (selected) return selected;
  const fallback = presetById.get(defaultTerminalThemeId(resolvedTheme));
  if (fallback) return fallback;
  return {
    id: defaultTerminalThemeId(resolvedTheme),
    name: resolvedTheme === "light" ? "Roamgate Light" : "Roamgate Dark",
    variant: resolvedTheme,
    builtin: true,
    theme: terminalThemeFor(resolvedTheme),
  };
}

export function resolveTerminalTheme(
  resolvedTheme: ResolvedTheme,
  selection: TerminalThemeSelection,
  customThemes: CustomTerminalTheme[],
  blackBackground = false,
): ITheme {
  // With a black background, the default dark terminal turns black too; a
  // terminal theme picked by hand is kept.
  if (
    blackBackground &&
    resolvedTheme === "dark" &&
    selection.dark === defaultTerminalThemeId("dark")
  )
    return BLACK_TERMINAL_THEME;
  return resolveTerminalThemeDefinition(resolvedTheme, selection, customThemes)
    .theme;
}

export function applyTerminalTheme(term: Terminal, theme: ITheme) {
  // The ANSI stream does not distinguish Herdr's resolved default background
  // from an application's explicit RGB background. Preserve both; only xterm
  // defaults and its ANSI palette follow the app theme. No repaint/reset is needed.
  term.options.theme = theme;
  term.element?.style.setProperty(
    "--terminal-canvas-foreground",
    theme.foreground ?? "",
  );
  if (theme.background) {
    term.element?.style.setProperty(
      "--terminal-canvas-background",
      theme.background,
    );
  }
}

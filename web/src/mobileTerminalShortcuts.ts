import {
  mobileTerminalKeyCombinationBytes,
  mobileTerminalKeyCombinationLabel,
  type MobileTerminalKeyCombination,
} from "./mobileTerminalKeyCombination";

export const MOBILE_TERMINAL_SHORTCUTS_STORAGE_KEY =
  "mobileTerminalShortcuts.v2";
export const LEGACY_MOBILE_TERMINAL_SHORTCUTS_STORAGE_KEY =
  "mobileTerminalShortcuts.v1";
export const MAX_MOBILE_TERMINAL_SHORTCUT_ROWS = 2;
export const MAX_MOBILE_TERMINAL_SHORTCUTS_PER_ROW = 8;
export const MAX_MOBILE_TERMINAL_SHORTCUT_LABEL_LENGTH = 10;
export const MOBILE_TERMINAL_SIDE_SHORTCUTS_STORAGE_KEY =
  "mobileTerminalSideShortcuts.v1";
export const MAX_MOBILE_TERMINAL_SIDE_SHORTCUTS = 4;

type MobileTerminalShortcutOptionDefinition = {
  id: string;
  label: string;
  defaultButtonLabel: string;
  group: "Control" | "Basic" | "Navigation" | "Modified";
  bytes?: readonly number[];
  scroll?: {
    direction: "up" | "down";
    amount: "full" | "half";
  };
};

export const MOBILE_TERMINAL_SHORTCUT_OPTIONS = [
  {
    id: "ctrl-a",
    label: "Ctrl+A",
    defaultButtonLabel: "C-a",
    group: "Control",
    bytes: [0x01],
  },
  {
    id: "ctrl-b",
    label: "Ctrl+B",
    defaultButtonLabel: "C-b",
    group: "Control",
    bytes: [0x02],
  },
  {
    id: "ctrl-c",
    label: "Ctrl+C",
    defaultButtonLabel: "C-c",
    group: "Control",
    bytes: [0x03],
  },
  {
    id: "ctrl-d",
    label: "Ctrl+D",
    defaultButtonLabel: "C-d",
    group: "Control",
    bytes: [0x04],
  },
  {
    id: "ctrl-e",
    label: "Ctrl+E",
    defaultButtonLabel: "C-e",
    group: "Control",
    bytes: [0x05],
  },
  {
    id: "ctrl-f",
    label: "Ctrl+F",
    defaultButtonLabel: "C-f",
    group: "Control",
    bytes: [0x06],
  },
  {
    id: "ctrl-k",
    label: "Ctrl+K",
    defaultButtonLabel: "C-k",
    group: "Control",
    bytes: [0x0b],
  },
  {
    id: "ctrl-l",
    label: "Ctrl+L",
    defaultButtonLabel: "C-l",
    group: "Control",
    bytes: [0x0c],
  },
  {
    id: "ctrl-n",
    label: "Ctrl+N",
    defaultButtonLabel: "C-n",
    group: "Control",
    bytes: [0x0e],
  },
  {
    id: "ctrl-p",
    label: "Ctrl+P",
    defaultButtonLabel: "C-p",
    group: "Control",
    bytes: [0x10],
  },
  {
    id: "ctrl-r",
    label: "Ctrl+R",
    defaultButtonLabel: "C-R",
    group: "Control",
    bytes: [0x12],
  },
  {
    id: "ctrl-u",
    label: "Ctrl+U",
    defaultButtonLabel: "C-u",
    group: "Control",
    bytes: [0x15],
  },
  {
    id: "ctrl-w",
    label: "Ctrl+W",
    defaultButtonLabel: "C-w",
    group: "Control",
    bytes: [0x17],
  },
  {
    id: "ctrl-x",
    label: "Ctrl+X",
    defaultButtonLabel: "C-x",
    group: "Control",
    bytes: [0x18],
  },
  {
    id: "ctrl-z",
    label: "Ctrl+Z",
    defaultButtonLabel: "C-z",
    group: "Control",
    bytes: [0x1a],
  },
  {
    id: "escape",
    label: "Escape",
    defaultButtonLabel: "Esc",
    group: "Basic",
    bytes: [0x1b],
  },
  {
    id: "tab",
    label: "Tab",
    defaultButtonLabel: "Tab",
    group: "Basic",
    bytes: [0x09],
  },
  {
    id: "enter",
    label: "Enter",
    defaultButtonLabel: "Enter",
    group: "Basic",
    bytes: [0x0d],
  },
  {
    id: "backspace",
    label: "Backspace",
    defaultButtonLabel: "Bksp",
    group: "Basic",
    bytes: [0x7f],
  },
  {
    id: "delete",
    label: "Delete",
    defaultButtonLabel: "Del",
    group: "Basic",
    bytes: [0x1b, 0x5b, 0x33, 0x7e],
  },
  {
    id: "arrow-up",
    label: "Arrow Up",
    defaultButtonLabel: "▲",
    group: "Navigation",
    bytes: [0x1b, 0x5b, 0x41],
  },
  {
    id: "arrow-down",
    label: "Arrow Down",
    defaultButtonLabel: "▼",
    group: "Navigation",
    bytes: [0x1b, 0x5b, 0x42],
  },
  {
    id: "arrow-right",
    label: "Arrow Right",
    defaultButtonLabel: "▶",
    group: "Navigation",
    bytes: [0x1b, 0x5b, 0x43],
  },
  {
    id: "arrow-left",
    label: "Arrow Left",
    defaultButtonLabel: "◀",
    group: "Navigation",
    bytes: [0x1b, 0x5b, 0x44],
  },
  {
    id: "home",
    label: "Home",
    defaultButtonLabel: "Home",
    group: "Navigation",
    bytes: [0x1b, 0x5b, 0x48],
  },
  {
    id: "end",
    label: "End",
    defaultButtonLabel: "End",
    group: "Navigation",
    bytes: [0x1b, 0x5b, 0x46],
  },
  {
    id: "page-up",
    label: "Page Up (application or shell history)",
    defaultButtonLabel: "PgUp",
    group: "Navigation",
    scroll: { direction: "up", amount: "full" },
  },
  {
    id: "page-down",
    label: "Page Down (application or shell history)",
    defaultButtonLabel: "PgDn",
    group: "Navigation",
    scroll: { direction: "down", amount: "full" },
  },
  {
    id: "alt-up",
    label: "Alt+Up",
    defaultButtonLabel: "A-Up",
    group: "Modified",
    bytes: [0x1b, 0x5b, 0x31, 0x3b, 0x33, 0x41],
  },
  {
    id: "alt-down",
    label: "Alt+Down",
    defaultButtonLabel: "A-Down",
    group: "Modified",
    bytes: [0x1b, 0x5b, 0x31, 0x3b, 0x33, 0x42],
  },
  {
    id: "alt-right",
    label: "Alt+Right",
    defaultButtonLabel: "A-Right",
    group: "Modified",
    bytes: [0x1b, 0x5b, 0x31, 0x3b, 0x33, 0x43],
  },
  {
    id: "alt-left",
    label: "Alt+Left",
    defaultButtonLabel: "A-Left",
    group: "Modified",
    bytes: [0x1b, 0x5b, 0x31, 0x3b, 0x33, 0x44],
  },
  {
    id: "alt-page-up",
    label: "Alt+Page Up (half scrollback)",
    defaultButtonLabel: "A-PgUp",
    group: "Modified",
    scroll: { direction: "up", amount: "half" },
  },
  {
    id: "alt-page-down",
    label: "Alt+Page Down (half scrollback)",
    defaultButtonLabel: "A-PgDn",
    group: "Modified",
    scroll: { direction: "down", amount: "half" },
  },
  {
    id: "shift-enter",
    label: "Shift+Enter",
    defaultButtonLabel: "S-Enter",
    group: "Modified",
    bytes: [0x1b, 0x5b, 0x31, 0x33, 0x3b, 0x32, 0x75],
  },
  {
    id: "alt-enter",
    label: "Alt+Enter",
    defaultButtonLabel: "A-Enter",
    group: "Modified",
    bytes: [0x1b, 0x5b, 0x31, 0x33, 0x3b, 0x33, 0x75],
  },
] as const satisfies readonly MobileTerminalShortcutOptionDefinition[];

type MobileTerminalPresetAction =
  (typeof MOBILE_TERMINAL_SHORTCUT_OPTIONS)[number]["id"];
export type MobileTerminalShortcutAction =
  | MobileTerminalPresetAction
  | MobileTerminalKeyCombination;

export type MobileTerminalShortcut = {
  id: string;
  label: string;
  action: MobileTerminalShortcutAction;
};

export type MobileTerminalShortcutSlot = MobileTerminalShortcut | null;

export type MobileTerminalShortcutRows = [
  MobileTerminalShortcutSlot[],
  MobileTerminalShortcutSlot[],
];

export type MobileTerminalSideShortcuts = MobileTerminalShortcutSlot[];

const optionById = new Map<
  MobileTerminalPresetAction,
  MobileTerminalShortcutOptionDefinition
>(MOBILE_TERMINAL_SHORTCUT_OPTIONS.map((option) => [option.id, option]));

const defaultRows: MobileTerminalShortcutRows = [
  [
    { id: "default-ctrl-c", label: "C-c", action: "ctrl-c" },
    { id: "default-ctrl-d", label: "C-d", action: "ctrl-d" },
    { id: "default-ctrl-r", label: "C-R", action: "ctrl-r" },
    { id: "default-alt-up", label: "A-Up", action: "alt-up" },
    null,
    { id: "default-arrow-up", label: "▲", action: "arrow-up" },
    null,
    { id: "default-page-up", label: "PgUp", action: "page-up" },
  ],
  [
    { id: "default-escape", label: "Esc", action: "escape" },
    { id: "default-tab", label: "Tab", action: "tab" },
    { id: "default-enter", label: "Enter", action: "enter" },
    { id: "default-backspace", label: "Bksp", action: "backspace" },
    { id: "default-arrow-left", label: "◀", action: "arrow-left" },
    { id: "default-arrow-down", label: "▼", action: "arrow-down" },
    { id: "default-arrow-right", label: "▶", action: "arrow-right" },
    { id: "default-page-down", label: "PgDn", action: "page-down" },
  ],
];

export function defaultMobileTerminalShortcutRows(): MobileTerminalShortcutRows {
  return defaultRows.map((row) =>
    row.map((shortcut) => (shortcut ? { ...shortcut } : null)),
  ) as MobileTerminalShortcutRows;
}

/** The defaults before Backspace joined the second row. */
function previousDefaultRows(): MobileTerminalShortcutRows {
  const rows = defaultMobileTerminalShortcutRows();
  rows[1][3] = null;
  return rows;
}

export function defaultMobileTerminalSideShortcuts(): MobileTerminalSideShortcuts {
  return Array<MobileTerminalShortcutSlot>(
    MAX_MOBILE_TERMINAL_SIDE_SHORTCUTS,
  ).fill(null);
}

export function mobileTerminalShortcutOption(
  action: MobileTerminalShortcutAction,
): MobileTerminalShortcutOptionDefinition | null {
  if (typeof action === "string") return optionById.get(action) ?? null;
  const bytes = mobileTerminalKeyCombinationBytes(action);
  const label = mobileTerminalKeyCombinationLabel(action);
  return {
    id: "custom",
    label,
    defaultButtonLabel: clipLabel(
      label
        .replace(/(trl|lt|hift)\+/g, "-")
        .replace("Arrow", "")
        .replace("Page", "Pg")
        .replace("Down", "Dn"),
    ),
    group: "Modified",
    bytes,
  };
}

export function mobileTerminalShortcutBytes(
  action: MobileTerminalShortcutAction,
): number[] {
  return [...(mobileTerminalShortcutOption(action)?.bytes ?? [])];
}

export function mobileTerminalShortcutScroll(
  action: MobileTerminalShortcutAction,
): { direction: "up" | "down"; amount: "full" | "half" } | null {
  const scroll = mobileTerminalShortcutOption(action)?.scroll;
  return scroll ? { ...scroll } : null;
}

function clipLabel(value: string): string {
  return Array.from(value.trim())
    .slice(0, MAX_MOBILE_TERMINAL_SHORTCUT_LABEL_LENGTH)
    .join("");
}

function normalizeAction(value: unknown): MobileTerminalShortcutAction | null {
  if (typeof value === "string") {
    return optionById.has(value as MobileTerminalPresetAction)
      ? (value as MobileTerminalPresetAction)
      : null;
  }
  if (!mobileTerminalKeyCombinationBytes(value).length) return null;
  const { key, ctrl, alt, shift } = value as MobileTerminalKeyCombination;
  return { key, ctrl, alt, shift };
}

function normalizedId(
  value: unknown,
  rowIndex: number,
  itemIndex: number,
  usedIds: Set<string>,
): string {
  const requested =
    typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value)
      ? value
      : `shortcut-${rowIndex + 1}-${itemIndex + 1}`;
  let id = requested;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${requested}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(id);
  return id;
}

export function normalizeMobileTerminalShortcutRows(
  value: unknown,
): MobileTerminalShortcutRows {
  if (!Array.isArray(value)) return defaultMobileTerminalShortcutRows();
  const rows: MobileTerminalShortcutRows = [
    Array<MobileTerminalShortcutSlot>(
      MAX_MOBILE_TERMINAL_SHORTCUTS_PER_ROW,
    ).fill(null),
    Array<MobileTerminalShortcutSlot>(
      MAX_MOBILE_TERMINAL_SHORTCUTS_PER_ROW,
    ).fill(null),
  ];
  const usedIds = new Set<string>();

  for (
    let rowIndex = 0;
    rowIndex < Math.min(value.length, MAX_MOBILE_TERMINAL_SHORTCUT_ROWS);
    rowIndex += 1
  ) {
    const sourceRow = value[rowIndex];
    if (!Array.isArray(sourceRow)) continue;
    let legacySlotIndex = 0;
    const hasExplicitEmptySlots = sourceRow.some(
      (candidate) => candidate === null,
    );
    for (
      let sourceIndex = 0;
      sourceIndex <
      Math.min(sourceRow.length, MAX_MOBILE_TERMINAL_SHORTCUTS_PER_ROW);
      sourceIndex += 1
    ) {
      const candidate = sourceRow[sourceIndex];
      if (!candidate || typeof candidate !== "object") continue;
      const raw = candidate as Record<string, unknown>;
      const action = normalizeAction(raw.action);
      if (!action) continue;
      const option = mobileTerminalShortcutOption(action);
      if (!option) continue;
      const label =
        typeof raw.label === "string" && clipLabel(raw.label)
          ? clipLabel(raw.label)
          : option.defaultButtonLabel;
      const slotIndex = hasExplicitEmptySlots ? sourceIndex : legacySlotIndex;
      legacySlotIndex += 1;
      rows[rowIndex][slotIndex] = {
        id: normalizedId(raw.id, rowIndex, slotIndex, usedIds),
        label,
        action,
      };
    }
  }

  return rows;
}

export function normalizeMobileTerminalSideShortcuts(
  value: unknown,
): MobileTerminalSideShortcuts {
  const shortcuts = defaultMobileTerminalSideShortcuts();
  if (!Array.isArray(value)) return shortcuts;
  const usedIds = new Set<string>();
  for (
    let slotIndex = 0;
    slotIndex < Math.min(value.length, MAX_MOBILE_TERMINAL_SIDE_SHORTCUTS);
    slotIndex += 1
  ) {
    const candidate = value[slotIndex];
    if (!candidate || typeof candidate !== "object") continue;
    const raw = candidate as Record<string, unknown>;
    const action = normalizeAction(raw.action);
    if (!action) continue;
    const option = mobileTerminalShortcutOption(action);
    if (!option) continue;
    shortcuts[slotIndex] = {
      id: normalizedId(raw.id, 2, slotIndex, usedIds),
      label:
        typeof raw.label === "string" && clipLabel(raw.label)
          ? clipLabel(raw.label)
          : option.defaultButtonLabel,
      action,
    };
  }
  return shortcuts;
}

export function parseMobileTerminalSideShortcuts(
  raw: string | null,
): MobileTerminalSideShortcuts {
  if (!raw) return defaultMobileTerminalSideShortcuts();
  try {
    return normalizeMobileTerminalSideShortcuts(JSON.parse(raw));
  } catch {
    return defaultMobileTerminalSideShortcuts();
  }
}

export function serializeMobileTerminalSideShortcuts(
  shortcuts: MobileTerminalSideShortcuts,
): string {
  return JSON.stringify(normalizeMobileTerminalSideShortcuts(shortcuts));
}

export function parseMobileTerminalShortcutRows(
  raw: string | null,
): MobileTerminalShortcutRows {
  if (!raw) return defaultMobileTerminalShortcutRows();
  try {
    const value = JSON.parse(raw);
    if (Array.isArray(value)) {
      const rows = normalizeMobileTerminalShortcutRows(value);
      // Only legacy arrays need the Backspace upgrade. New saves record a
      // version so removing Backspace cannot trigger this migration again.
      return JSON.stringify(rows) === JSON.stringify(previousDefaultRows())
        ? defaultMobileTerminalShortcutRows()
        : rows;
    }
    return value?.version === 1
      ? normalizeMobileTerminalShortcutRows(value.rows)
      : defaultMobileTerminalShortcutRows();
  } catch {
    return defaultMobileTerminalShortcutRows();
  }
}

export function serializeMobileTerminalShortcutRows(
  rows: MobileTerminalShortcutRows,
): string {
  return JSON.stringify({
    version: 1,
    rows: normalizeMobileTerminalShortcutRows(rows),
  });
}

export function mobileTerminalShortcutCount(
  rows: MobileTerminalShortcutRows,
): number {
  return rows.reduce(
    (total, row) => total + row.filter((shortcut) => shortcut !== null).length,
    0,
  );
}

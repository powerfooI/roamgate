import {
  INSPECTOR_MIN_BOTTOM,
  INSPECTOR_MIN_RIGHT,
  INSPECTOR_SEPARATOR_SIZE,
  TERMINAL_MIN_HEIGHT,
  TERMINAL_MIN_WIDTH,
  type InspectorDock,
} from "./workspaceResource";

// The Jira panel docks beside the terminal like the Inspector (AC29): right or
// bottom, with a resizer, and a size per dock kept in this browser.
export type JiraDockPreferences = {
  dock: InspectorDock;
  rightSize: number;
  bottomSize: number;
};

export const JIRA_DOCK_STORAGE_KEY = "jiraPanelDock.v1";
export const JIRA_DOCK_KEYBOARD_STEP = 24;
const DEFAULTS: JiraDockPreferences = {
  dock: "right",
  rightSize: 520,
  bottomSize: 320,
};

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

export function readJiraDock(
  storage: Pick<Storage, "getItem">,
): JiraDockPreferences {
  try {
    const raw = storage.getItem(JIRA_DOCK_STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const value = JSON.parse(raw) as Partial<JiraDockPreferences>;
    return {
      dock: value.dock === "bottom" ? "bottom" : "right",
      rightSize: finite(value.rightSize, DEFAULTS.rightSize),
      bottomSize: finite(value.bottomSize, DEFAULTS.bottomSize),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeJiraDock(
  storage: Pick<Storage, "setItem">,
  value: JiraDockPreferences,
) {
  try {
    storage.setItem(JIRA_DOCK_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Storage can be full or blocked; the dock still works for this page.
  }
}

export function jiraDockSize(value: JiraDockPreferences): number {
  return value.dock === "right" ? value.rightSize : value.bottomSize;
}

/** Keeps the panel and the terminal usable, with the Inspector's limits. */
export function clampJiraDockSize(
  dock: InspectorDock,
  size: number,
  availableWidth: number,
  availableHeight: number,
): number {
  const minimum = dock === "right" ? INSPECTOR_MIN_RIGHT : INSPECTOR_MIN_BOTTOM;
  const maximum =
    dock === "right"
      ? availableWidth - TERMINAL_MIN_WIDTH - INSPECTOR_SEPARATOR_SIZE
      : availableHeight - TERMINAL_MIN_HEIGHT - INSPECTOR_SEPARATOR_SIZE;
  return Math.round(Math.max(minimum, Math.min(maximum, size)));
}

export function withJiraDockSize(
  value: JiraDockPreferences,
  size: number,
): JiraDockPreferences {
  return value.dock === "right"
    ? { ...value, rightSize: size }
    : { ...value, bottomSize: size };
}

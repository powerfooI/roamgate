import { useSyncExternalStore } from "react";
import {
  defaultShortcutBindings,
  detectShortcutPlatform,
  formatShortcut,
  matchesShortcut,
  SHORTCUT_IDS,
  SHORTCUT_PLATFORMS,
  shortcutConflicts,
  validateShortcutKeys,
  type ShortcutBindings,
  type ShortcutEvent,
  type ShortcutId,
  type ShortcutPlatform,
} from "./shortcutBindings";

export const SHORTCUT_STORAGE_KEY = "keyboardShortcuts.v1";
export type ShortcutPreset = {
  id: string;
  name: string;
  base: ShortcutPlatform;
  bindings: ShortcutBindings;
};
export type ShortcutPreferences = {
  version: 1;
  active: string;
  presets: ShortcutPreset[];
};
const defaults: ShortcutPreferences = {
  version: 1,
  active: "auto",
  presets: [],
};
/** Actions added after presets could be saved, in the order they shipped. */
const LATE_SHORTCUT_IDS: ShortcutId[] = [
  "terminal.copy",
  "zen.toggle",
  "pane.zoom",
];
export function validateShortcutPreset(value: unknown): ShortcutPreset {
  if (!value || typeof value !== "object")
    throw new Error("Invalid shortcut preset.");
  const input = value as Partial<ShortcutPreset>;
  if (
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.trim().length > 64
  )
    throw new Error("Preset names must contain 1 to 64 characters.");
  if (
    input.base !== "mac" &&
    input.base !== "windows" &&
    input.base !== "linux"
  )
    throw new Error("Unknown preset platform.");
  if (
    !input.bindings ||
    typeof input.bindings !== "object" ||
    Array.isArray(input.bindings)
  )
    throw new Error("Missing shortcut bindings.");
  if (
    Object.keys(input.bindings).some(
      (id) => !SHORTCUT_IDS.includes(id as ShortcutId),
    )
  )
    throw new Error("This preset contains unknown actions.");
  const bindings = defaultShortcutBindings(input.base);
  for (const id of SHORTCUT_IDS) {
    if (Object.prototype.hasOwnProperty.call(input.bindings, id))
      bindings[id] = validateShortcutKeys(id, input.bindings[id]);
  }
  // Presets saved before an action existed keep their explicit assignments.
  // Only add default keys for the newer action that do not conflict with them,
  // so a stored preset stays loadable instead of being discarded.
  for (const id of LATE_SHORTCUT_IDS) {
    if (Object.prototype.hasOwnProperty.call(input.bindings, id)) continue;
    bindings[id] = bindings[id].filter(
      (key) => shortcutConflicts(id, [key], bindings).length === 0,
    );
  }
  for (const id of SHORTCUT_IDS) {
    if (shortcutConflicts(id, bindings[id], bindings).length)
      throw new Error(`Conflicting shortcuts for ${id}.`);
  }
  return {
    id:
      typeof input.id === "string" && /^custom-[\w-]+$/.test(input.id)
        ? input.id
        : "custom-imported",
    name: input.name.trim(),
    base: input.base,
    bindings,
  };
}
export function parseShortcutPreferences(
  raw: string | null,
): ShortcutPreferences {
  try {
    const input = JSON.parse(raw ?? "null");
    if (input?.version !== 1 || !Array.isArray(input.presets)) return defaults;
    const presets: ShortcutPreset[] = [];
    for (const value of input.presets.slice(0, 32)) {
      try {
        const preset = validateShortcutPreset(value);
        if (!presets.some((item) => item.id === preset.id))
          presets.push(preset);
      } catch {
        /* A malformed preset must not prevent the application opening. */
      }
    }
    const active = [
      "auto",
      "mac",
      "windows",
      "linux",
      ...presets.map((preset) => preset.id),
    ].includes(input.active)
      ? input.active
      : "auto";
    return { version: 1, active, presets };
  } catch {
    return defaults;
  }
}
export function resolveShortcutPreset(
  preferences: ShortcutPreferences,
  platform: ShortcutPlatform,
): ShortcutPreset {
  const custom = preferences.presets.find(
    (preset) => preset.id === preferences.active,
  );
  if (custom) return custom;
  const base =
    preferences.active === "auto"
      ? platform
      : (preferences.active as ShortcutPlatform);
  return {
    id: preferences.active,
    name: SHORTCUT_PLATFORMS[base],
    base,
    bindings: defaultShortcutBindings(base),
  };
}
let platform = detectShortcutPlatform();
let snapshot = {
  preferences: defaults,
  platform,
  preset: resolveShortcutPreset(defaults, platform),
  storageError: "",
};
let initialized = false;
const listeners = new Set<() => void>();
function publish(preferences: ShortcutPreferences, storageError = "") {
  snapshot = {
    preferences,
    platform,
    preset: resolveShortcutPreset(preferences, platform),
    storageError,
  };
  for (const listener of listeners) listener();
}
function read() {
  try {
    return parseShortcutPreferences(localStorage.getItem(SHORTCUT_STORAGE_KEY));
  } catch {
    return defaults;
  }
}
export function initializeShortcutPreferences() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  platform = detectShortcutPlatform();
  publish(read());
  window.addEventListener("storage", (event) => {
    if (event.key === SHORTCUT_STORAGE_KEY || event.key === null)
      publish(read());
  });
}
function save(preferences: ShortcutPreferences) {
  let error = "";
  try {
    localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    error =
      "Browser storage is unavailable. Changes apply only until this page reloads; export a preset to keep them.";
  }
  publish(preferences, error);
}
export function getShortcutSnapshot() {
  initializeShortcutPreferences();
  return snapshot;
}
export function useShortcutPreferences() {
  return useSyncExternalStore(
    (listener) => {
      initializeShortcutPreferences();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getShortcutSnapshot,
    getShortcutSnapshot,
  );
}
export function shortcutMatches(event: ShortcutEvent, id: ShortcutId) {
  return matchesShortcut(event, id, getShortcutSnapshot().preset.bindings);
}
export function shortcutLabel(id: ShortcutId) {
  const { preset, platform } = getShortcutSnapshot();
  return (
    preset.bindings[id]
      .map((key) => formatShortcut(key, platform))
      .join(" / ") || "Unassigned"
  );
}
export function shortcutTitle(label: string, id: ShortcutId) {
  const binding = shortcutLabel(id);
  return binding === "Unassigned" ? label : `${label} (${binding})`;
}
export function selectShortcutPreset(id: string) {
  const { preferences } = getShortcutSnapshot();
  if (
    ![
      "auto",
      "mac",
      "windows",
      "linux",
      ...preferences.presets.map((preset) => preset.id),
    ].includes(id)
  )
    throw new Error("Unknown preset.");
  save({ ...preferences, active: id });
}
export function saveShortcutPreset(
  name: string,
  source = getShortcutSnapshot().preset,
) {
  const { preferences } = getShortcutSnapshot();
  if (preferences.presets.length >= 32)
    throw new Error(
      "Keep up to 32 custom presets. Delete a preset before saving another.",
    );
  const preset = validateShortcutPreset({
    ...source,
    name,
    id: `custom-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`,
  });
  save({
    ...preferences,
    active: preset.id,
    presets: [...preferences.presets, preset],
  });
}
export function updateShortcut(id: ShortcutId, keys: string[]) {
  const { preferences, preset } = getShortcutSnapshot();
  const bindings = { ...preset.bindings, [id]: validateShortcutKeys(id, keys) };
  const updated = validateShortcutPreset({ ...preset, bindings });
  if (!preferences.presets.some((item) => item.id === preset.id)) {
    saveShortcutPreset(`${preset.name} custom`, updated);
    return;
  }
  save({
    ...preferences,
    presets: preferences.presets.map((item) =>
      item.id === preset.id ? updated : item,
    ),
  });
}
export function deleteShortcutPreset(id: string) {
  const { preferences } = getShortcutSnapshot();
  save({
    ...preferences,
    active: preferences.active === id ? "auto" : preferences.active,
    presets: preferences.presets.filter((item) => item.id !== id),
  });
}
export function exportShortcutPreset(preset: ShortcutPreset): string {
  return JSON.stringify(
    { format: "herdr-keybindings", version: 1, preset },
    null,
    2,
  );
}
export function importShortcutPreset(raw: string): ShortcutPreset {
  if (raw.length > 100_000)
    throw new Error("Preset files must be smaller than 100 KB.");
  const input = JSON.parse(raw);
  if (input?.format !== "herdr-keybindings" || input?.version !== 1)
    throw new Error("Use a version 1 Herdr keybindings preset.");
  return validateShortcutPreset(input.preset);
}

export function terminalLinkModifierMatches(
  event: Pick<MouseEvent, "ctrlKey" | "altKey" | "metaKey" | "shiftKey">,
) {
  return shortcutMatches(
    {
      key: "Click",
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
    },
    "terminal.link",
  );
}

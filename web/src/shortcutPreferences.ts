import { useSyncExternalStore } from "react";
import { roamgateLocalStorage, subscribeLocalStorage } from "./browserStorage";
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
  "inspector.expand",
  "annotations.toggle",
  "assistant.toggle",
  "annotations.copy",
  "annotations.prefill",
  "panes.search",
  "plugin.herdrFloat.toggle",
  "terminal.ctrlEnter",
  "pane.moveLeft",
  "pane.moveRight",
  "pane.moveUp",
  "pane.moveDown",
  "terminal.focus",
  "shortcuts.show",
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
/**
 * A preset's bindings are written for one platform, so a selection made on a
 * Mac must not follow the user to a Linux browser and leave them with Cmd
 * combinations that never fire. Such a preset is reported rather than applied,
 * and the browser falls back to its own platform's defaults.
 */
export function shortcutPresetPlatformMismatch(
  preferences: ShortcutPreferences,
  platform: ShortcutPlatform,
): ShortcutPreset | null {
  const custom = preferences.presets.find(
    (preset) => preset.id === preferences.active,
  );
  return custom && custom.base !== platform ? custom : null;
}

export function resolveShortcutPreset(
  preferences: ShortcutPreferences,
  platform: ShortcutPlatform,
): ShortcutPreset {
  const custom = preferences.presets.find(
    (preset) => preset.id === preferences.active,
  );
  if (custom && custom.base === platform) return custom;
  if (custom) {
    return {
      id: "auto",
      name: SHORTCUT_PLATFORMS[platform],
      base: platform,
      bindings: defaultShortcutBindings(platform),
    };
  }
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
/** The namespace this preference occupies in the server's settings.json. */
export const SHORTCUT_SETTING_KEY = "keyboardShortcuts";

/**
 * Writes the preference to the Roamgate server. Installed at startup rather
 * than imported so this module stays free of the bridge, which every keydown
 * handler reaches through `shortcutMatches`.
 */
export type ShortcutTransport = (
  preferences: ShortcutPreferences,
) => Promise<void>;
let transport: ShortcutTransport | null = null;
/** Set once the server's stored value has been seen, so the local cache is
 * only ever promoted to the server while the server has nothing. */
let serverKnown = false;
/** Set when this browser changed its bindings without reaching the server
 * (disconnected, or the write failed); the next connection sends them. */
let localChangePending = false;

let platform = detectShortcutPlatform();
let snapshot = {
  preferences: defaults,
  platform,
  preset: resolveShortcutPreset(defaults, platform),
  storageError: "",
  /** Set when the active preset was written for another platform and this
   * browser fell back to its own defaults. */
  platformMismatch: null as ShortcutPreset | null,
};
let initialized = false;
const listeners = new Set<() => void>();
function publish(preferences: ShortcutPreferences, storageError = "") {
  snapshot = {
    preferences,
    platform,
    preset: resolveShortcutPreset(preferences, platform),
    storageError,
    platformMismatch: shortcutPresetPlatformMismatch(preferences, platform),
  };
  for (const listener of listeners) listener();
}
function read() {
  try {
    return parseShortcutPreferences(
      roamgateLocalStorage.getItem(SHORTCUT_STORAGE_KEY),
    );
  } catch {
    return defaults;
  }
}
export function initializeShortcutPreferences() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  platform = detectShortcutPlatform();
  publish(read());
  subscribeLocalStorage((key) => {
    if (key === SHORTCUT_STORAGE_KEY || key === null) publish(read());
  });
}
/** Mirrors the preference locally so the first keypress after a reload uses
 * the user's bindings without waiting for the socket, and so a disconnected
 * browser keeps them. The server remains the source of truth. */
function cache(preferences: ShortcutPreferences): string {
  try {
    roamgateLocalStorage.setItem(
      SHORTCUT_STORAGE_KEY,
      JSON.stringify(preferences),
    );
    return "";
  } catch {
    return "Browser storage is unavailable, so these bindings cannot be restored before this page reconnects.";
  }
}

function save(preferences: ShortcutPreferences) {
  const cacheError = cache(preferences);
  publish(preferences, transport ? cacheError : cacheError || offlineNotice());
  if (!transport) {
    localChangePending = true;
    return;
  }
  serverKnown = true;
  void transport(preferences).catch((error: unknown) => {
    localChangePending = true;
    publish(
      preferences,
      `Saved in this browser only: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

function offlineNotice() {
  return "Not connected: these bindings are stored in this browser and will sync when Roamgate reconnects.";
}

/**
 * Installs the write path and reports what the server already holds. A server
 * value wins over the local cache, unless this browser changed its bindings
 * while it could not reach the server; when the server holds nothing the
 * cached preference is promoted to it, which is how a browser that customised
 * its bindings before this feature existed carries them over.
 */
export function connectShortcutPreferences(
  send: ShortcutTransport,
  stored: unknown,
): void {
  initializeShortcutPreferences();
  transport = send;
  if (localChangePending) {
    // The user changed bindings here while the server could not hear it; that
    // choice is newer than whatever the server holds.
    localChangePending = false;
    serverKnown = true;
    const local = snapshot.preferences;
    publish(local);
    void send(local).catch(() => {
      localChangePending = true;
    });
    return;
  }
  const hasStored = stored !== undefined && stored !== null;
  if (hasStored) {
    serverKnown = true;
    publish(parseShortcutPreferences(JSON.stringify(stored)));
    return;
  }
  const local = snapshot.preferences;
  publish(local);
  // Promote anything the user actually chose: a custom preset, or an explicit
  // platform pick. Only an untouched "auto" with no presets is left alone, so
  // a pristine browser cannot claim the server's empty slot.
  if (serverKnown || (local.presets.length === 0 && local.active === "auto"))
    return;
  serverKnown = true;
  void send(local).catch(() => {
    /* The next edit retries; the cache still holds the preference. */
  });
}

/** Drops the write path when the socket goes away, so later edits say so. */
export function disconnectShortcutPreferences(): void {
  transport = null;
  serverKnown = false;
}

/** Applies a preference another browser changed. */
export function adoptShortcutPreferences(stored: unknown): void {
  initializeShortcutPreferences();
  // A newer change from another browser supersedes an unsent local one.
  localChangePending = false;
  const next =
    stored === undefined || stored === null
      ? defaults
      : parseShortcutPreferences(JSON.stringify(stored));
  cache(next);
  publish(next);
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
  let input: { format?: unknown; version?: unknown; preset?: unknown } | null;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error("Invalid keybindings preset JSON.");
  }
  if (input?.format !== "herdr-keybindings" || input.version !== 1)
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

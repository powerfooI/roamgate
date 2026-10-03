import { useSyncExternalStore } from "react";
import { roamgateLocalStorage, subscribeLocalStorage } from "./browserStorage";
import { connectionStorageKey } from "./connectionStorage";
import type { Pane, Tab } from "./types";

export const TAB_PINS_STORAGE_KEY = "tabPins.v1";

const MAX_TAB_PINS = 256;
const MAX_TAB_ID_LENGTH = 512;
const EMPTY_TAB_PINS: ReadonlySet<string> = new Set();

export const PINNED_TAB_CLOSE_REASON = "Unpin this tab before closing it.";
export const PINNED_TAB_LAST_PANE_CLOSE_REASON =
  "This is the last pane of a pinned tab. Unpin the tab before closing it.";

export function parseTabPins(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const tabIds: string[] = [];
    for (const candidate of value) {
      if (tabIds.length >= MAX_TAB_PINS) break;
      if (
        typeof candidate !== "string" ||
        candidate.length === 0 ||
        candidate.length > MAX_TAB_ID_LENGTH ||
        seen.has(candidate)
      ) {
        continue;
      }
      seen.add(candidate);
      tabIds.push(candidate);
    }
    return tabIds;
  } catch {
    return [];
  }
}

export function serializeTabPins(tabIds: readonly string[]): string {
  return JSON.stringify(parseTabPins(JSON.stringify(tabIds)));
}

export function withTabPinned(
  tabIds: readonly string[],
  tabId: string,
  pinned: boolean,
): string[] {
  const withoutTab = tabIds.filter((candidate) => candidate !== tabId);
  if (!pinned) return withoutTab;
  // Keep the newest explicit pin when the list is at capacity.
  return [...withoutTab, tabId].slice(-MAX_TAB_PINS);
}

/**
 * Pinned tabs first, each group in Herdr's tab-list order. Tab numbers are
 * stable ids that do not follow `tab.move`, so they never decide position.
 */
export function orderTabsForDisplay<T extends Pick<Tab, "tab_id" | "number">>(
  tabs: readonly T[],
  pinnedTabIds: ReadonlySet<string>,
): T[] {
  return [...tabs].sort(
    (a, b) =>
      Number(pinnedTabIds.has(b.tab_id)) - Number(pinnedTabIds.has(a.tab_id)),
  );
}

export function tabCloseBlockReason(
  tabId: string,
  pinnedTabIds: ReadonlySet<string>,
): string | null {
  return pinnedTabIds.has(tabId) ? PINNED_TAB_CLOSE_REASON : null;
}

/** Closing the only pane of a tab closes the tab, so a pin protects it too. */
export function paneCloseBlockReason(
  paneId: string,
  panes: readonly Pick<Pane, "pane_id" | "tab_id">[],
  pinnedTabIds: ReadonlySet<string>,
): string | null {
  const target = panes.find((pane) => pane.pane_id === paneId);
  if (!target || !pinnedTabIds.has(target.tab_id)) return null;
  const hasSibling = panes.some(
    (pane) => pane.pane_id !== paneId && pane.tab_id === target.tab_id,
  );
  return hasSibling ? null : PINNED_TAB_LAST_PANE_CLOSE_REASON;
}

// Herdr saves tab ids with its session, so pins survive restarts of both Herdr
// and Roamgate. Like workspace pins, they stay in this browser.
const pinsByConnection = new Map<string, ReadonlySet<string>>();
const listeners = new Set<() => void>();
let unsubscribeStorage: (() => void) | undefined;

function storageKey(connectionId: string): string {
  return connectionStorageKey(connectionId, TAB_PINS_STORAGE_KEY);
}

function notify() {
  for (const listener of listeners) listener();
}

export function tabPinsFor(connectionId: string): ReadonlySet<string> {
  if (!connectionId) return EMPTY_TAB_PINS;
  let pins = pinsByConnection.get(connectionId);
  if (!pins) {
    pins = new Set(
      parseTabPins(roamgateLocalStorage.getItem(storageKey(connectionId))),
    );
    pinsByConnection.set(connectionId, pins);
  }
  return pins;
}

function writeTabPins(connectionId: string, tabIds: readonly string[]) {
  const current = tabPinsFor(connectionId);
  if (
    current.size === tabIds.length &&
    tabIds.every((tabId) => current.has(tabId))
  ) {
    return;
  }
  pinsByConnection.set(connectionId, new Set(tabIds));
  try {
    roamgateLocalStorage.setItem(
      storageKey(connectionId),
      serializeTabPins(tabIds),
    );
  } catch {
    // Keep pins usable in memory when browser storage is unavailable.
  }
  notify();
}

export function setTabPinned(
  connectionId: string,
  tabId: string,
  pinned: boolean,
) {
  if (!connectionId || !tabId) return;
  writeTabPins(
    connectionId,
    withTabPinned([...tabPinsFor(connectionId)], tabId, pinned),
  );
}

/**
 * Drops pins for tabs a full refresh no longer lists, such as tabs closed in
 * the Herdr TUI. An empty list can be a server that has not restored its
 * session yet, so it never clears pins.
 */
export function forgetClosedTabPins(
  connectionId: string,
  liveTabIds: ReadonlySet<string>,
) {
  if (!connectionId || liveTabIds.size === 0) return;
  writeTabPins(
    connectionId,
    [...tabPinsFor(connectionId)].filter((tabId) => liveTabIds.has(tabId)),
  );
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1)
    unsubscribeStorage = subscribeLocalStorage(onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      unsubscribeStorage?.();
      unsubscribeStorage = undefined;
    }
  };
}

// Another window changed its pins: reload them on the next read.
function onStorage(key: string | null) {
  let changed = false;
  for (const connectionId of pinsByConnection.keys()) {
    if (key === null || key === storageKey(connectionId)) {
      pinsByConnection.delete(connectionId);
      changed = true;
    }
  }
  if (changed) notify();
}

export function useTabPins(connectionId: string): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    () => tabPinsFor(connectionId),
    () => tabPinsFor(connectionId),
  );
}

export function __resetTabPinsForTests() {
  pinsByConnection.clear();
}

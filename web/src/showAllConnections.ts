import { useSyncExternalStore } from "react";
import { roamgateLocalStorage } from "./browserStorage";
import { AGENT_LIST_SCOPE_STORAGE_KEY } from "./workspaceAgentLayout";

/**
 * Global (not per-connection) preference: the workspace tree's **All servers**
 * scope, stored as "all" or "current".
 */
export const SHOW_ALL_CONNECTIONS_STORAGE_KEY = AGENT_LIST_SCOPE_STORAGE_KEY;

export function parseShowAllConnectionsPreference(raw: string | null): boolean {
  return raw === "all";
}

/**
 * The workspace tree's **Current / All servers** scope, shared with every
 * other reader in the page. The tree owns the switch, but the pane switchers
 * scope themselves by it and the store only reads other connections' topology
 * while it is on. A `storage` event only reaches other tabs, so same-tab
 * readers are notified directly.
 */
const listeners = new Set<() => void>();

function read(): boolean {
  return parseShowAllConnectionsPreference(
    roamgateLocalStorage.getItem(SHOW_ALL_CONNECTIONS_STORAGE_KEY),
  );
}

let current = read();

function notify() {
  for (const listener of listeners) listener();
}

export function showAllConnections(): boolean {
  return current;
}

export function setShowAllConnections(value: boolean) {
  if (value === current) return;
  current = value;
  try {
    roamgateLocalStorage.setItem(
      SHOW_ALL_CONNECTIONS_STORAGE_KEY,
      value ? "all" : "current",
    );
  } catch {
    /* Blocked storage keeps the choice for this page only. */
  }
  notify();
}

function onStorage(event: StorageEvent) {
  if (
    event.key !== null &&
    !event.key.endsWith(SHOW_ALL_CONNECTIONS_STORAGE_KEY)
  )
    return;
  const next = read();
  if (next === current) return;
  current = next;
  notify();
}

export function subscribeShowAllConnections(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    // Nothing listened while unsubscribed: pick up any change made meanwhile.
    current = read();
    if (typeof window !== "undefined")
      window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined")
      window.removeEventListener("storage", onStorage);
  };
}

export function useShowAllConnections(): boolean {
  return useSyncExternalStore(
    subscribeShowAllConnections,
    showAllConnections,
    showAllConnections,
  );
}

import { useSyncExternalStore } from "react";
import { roamgateLocalStorage, subscribeLocalStorage } from "./browserStorage";

/**
 * Whether the Option key acts as Alt (Meta) in terminals on macOS.
 *
 * Off by default: Option is how French, German and many other macOS layouts
 * type `@`, `[`, `]`, `{`, `}`, `|` and `~`, and as Meta it would send
 * Alt-modified keys instead of those characters. A per-browser choice,
 * because it depends on the keyboard layout of the machine at hand.
 */
export const TERMINAL_OPTION_AS_META_STORAGE_KEY = "terminalOptionAsMeta.v1";

export function parseTerminalOptionAsMeta(value: string | null): boolean {
  return value === "true";
}

let snapshot = false;
const listeners = new Set<() => void>();
let initialized = false;

function publish(value: boolean) {
  if (value === snapshot) return;
  snapshot = value;
  for (const listener of listeners) listener();
}

function read() {
  try {
    return parseTerminalOptionAsMeta(
      roamgateLocalStorage.getItem(TERMINAL_OPTION_AS_META_STORAGE_KEY),
    );
  } catch {
    return false;
  }
}

function initialize() {
  if (initialized) return;
  initialized = true;
  publish(read());
  subscribeLocalStorage((key) => {
    if (key === TERMINAL_OPTION_AS_META_STORAGE_KEY || key === null)
      publish(read());
  });
}

function subscribe(listener: () => void) {
  initialize();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setTerminalOptionAsMeta(enabled: boolean) {
  initialize();
  try {
    roamgateLocalStorage.setItem(
      TERMINAL_OPTION_AS_META_STORAGE_KEY,
      String(enabled),
    );
  } catch {
    // The choice still applies to this page when storage is blocked.
  }
  publish(enabled);
}

/** The current choice, read from storage on first use. */
export function terminalOptionAsMeta() {
  initialize();
  return snapshot;
}

export function useTerminalOptionAsMeta() {
  return useSyncExternalStore(subscribe, terminalOptionAsMeta, () => false);
}

import { useCallback, useSyncExternalStore } from "react";
import { roamgateLocalStorage, subscribeLocalStorage } from "./browserStorage";

/**
 * The key sent after a composer message, chosen per agent: an agent that
 * binds submit to a modified key (oh-my-pi's `super+enter`, for one) gets it,
 * every other agent and plain shells keep Enter.
 */
export const TERMINAL_SUBMIT_KEYS = [
  { value: "enter", label: "Enter", herdrKey: "enter" },
  { value: "shift-enter", label: "Shift+Enter", herdrKey: "shift+enter" },
  { value: "alt-enter", label: "Alt+Enter", herdrKey: "alt+enter" },
  { value: "ctrl-enter", label: "Ctrl+Enter", herdrKey: "ctrl+enter" },
  { value: "meta-enter", label: "Cmd/Super+Enter", herdrKey: "super+enter" },
] as const;

export type TerminalSubmitKey = (typeof TERMINAL_SUBMIT_KEYS)[number]["value"];

const STORAGE_KEY = "terminalSubmitKeys.v1";

export function normalizeTerminalSubmitKey(value: unknown): TerminalSubmitKey {
  return (
    TERMINAL_SUBMIT_KEYS.find((choice) => choice.value === value)?.value ??
    "enter"
  );
}

/** The Herdr `pane.send_keys` name of a submit key. */
export function terminalSubmitHerdrKey(key: TerminalSubmitKey): string {
  return (
    TERMINAL_SUBMIT_KEYS.find((choice) => choice.value === key)?.herdrKey ??
    "enter"
  );
}

const listeners = new Set<() => void>();
// The choices when storage refuses them, for this page.
let pageChoices: Record<string, TerminalSubmitKey> | null = null;

function storedChoices(): Record<string, TerminalSubmitKey> {
  if (pageChoices) return pageChoices;
  try {
    const parsed: unknown = JSON.parse(
      roamgateLocalStorage.getItem(STORAGE_KEY) ?? "{}",
    );
    const choices: Record<string, TerminalSubmitKey> = {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return choices;
    for (const [agent, key] of Object.entries(parsed)) {
      const normalized = normalizeTerminalSubmitKey(key);
      if (normalized !== "enter") choices[agent] = normalized;
    }
    return choices;
  } catch {
    return {};
  }
}

/** The submit key for a pane's agent: Enter without an agent or a choice. */
export function terminalSubmitKey(
  agent: string | undefined,
): TerminalSubmitKey {
  if (!agent) return "enter";
  const choices = storedChoices();
  return Object.prototype.hasOwnProperty.call(choices, agent)
    ? (choices[agent] ?? "enter")
    : "enter";
}

/** Sets the submit key of an agent, by the name its panes report. */
export function setTerminalSubmitKey(agent: string, key: TerminalSubmitKey) {
  const choices = { ...storedChoices() };
  if (key === "enter") delete choices[agent];
  else choices[agent] = key;
  try {
    if (Object.keys(choices).length)
      roamgateLocalStorage.setItem(STORAGE_KEY, JSON.stringify(choices));
    else roamgateLocalStorage.removeItem(STORAGE_KEY);
    pageChoices = null;
  } catch {
    pageChoices = choices;
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another window's choice applies here too.
  const unsubscribe = subscribeLocalStorage((key) => {
    if (key === null || key === STORAGE_KEY) listener();
  });
  return () => {
    listeners.delete(listener);
    unsubscribe();
  };
}

export function useTerminalSubmitKey(
  agent: string | undefined,
): TerminalSubmitKey {
  const read = useCallback(() => terminalSubmitKey(agent), [agent]);
  return useSyncExternalStore(subscribe, read, () => "enter");
}

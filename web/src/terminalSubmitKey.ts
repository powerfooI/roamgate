import { roamgateLocalStorage } from "./browserStorage";

const STORAGE_KEY = "terminalSubmitKey";
export type TerminalSubmitKey =
  | "enter"
  | "shift-enter"
  | "alt-enter"
  | "ctrl-enter"
  | "meta-enter";

export function normalizeTerminalSubmitKey(
  value: string | null,
): TerminalSubmitKey {
  switch (value) {
    case "shift-enter":
    case "alt-enter":
    case "ctrl-enter":
    case "meta-enter":
      return value;
    default:
      return "enter";
  }
}

let pageChoice: TerminalSubmitKey | null = null;

export function terminalSubmitKey(): TerminalSubmitKey {
  return (
    pageChoice ??
    normalizeTerminalSubmitKey(roamgateLocalStorage.getItem(STORAGE_KEY))
  );
}

export function setTerminalSubmitKey(value: TerminalSubmitKey) {
  try {
    roamgateLocalStorage.setItem(STORAGE_KEY, value);
    pageChoice = null;
  } catch {
    pageChoice = value;
  }
}

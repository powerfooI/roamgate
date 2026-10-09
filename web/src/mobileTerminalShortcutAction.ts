import {
  mobileTerminalShortcutBytes,
  mobileTerminalShortcutScroll,
  type MobileTerminalShortcutAction,
} from "./mobileTerminalShortcuts";

export type MobileTerminalShortcutExecution =
  | {
      type: "input";
      bytes: number[];
    }
  | {
      type: "scroll";
      direction: "up" | "down";
      amount: "full" | "half";
    };

export function mobileTerminalShortcutExecution(
  action: MobileTerminalShortcutAction,
  preserveKeyIdentity = true,
): MobileTerminalShortcutExecution | null {
  const scroll = mobileTerminalShortcutScroll(action);
  if (scroll) return { type: "scroll", ...scroll };
  const bytes = mobileTerminalShortcutBytes(action, preserveKeyIdentity);
  return bytes.length > 0 ? { type: "input", bytes } : null;
}

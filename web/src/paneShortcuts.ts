import { getShortcutSnapshot } from "./shortcutPreferences";
import { matchesShortcut, type ShortcutBindings } from "./shortcutBindings";
export type PaneShortcutDirection = "left" | "right" | "up" | "down";

export type PaneShortcutAction =
  | { type: "focus"; direction: PaneShortcutDirection }
  | { type: "split"; direction: "right" | "down" }
  | { type: "zoom" };

type PaneShortcutEvent = Pick<
  KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
> &
  Partial<Pick<KeyboardEvent, "code" | "isComposing" | "keyCode">>;

/** Resolve pane commands from the active preset. */
export function paneShortcutAction(
  event: PaneShortcutEvent,
  bindings: ShortcutBindings = getShortcutSnapshot().preset.bindings,
): PaneShortcutAction | null {
  for (const direction of ["left", "right", "up", "down"] as const) {
    if (matchesShortcut(event, `pane.${direction}`, bindings))
      return { type: "focus", direction };
  }
  if (matchesShortcut(event, "pane.splitRight", bindings))
    return { type: "split", direction: "right" };
  if (matchesShortcut(event, "pane.splitDown", bindings))
    return { type: "split", direction: "down" };
  if (matchesShortcut(event, "pane.zoom", bindings)) return { type: "zoom" };
  return null;
}

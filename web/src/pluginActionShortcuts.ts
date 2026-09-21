import { getShortcutSnapshot } from "./shortcutPreferences";
import { matchesShortcut, type ShortcutBindings } from "./shortcutBindings";

export type PluginActionShortcut = {
  pluginId: string;
  actionId: string;
};

type PluginActionShortcutEvent = Pick<
  KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
> &
  Partial<Pick<KeyboardEvent, "code" | "isComposing" | "keyCode">>;

/**
 * Resolve a keydown into a Herdr plugin action to invoke, from the fixed set
 * of plugin action shortcuts Roamgate currently knows about. There is no
 * plugin action discovery/configuration UI yet, so this list is hardcoded.
 */
export function pluginActionShortcut(
  event: PluginActionShortcutEvent,
  bindings: ShortcutBindings = getShortcutSnapshot().preset.bindings,
): PluginActionShortcut | null {
  if (matchesShortcut(event, "plugin.herdrFloat.toggle", bindings)) {
    return { pluginId: "herdr-float", actionId: "toggle" };
  }
  return null;
}

import { SHORTCUT_NUMBERS, type ShortcutId } from "./shortcutBindings";
export type ShortcutDescription = {
  id: ShortcutId;
  label: string;
  group: string;
};
const descriptions: [ShortcutId, string, string][] = [
  ["command.menu", "Open or close the command menu", "Global"],
  ["sidebar.toggle", "Toggle the desktop sidebar", "Global"],
  ["inspector.toggle", "Toggle the Workspace Inspector", "Global"],
  ["inspector.expand", "Expand or restore the Inspector on desktop", "Global"],
  ["annotations.toggle", "Toggle Annotations", "Global"],
  ["zen.toggle", "Toggle Zen mode on desktop", "Global"],
  ["panes.recent", "Open the recent pane switcher", "Global"],
  ["plugin.herdrFloat.toggle", "Toggle the Herdr Float popup shell", "Global"],
  ["panes.search", "Search panes in the pane switcher", "Global"],
  ["workspaces.open", "Open Workspaces", "Global"],
  ["files.toggle", "Toggle File Explorer", "Global"],
  ["diff.toggle", "Toggle Diff Viewer", "Global"],
  ["tab.create", "Create a tab", "Tabs & panes"],
  ["tab.close", "Close the active pane or its single-pane tab", "Tabs & panes"],
  ["tab.previous", "Switch to the previous tab", "Tabs & panes"],
  ["tab.next", "Switch to the next tab", "Tabs & panes"],
  ["pane.left", "Focus the pane to the left", "Tabs & panes"],
  ["pane.right", "Focus the pane to the right", "Tabs & panes"],
  ["pane.up", "Focus the pane above", "Tabs & panes"],
  ["pane.down", "Focus the pane below", "Tabs & panes"],
  ["pane.splitRight", "Split the active pane right", "Tabs & panes"],
  ["pane.splitDown", "Split the active pane down", "Tabs & panes"],
  ["pane.zoom", "Zoom or restore the active pane", "Tabs & panes"],
  ...SHORTCUT_NUMBERS.map((n): [ShortcutId, string, string] => [
    `tab.${n}`,
    `Switch to tab ${n}`,
    "Tabs & panes",
  ]),
  ...SHORTCUT_NUMBERS.map((n): [ShortcutId, string, string] => [
    `command.${n}`,
    `Run numbered action ${n} in the command menu`,
    "Command menu",
  ]),
  ["terminal.history", "Toggle agent message history", "Terminal"],
  [
    "terminal.pageUp",
    "Page up in the application or shell history",
    "Terminal",
  ],
  [
    "terminal.pageDown",
    "Page down in the application or shell history",
    "Terminal",
  ],
  ["terminal.halfPageUp", "Scroll history up half a page", "Terminal"],
  ["terminal.halfPageDown", "Scroll history down half a page", "Terminal"],
  ["terminal.multiline", "Send multiline Enter to the agent", "Terminal"],
  ["terminal.altEnter", "Send Alt-modified Enter to the agent", "Terminal"],
  ["terminal.lineStart", "Move to the beginning of the input line", "Terminal"],
  ["terminal.lineEnd", "Move to the end of the input line", "Terminal"],
  [
    "terminal.deleteToStart",
    "Delete to the beginning of the input line",
    "Terminal",
  ],
  ["terminal.copy", "Copy selected terminal text", "Terminal"],
  ["terminal.paste", "Paste text or images", "Terminal"],
  ["terminal.link", "Open links or preview workspace paths", "Terminal"],
  ["composer.send", "Send the terminal composer draft", "Terminal composer"],
  ["preview.search", "Search the raw file preview or diff", "Preview & review"],
  ["preview.selectAll", "Select all in the file preview", "Preview & review"],
  ["annotation.submit", "Add a review comment", "Preview & review"],
  ["annotations.copy", "Copy review feedback", "Preview & review"],
  [
    "annotations.prefill",
    "Pre-fill agent with review feedback",
    "Preview & review",
  ],
];
export const SHORTCUT_CATALOG: ShortcutDescription[] = descriptions.map(
  ([id, label, group]) => ({ id, label, group }),
);

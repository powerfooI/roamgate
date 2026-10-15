import { expect, test } from "bun:test";
import { defaultShortcutBindings } from "./shortcutBindings";
import { SHORTCUT_CATALOG } from "./shortcutCatalog";
import { shortcutCheatSheet, shortcutKeyCaps } from "./shortcutCheatSheet";

const rows = (groups: ReturnType<typeof shortcutCheatSheet>) =>
  groups.flatMap((group) => group.rows);

test("key caps use platform modifier names and punctuation symbols", () => {
  expect(shortcutKeyCaps("Meta+Slash", "mac")).toEqual(["Cmd", "/"]);
  expect(shortcutKeyCaps("Ctrl+Alt+Slash", "linux")).toEqual([
    "Ctrl",
    "Alt",
    "/",
  ]);
  expect(shortcutKeyCaps("Alt+Meta+ArrowLeft", "mac")).toEqual([
    "Option",
    "Cmd",
    "Left",
  ]);
  expect(shortcutKeyCaps("Ctrl+Backquote", "windows")).toEqual(["Ctrl", "`"]);
});

test("numbered tab and command shortcuts collapse into ranges", () => {
  const sheet = rows(shortcutCheatSheet(defaultShortcutBindings("mac"), "mac"));
  expect(sheet.find((row) => row.key === "tab.range")?.combos).toEqual([
    ["Ctrl", "1-9"],
  ]);
  expect(sheet.find((row) => row.key === "command.range")?.combos).toEqual([
    ["Option", "1-9"],
  ]);
  expect(sheet.some((row) => /^(tab|command)\.\d$/.test(row.key))).toBe(false);
  expect(sheet).toHaveLength(SHORTCUT_CATALOG.length - 16);
});

test("customized numbered shortcuts stay listed individually", () => {
  const bindings = defaultShortcutBindings("linux");
  bindings["tab.3"] = ["Ctrl+Alt+Shift+3"];
  const sheet = rows(shortcutCheatSheet(bindings, "linux"));
  expect(sheet.some((row) => row.key === "tab.range")).toBe(false);
  expect(sheet.find((row) => row.key === "tab.3")?.combos).toEqual([
    ["Ctrl", "Alt", "Shift", "3"],
  ]);
  expect(sheet.some((row) => row.key === "command.range")).toBe(true);
});

test("filtering matches labels, groups, and keys", () => {
  const bindings = defaultShortcutBindings("windows");
  bindings["zen.toggle"] = [];
  const byLabel = shortcutCheatSheet(bindings, "windows", "zen");
  expect(rows(byLabel).map((row) => row.key)).toEqual(["zen.toggle"]);
  expect(rows(byLabel)[0].combos).toEqual([]);
  expect(
    rows(shortcutCheatSheet(bindings, "windows", "composer")).map(
      (row) => row.key,
    ),
  ).toEqual(["composer.send"]);
  expect(
    rows(shortcutCheatSheet(bindings, "windows", "insert")).map(
      (row) => row.key,
    ),
  ).toEqual(["terminal.copy"]);
  expect(shortcutCheatSheet(bindings, "windows", "no such action")).toEqual([]);
});

test("filtering matches combinations written as they are displayed", () => {
  const mac = defaultShortcutBindings("mac");
  const keys = (query: string) =>
    rows(shortcutCheatSheet(mac, "mac", query)).map((row) => row.key);
  expect(keys("Cmd+B")).toContain("sidebar.toggle");
  expect(keys("cmd+shift+k")).toEqual(["shortcuts.show"]);
  expect(keys("Ctrl+`")).toEqual(["terminal.focus"]);
  expect(
    rows(
      shortcutCheatSheet(
        defaultShortcutBindings("linux"),
        "linux",
        "ctrl+alt+k",
      ),
    ).map((row) => row.key),
  ).toEqual(["command.menu"]);
});

test("collapsed numbered rows stay findable by number", () => {
  const mac = defaultShortcutBindings("mac");
  const keys = (query: string) =>
    rows(shortcutCheatSheet(mac, "mac", query)).map((row) => row.key);
  expect(keys("tab 3")).toEqual(["tab.range"]);
  expect(keys("action 5")).toEqual(["command.range"]);
  expect(keys("Option+5")).toEqual(["command.range"]);
  expect(keys("command menu")).toContain("command.menu");
  expect(keys("1-9")).toEqual(["tab.range", "command.range"]);
  expect(keys("Switch to tab 1-9")).toEqual(["tab.range"]);
  expect(keys("Option+1-9")).toEqual(["command.range"]);
});

test("filtering keeps punctuation keys distinct from separators", () => {
  const mac = defaultShortcutBindings("mac");
  mac["zen.toggle"] = ["Meta+Slash"];
  mac["sidebar.toggle"] = ["Ctrl+Minus"];
  const keys = (query: string) =>
    rows(shortcutCheatSheet(mac, "mac", query)).map((row) => row.key);
  expect(keys("Cmd+/")).toEqual(["zen.toggle"]);
  expect(keys("Ctrl+-")).toEqual(["sidebar.toggle"]);
});

import {
  formatShortcut,
  SHORTCUT_NUMBERS,
  type ShortcutBindings,
  type ShortcutId,
  type ShortcutPlatform,
} from "./shortcutBindings";
import { SHORTCUT_CATALOG } from "./shortcutCatalog";
import { normalizeSearchText } from "./searchText";

export type CheatSheetRow = {
  key: string;
  label: string;
  /** Alternative bindings, each split into the key caps to press together. */
  combos: string[][];
};
export type CheatSheetGroup = { group: string; rows: CheatSheetRow[] };

const numberedRanges: Record<string, string> = {
  tab: "Switch to tab 1-9",
  command: "Run numbered actions 1-9 in the command menu",
};

// Search folds "-" and "/" as separators; keep them when they are the key.
const punctuationKeyWords: Record<string, string> = {
  "-": "minus",
  "/": "slash",
};
const searchText = (value: string) =>
  normalizeSearchText(
    value.replace(/\+([-/])/g, (_, key) => `+${punctuationKeyWords[key]}`),
  );

export function shortcutKeyCaps(
  binding: string,
  platform: ShortcutPlatform,
): string[] {
  return binding.split("+").map((part) => formatShortcut(part, platform));
}

/** Shared modifiers when `prefix.1` through `prefix.9` differ only by digit. */
function numberedPrefix(
  bindings: ShortcutBindings,
  prefix: string,
): string | null {
  let shared: string | null = null;
  for (const n of SHORTCUT_NUMBERS) {
    const keys = bindings[`${prefix}.${n}` as ShortcutId];
    if (keys.length !== 1 || !keys[0].endsWith(`+${n}`)) return null;
    const modifiers = keys[0].slice(0, -`+${n}`.length);
    if (shared !== null && modifiers !== shared) return null;
    shared = modifiers;
  }
  return shared;
}

export function shortcutCheatSheet(
  bindings: ShortcutBindings,
  platform: ShortcutPlatform,
  query = "",
): CheatSheetGroup[] {
  const search = searchText(query);
  const groups = new Map<string, CheatSheetRow[]>();
  // Index keys both as shown elsewhere (Ctrl+Alt+K) and as separate words.
  const keyText = (keys: string[]) =>
    keys
      .map(
        (key) =>
          `${formatShortcut(key, platform)} ${shortcutKeyCaps(key, platform).join(" ")}`,
      )
      .join(" ");
  const add = (group: string, row: CheatSheetRow, text: string) => {
    if (search && !searchText(`${text} ${group}`).includes(search)) return;
    groups.set(group, [...(groups.get(group) ?? []), row]);
  };
  const collapsed = new Map<string, string | null>();
  for (const item of SHORTCUT_CATALOG) {
    const numbered = /^(tab|command)\.\d$/.exec(item.id);
    if (numbered) {
      const prefix = numbered[1];
      if (!collapsed.has(prefix))
        collapsed.set(prefix, numberedPrefix(bindings, prefix));
      const modifiers = collapsed.get(prefix);
      if (modifiers !== null && modifiers !== undefined) {
        if (item.id.endsWith(".1")) {
          // Keep each collapsed number findable, e.g. "tab 3" or "Ctrl+3".
          const members = SHORTCUT_CATALOG.filter((entry) =>
            new RegExp(`^${prefix}\\.\\d$`).test(entry.id),
          );
          const caps = [...shortcutKeyCaps(modifiers, platform), "1-9"];
          add(
            item.group,
            {
              key: `${prefix}.range`,
              label: numberedRanges[prefix],
              combos: [caps],
            },
            [
              numberedRanges[prefix],
              caps.join("+"),
              ...members.map(
                (entry) => `${entry.label} ${keyText(bindings[entry.id])}`,
              ),
            ].join(" "),
          );
        }
        continue;
      }
    }
    add(
      item.group,
      {
        key: item.id,
        label: item.label,
        combos: bindings[item.id].map((key) => shortcutKeyCaps(key, platform)),
      },
      `${item.label} ${keyText(bindings[item.id])}`,
    );
  }
  return [...groups].map(([group, rows]) => ({ group, rows }));
}

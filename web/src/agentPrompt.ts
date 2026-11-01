/**
 * What an agent asks, read from its terminal screen: the prompt's lines and
 * its choices. Claude Code numbers some menus ("1. Yes / 2. No"), answered
 * by the number's key; others it does not (its "trust this folder?"
 * question), answered by moving its ❯ cursor and pressing Enter. `input` is
 * what to type for a choice; `key` the number shown for it, if any.
 */
export type AgentPromptOption = {
  key: string;
  label: string;
  input: string;
  /** The line or two under a choice that says what it means. */
  detail?: string;
  /** In a question taking several answers: whether this one is picked. */
  checked?: boolean;
  /** Where the agent's ❯ cursor is. */
  cursor?: boolean;
  /**
   * "Type something.": an answer of the user's own, typed with the cursor
   * on it; `input` moves the cursor there.
   */
  freeText?: boolean;
};
/**
 * One question of several (AskUserQuestion's "← ☐ Color ☐ Fruit ✔ Submit →"
 * line): answered or not, the one shown, and what moves there from it.
 */
export type AgentPromptTab = {
  label: string;
  done: boolean;
  current: boolean;
  input: string;
};
export type AgentPrompt = {
  lines: string[];
  options: AgentPromptOption[];
  /**
   * A question taking several answers confirms its picks on a "Submit" line
   * under them: what moves there and presses Enter.
   */
  submit?: string;
  /** The questions to move between, when the current one is known. */
  tabs?: AgentPromptTab[];
  /**
   * A menu waiting on Enter to confirm: a question even when the agent's
   * status does not say it is blocked (before its hooks run, say).
   */
  confirm?: boolean;
};

/** Box borders and rules agents draw around their prompts. */
const BORDER = /^[\s│┃|╭╮╰╯┌┐└┘─━═╌┄]+|[\s│┃|╭╮╰╯┌┐└┘─━═╌┄]+$/g;
const RULE = /^[\s─━═╌┄-]*$/;
const OPTION = /^(?:[❯›>▶]\s*)?(\d{1,2})[.)]\s+(.+)$/;
/** How much of the bottom of the screen a prompt can take. */
const MAX_LINES = 24;
const CHECKBOX = /^\[(.?)\]\s*(.*)$/u;
const FREE_TEXT = /^Type something\.?$/i;
const SUBMIT_LINE = /^(?:Submit|Next)$/i;
/** Lines a choice's description can take before the next choice. */
const MAX_DETAIL_LINES = 3;

/**
 * Whether a screen cell (row, column) is drawn on a colored background: how
 * the agent marks the question it shows. The text alone does not say.
 */
export type ScreenHighlight = (row: number, column: number) => boolean;

export function parseAgentPrompt(
  screen: readonly string[],
  highlighted?: ScreenHighlight,
): AgentPrompt {
  const tabs = parseTabs(screen, highlighted);
  const prompt = parsePrompt(screen);
  if (!tabs) return prompt;
  // The question is what follows its tabs; above them is earlier output.
  let tabLine = prompt.lines.length - 1;
  while (tabLine >= 0 && !TAB_LINE.test(prompt.lines[tabLine]!)) tabLine--;
  return { ...prompt, lines: prompt.lines.slice(tabLine + 1), tabs };
}

const TAB_LINE = /^\s*←.*→\s*$/;
const TAB = /([☐☒☑✔✓])\s?([^☐☒☑✔✓←→]*[^\s☐☒☑✔✓←→])/g;
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";

function parseTabs(
  screen: readonly string[],
  highlighted?: ScreenHighlight,
): AgentPromptTab[] | null {
  if (!highlighted) return null;
  for (let row = screen.length - 1; row >= 0; row--) {
    const line = screen[row]!;
    if (!TAB_LINE.test(line)) continue;
    const found = [...line.matchAll(TAB)].map((match) => ({
      label: match[2]!.trim(),
      // ☒ answered; ✔ marks the Submit step itself.
      done: match[1] === "☒" || match[1] === "☑",
      start: match.index!,
      end: match.index! + match[0].length,
    }));
    if (found.length < 2) return null;
    const current = found.findIndex((tab) => {
      for (let column = tab.start; column < tab.end; column++)
        if (highlighted(row, column)) return true;
      return false;
    });
    // Without knowing which one shows, moving to another cannot be done.
    if (current < 0) return null;
    return found.map((tab, index) => {
      const moves = index - current;
      return {
        label: tab.label,
        done: tab.done,
        current: index === current,
        input: (moves > 0 ? RIGHT : LEFT).repeat(Math.abs(moves)),
      };
    });
  }
  return null;
}

function parsePrompt(screen: readonly string[]): AgentPrompt {
  const lines = screen
    .map((line) => line.replace(BORDER, ""))
    .filter((line) => line && !RULE.test(line))
    .slice(-MAX_LINES);
  // The choices are the last numbered run, counting down to 1 from its
  // last line; a choice's description goes on in the lines under it.
  let last = -1;
  for (let index = lines.length - 1; index >= 0; index--)
    if (OPTION.test(lines[index]!)) {
      last = index;
      break;
    }
  const options: AgentPromptOption[] = [];
  let first = -1;
  let submitAfter: string | null = null;
  if (last >= 0) {
    let expected = Number(OPTION.exec(lines[last]!)![1]);
    let detail: string[] = [];
    for (let index = last; index >= 0 && expected >= 1; index--) {
      const match = OPTION.exec(lines[index]!);
      if (!match) {
        detail.unshift(lines[index]!.trim());
        if (detail.length > MAX_DETAIL_LINES) break;
        continue;
      }
      if (Number(match[1]) !== expected) break;
      // "[✔] Coffee" in a question taking several answers. The "Submit"
      // line under the last one is that question's own step, not a meaning.
      const box = CHECKBOX.exec(match[2]!.trim());
      const meaning = detail.filter((line) => !SUBMIT_LINE.test(line));
      if (box && meaning.length < detail.length) submitAfter = match[1]!;
      options.unshift({
        key: match[1]!,
        label: box ? box[2]!.trim() : match[2]!.trim(),
        input: match[1]!,
        ...(meaning.length ? { detail: meaning.join(" ") } : {}),
        ...(box ? { checked: box[1]!.trim() !== "" } : {}),
        ...(/^\s*[❯›>▶]/.test(lines[index]!) ? { cursor: true } : {}),
      });
      detail = [];
      expected--;
      first = index;
    }
    // Numbered from 1 up, or it is a numbered list in the text, not a menu.
    if (expected !== 0) options.length = 0;
    // A Submit line under the last choice.
    const lastChoice = options[options.length - 1];
    if (
      lastChoice?.checked !== undefined &&
      lines
        .slice(last + 1, last + 1 + MAX_DETAIL_LINES)
        .some((line) => SUBMIT_LINE.test(line.trim()))
    )
      submitAfter = lastChoice.key;
  }
  if (options.length) {
    // "Type something.": typing goes to it once the cursor is on it, so it is
    // reached with the arrows, not its number (which would only tick it).
    const at = options.findIndex((option) => option.cursor);
    for (const [index, option] of options.entries()) {
      if (!FREE_TEXT.test(option.label)) continue;
      option.freeText = true;
      option.detail ??= "Then write it in the message box";
      if (at < 0) continue;
      const moves = index - at;
      option.input = (moves > 0 ? DOWN : UP).repeat(Math.abs(moves));
    }
    // Several answers: their "Submit" line comes right after the choice it
    // was found under.
    let submit: string | undefined;
    const below = options.findIndex((option) => option.key === submitAfter);
    if (below >= 0 && at >= 0) {
      const moves = below + 1 - at;
      submit = `${(moves > 0 ? DOWN : UP).repeat(Math.abs(moves))}\r`;
    }
    // Waiting on Enter: a question even when the agent's status says idle.
    const confirm = lines
      .slice(last + 1)
      .some((line) => CONFIRM_HINT.test(line));
    return {
      lines: lines.slice(0, first),
      options,
      ...(confirm ? { confirm } : {}),
      ...(submit ? { submit } : {}),
    };
  }
  if (!options.length) {
    const menu = parseCursorMenu(screen);
    if (menu) {
      const first = lines.findIndex((line) => line.includes(menu[0]!.label));
      return {
        lines: first >= 0 ? lines.slice(0, first) : lines,
        options: menu,
        confirm: true,
      };
    }
  }
  return { lines, options };
}

const CONFIRM_HINT = /Enter to (?:confirm|select|continue)/i;
const CURSOR = /^(\s*)[❯›>▶](\s+)(\S.*)$/;
const DOWN = "\x1b[B";
const UP = "\x1b[A";

/**
 * An unnumbered menu right above its "Enter to confirm" line: one choice
 * marked by the ❯ cursor, the others lined up with its text.
 */
function parseCursorMenu(
  screen: readonly string[],
): AgentPromptOption[] | null {
  const raw = screen.map((line) => line.replace(/\s+$/, ""));
  let hint = -1;
  for (let index = raw.length - 1; index >= 0; index--)
    if (CONFIRM_HINT.test(raw[index]!)) {
      hint = index;
      break;
    }
  if (hint < 0) return null;
  let end = hint - 1;
  while (end >= 0 && !raw[end]!.trim()) end--;
  let start = end;
  while (start > 0 && raw[start - 1]!.trim()) start--;
  const block = raw.slice(start, end + 1);
  const marked = block.findIndex((line) => CURSOR.test(line));
  if (marked < 0 || block.length < 2 || block.length > 9) return null;
  const [, before, gap, text] = CURSOR.exec(block[marked]!)!;
  const column = before!.length + 1 + gap!.length;
  const labels: string[] = [];
  for (const [index, line] of block.entries()) {
    if (index === marked) {
      labels.push(text!.trim());
      continue;
    }
    // Lined up with the cursor's choice, nothing in front.
    if (line.slice(0, column).trim() || !line.slice(column).trim()) return null;
    labels.push(line.slice(column).trim());
  }
  return labels.map((label, index) => {
    const moves = index - marked;
    return {
      key: "",
      label,
      input: (moves > 0 ? DOWN : UP).repeat(Math.abs(moves)) + "\r",
    };
  });
}

/** What a working agent says it is doing: Claude Code's "✳ Pondering… (12s)". */
export type AgentActivity = { word: string; detail?: string };

// A spinner glyph, a capitalized word with an ellipsis, then its details.
const ACTIVITY =
  /^\s*[^\p{L}\p{N}\s]\s+(\p{Lu}[\p{L}-]*(?:…|\.\.\.))\s*(?:\(([^)]*)\))?/u;

export function parseAgentActivity(
  screen: readonly string[],
): AgentActivity | null {
  for (let index = screen.length - 1; index >= 0; index--) {
    const match = ACTIVITY.exec(screen[index]!);
    if (match)
      return {
        word: match[1]!,
        detail: match[2]?.replace(/\s*·\s*esc to interrupt\s*$/i, "").trim(),
      };
  }
  return null;
}

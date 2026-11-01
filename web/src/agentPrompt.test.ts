import { expect, test } from "bun:test";
import { parseAgentActivity, parseAgentPrompt } from "./agentPrompt";

test("Claude Code's permission menu becomes its choices", () => {
  const prompt = parseAgentPrompt([
    "╭──────────────────────────────────────────╮",
    "│ Edit file                                │",
    "│ Do you want to make this edit to a.ts?   │",
    "│ ❯ 1. Yes                                 │",
    "│   2. Yes, allow all edits this session   │",
    "│   3. No, and tell Claude what to do (esc)│",
    "╰──────────────────────────────────────────╯",
    "",
  ]);
  expect(prompt.lines[0]).toBe("Edit file");
  expect(prompt.options).toEqual([
    { key: "1", label: "Yes", input: "1", cursor: true },
    { key: "2", label: "Yes, allow all edits this session", input: "2" },
    {
      key: "3",
      label: "No, and tell Claude what to do (esc)",
      input: "3",
    },
  ]);
});

test("a numbered list that does not start at 1 is not a menu", () => {
  expect(parseAgentPrompt(["Steps:", "3. build", "4. test"]).options).toEqual(
    [],
  );
  expect(parseAgentPrompt(["Waiting for input"]).options).toEqual([]);
});

test("Claude Code's status line gives its word and progress", () => {
  expect(
    parseAgentActivity([
      "⏺ Done with the first part.",
      "",
      "✳ Sublimating… (8m 52s · ↓ 42.3k tokens · esc to interrupt)",
      "",
      "╭────────╮",
      "│ >      │",
      "╰────────╯",
    ]),
  ).toEqual({ word: "Sublimating…", detail: "8m 52s · ↓ 42.3k tokens" });
  expect(parseAgentActivity(["* Pondering…"])).toEqual({
    word: "Pondering…",
    detail: undefined,
  });
  expect(parseAgentActivity(["- a list item…", "plain text"])).toBeNull();
});

test("Claude Code's trust question is an unnumbered menu answered with Enter", () => {
  const screen = [
    "─".repeat(40),
    " Accessing workspace:",
    "",
    " /private/tmp/newdir",
    "",
    " Quick safety check: Is this a project you created or one you trust?",
    "",
    " Security guide",
    "",
    " ❯ No, exit",
    "   Yes, I trust this folder",
    "",
    " Enter to confirm · Esc to cancel",
    "",
    "",
  ];
  const prompt = parseAgentPrompt(screen);
  expect(prompt.confirm).toBe(true);
  expect(prompt.options).toEqual([
    { key: "", label: "No, exit", input: "\r" },
    { key: "", label: "Yes, I trust this folder", input: "\x1b[B\r" },
  ]);
});

test("an idle screen with a list above the input is not a menu", () => {
  const prompt = parseAgentPrompt([
    " Next steps:",
    "   - build",
    "   - test",
    "",
    "─".repeat(40),
    "❯ ",
    "─".repeat(40),
    "  ? for shortcuts",
  ]);
  expect(prompt.options).toEqual([]);
  expect(prompt.confirm).toBeUndefined();
});

test("AskUserQuestion's menu: choices with descriptions, waiting on Enter", () => {
  const prompt = parseAgentPrompt([
    "› Message from @general-purpose (ctrl+o to expand)",
    "─".repeat(56),
    "←  ☐ Account  ☐ Login  ☐ Data  ☐ Deploy  ✔ Submit  →",
    "",
    "Which kind of Pronote account will this use?",
    "",
    "❯ 1. Parent, several kids",
    "     Espace parents with child selection per tool call",
    "  2. Parent, one child",
    "     Espace parents, single child",
    "  3. Student account",
    "     Espace eleves",
    "  4. Type something.",
    "─".repeat(56),
    "  5. Chat about this",
    "",
    "Enter to select · Tab/Arrow keys to navigate · Esc to",
    "cancel",
  ]);
  expect(prompt.confirm).toBe(true);
  expect(prompt.options).toEqual([
    {
      key: "1",
      label: "Parent, several kids",
      input: "1",
      detail: "Espace parents with child selection per tool call",
      cursor: true,
    },
    {
      key: "2",
      label: "Parent, one child",
      input: "2",
      detail: "Espace parents, single child",
    },
    { key: "3", label: "Student account", input: "3", detail: "Espace eleves" },
    {
      key: "4",
      label: "Type something.",
      input: "\x1b[B\x1b[B\x1b[B",
      detail: "Then write it in the message box",
      freeText: true,
    },
    { key: "5", label: "Chat about this", input: "5" },
  ]);
  expect(prompt.lines[prompt.lines.length - 1]).toBe(
    "Which kind of Pronote account will this use?",
  );
});

test("AskUserQuestion's questions become tabs, the colored one current", () => {
  const screen = [
    "❯ Ask me two questions",
    "←  ☒ Color  ☐ Fruit  ✔ Submit  →",
    "",
    "What is your favorite fruit?",
    "",
    "❯ 1. Apple",
    "  2. Pear",
    "",
    "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
  ];
  // "☐ Fruit" is drawn on a colored background.
  const fruit = screen[1]!.indexOf("☐ Fruit");
  const prompt = parseAgentPrompt(
    screen,
    (row, column) => row === 1 && column >= fruit && column < fruit + 7,
  );
  expect(prompt.tabs).toEqual([
    { label: "Color", done: true, current: false, input: "\x1b[D" },
    { label: "Fruit", done: false, current: true, input: "" },
    { label: "Submit", done: false, current: false, input: "\x1b[C" },
  ]);
  expect(prompt.lines).toEqual(["What is your favorite fruit?"]);
  // Not knowing which one shows: no tabs.
  expect(parseAgentPrompt(screen, () => false).tabs).toBeUndefined();
});

test("a question taking several answers: picked ones checked, no Submit meaning", () => {
  const prompt = parseAgentPrompt([
    "Demo 3: which extras would you take? (several allowed)",
    "",
    "❯ 1. [✔] Coffee",
    "     Hot and strong",
    "  2. [ ] Tea",
    "     Light and warm",
    "  3. [ ] Juice",
    "     Cold and sweet",
    "  4. [ ] Type something",
    "     Submit",
    "─".repeat(40),
    "  5. Chat about this",
    "",
    "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
  ]);
  expect(
    prompt.options.map((option) => [
      option.label,
      option.checked ?? null,
      option.detail ?? null,
    ]),
  ).toEqual([
    ["Coffee", true, "Hot and strong"],
    ["Tea", false, "Light and warm"],
    ["Juice", false, "Cold and sweet"],
    ["Type something", false, "Then write it in the message box"],
    ["Chat about this", null, null],
  ]);
});

test("Type something is reached with the arrows from the cursor", () => {
  const prompt = parseAgentPrompt([
    "Which extras?",
    "  1. [ ] Coffee",
    "❯ 2. [✔] Tea",
    "  3. [ ] Type something",
    "     Submit",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ]);
  expect(
    prompt.options.map((option) => [
      option.input,
      !!option.cursor,
      !!option.freeText,
    ]),
  ).toEqual([
    ["1", false, false],
    ["2", true, false],
    ["\x1b[B", false, true],
  ]);
});

test("several answers: Submit moves down to its line and confirms", () => {
  const prompt = parseAgentPrompt([
    "Which extras?",
    "  1. [✔] Coffee",
    "  2. [ ] Tea",
    "❯ 3. [✔] oat milk",
    "     Submit",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ]);
  expect(prompt.submit).toBe("\x1b[B\r");
});

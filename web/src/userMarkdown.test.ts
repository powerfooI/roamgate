import { describe, expect, test } from "bun:test";
import { looksLikeMarkdown } from "./userMarkdown";

describe("looksLikeMarkdown", () => {
  test("Markdown the user wrote", () => {
    for (const text of [
      "look:\n```\nconst a = 1;\n```",
      "~~~ts\nx\n~~~",
      "run `bun test` again",
      "see [the docs](https://example.com)",
      "todo:\n- one\n- two",
      "steps:\n1. build\n2. test",
      "this is **important**",
      "this is *really* it",
      "an _emphasised_ word",
    ])
      expect(looksLikeMarkdown(text)).toBe(true);
  });

  test("plain text, and text that only has Markdown's characters", () => {
    for (const text of [
      "hello\nworld",
      "fix server/src/my_module_name.ts please",
      "the file a_b_c and d_e",
      "compute 2 * 3 * 4",
      "glob src/**/*.ts",
      "snake_case_name",
      "rm -rf build",
      "2026. A year",
      "",
    ])
      expect(looksLikeMarkdown(text)).toBe(false);
  });
});

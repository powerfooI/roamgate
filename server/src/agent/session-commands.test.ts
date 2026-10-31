import { expect, test } from "bun:test";
import { parseSessionCommands } from "./session-commands";

const listing = (names: string[], content: string) => ({
  type: "attachment",
  attachment: { type: "skill_listing", names, content },
});

test("a session's skills and commands, with what they do", () => {
  expect(
    parseSessionCommands([
      listing(
        ["glab", "commit", "codex:rescue"],
        "- glab (gitlab): GitLab operations via glab CLI.\n- commit: FIRST Check the staged changes\n- codex:rescue: Delegate to Codex",
      ),
      { type: "user", message: { content: "hello" } },
      // A later listing adds to the first.
      listing(["review"], "- review: Review a pull request"),
      listing(["bad name; rm"], "- bad name; rm: no"),
    ]),
  ).toEqual([
    { name: "codex:rescue", description: "Delegate to Codex" },
    { name: "commit", description: "FIRST Check the staged changes" },
    { name: "glab", description: "GitLab operations via glab CLI." },
    { name: "review", description: "Review a pull request" },
  ]);
});

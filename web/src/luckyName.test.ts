import { expect, test } from "bun:test";
import { adjectives, animals } from "unique-names-generator";
import { luckyWorkspaceName, luckyWorktreeBranchName } from "./luckyName";

test.each([
  ["worktree branch", luckyWorktreeBranchName],
  ["workspace", luckyWorkspaceName],
] as const)(
  "generates a two-word %s name without digits",
  async (_kind, generate) => {
    const name = await generate();
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
    const [adjective, animal] = name.split("-");
    expect(adjectives).toContain(adjective);
    expect(animals).toContain(animal);
  },
);

test("every dictionary entry is safe for a two-word Git branch name", () => {
  for (const word of [...adjectives, ...animals]) {
    expect(word).toMatch(/^[a-z]+$/);
  }
});

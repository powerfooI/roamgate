import { describe, expect, test } from "bun:test";
import {
  classifyPullRequestLabel,
  type PullRequestLabelInput,
} from "./classify-pr-label";

function classify(input: Omit<PullRequestLabelInput, "changedFiles">) {
  return classifyPullRequestLabel({
    ...input,
    changedFiles: input.files.length,
  });
}

describe("pull request release-note labels", () => {
  test("labels only trusted release preparation PRs for exclusion", () => {
    expect(
      classify({
        title: "Release 0.5.0",
        author: "github-actions[bot]",
        files: ["package.json", "herdr-plugin.toml"],
      }),
    ).toBe("skip-changelog");
    expect(
      classify({
        title: "Release 9.9.9",
        author: "untrusted-contributor",
        files: ["server/src/index.ts"],
      }),
    ).toBe("enhancement");
  });

  test("recognizes explicit breaking-change markers", () => {
    for (const title of [
      "Breaking change: replace the bridge protocol",
      "[breaking] Replace the bridge protocol",
    ]) {
      expect(
        classify({
          title,
          author: "maintainer",
          files: ["server/src/index.ts"],
        }),
      ).toBe("breaking-change");
    }
    for (const title of [
      "Avoid breaking changes in the updater",
      "Fix breaking-change label detection",
    ]) {
      expect(
        classify({
          title,
          author: "maintainer",
          files: ["server/src/index.ts"],
        }),
      ).not.toBe("breaking-change");
    }
  });

  test("recognizes dependency updates without matching generic upgrades", () => {
    expect(
      classify({
        title: "Bump actions/checkout from 6 to 7",
        author: "dependabot[bot]",
        files: [".github/workflows/ci.yml"],
      }),
    ).toBe("dependencies");
    expect(
      classify({
        title: "Refresh package versions",
        author: "maintainer",
        files: ["package.json", "web/package.json", "bun.lock"],
      }),
    ).toBe("dependencies");
    expect(
      classify({
        title: "Upgrade deployment documentation",
        author: "maintainer",
        files: ["README.md"],
      }),
    ).toBe("documentation");
    expect(
      classify({
        title: "Bump bridge protocol",
        author: "maintainer",
        files: ["server/src/index.ts"],
      }),
    ).toBe("enhancement");
  });

  test("recognizes documentation-only changes", () => {
    expect(
      classify({
        title: "Streamline project documentation",
        author: "maintainer",
        files: ["README.md", "docs/ARCHITECTURE.md"],
      }),
    ).toBe("documentation");
  });

  test("recognizes fix-oriented titles", () => {
    for (const title of [
      "Fix mobile keyboard layout",
      "Restore direct desktop downloads",
      "Prevent stale terminal frames",
      "Harden update verification",
    ]) {
      expect(
        classify({
          title,
          author: "maintainer",
          files: ["web/src/App.tsx"],
        }),
      ).toBe("bug");
    }
  });

  test("uses enhancement as the default code-change category", () => {
    expect(
      classify({
        title: "Preview PDFs and Markdown images",
        author: "maintainer",
        files: ["web/src/components/FilePreviewContent.tsx"],
      }),
    ).toBe("enhancement");
  });

  test("falls back to enhancement when GitHub truncates the file list", () => {
    expect(
      classifyPullRequestLabel({
        title: "Document every generated API",
        author: "maintainer",
        changedFiles: 3001,
        files: Array.from({ length: 3000 }, (_, index) => `docs/${index}.md`),
      }),
    ).toBe("enhancement");
  });
});

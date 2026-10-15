import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PullRequestStatus } from "../../../shared/pullRequest";
import { WorktreePullRequestBadge } from "./WorktreePullRequestBadge";

const base: PullRequestStatus = {
  state: "ready",
  root: "/repo",
  branch: "topic",
  remotes: [],
  refreshedAt: "2026-10-01T00:00:00Z",
};
const render = (status?: PullRequestStatus) =>
  renderToStaticMarkup(createElement(WorktreePullRequestBadge, { status }));

test("worktree badges distinguish GitHub/GitLab merge states and expose details with native disclosure controls", () => {
  for (const provider of ["github", "gitlab"] as const) {
    for (const [state, draft, label] of [
      ["merged", true, "Merged"],
      ["closed", false, "Closed without merge"],
      ["open", false, "Open"],
      ["opened", false, "Open"],
      ["open", true, "Draft"],
      ["unexpected", false, "Unknown"],
    ] as const) {
      const html = render({
        ...base,
        provider,
        request: {
          id: "team/project#12",
          number: 12,
          title: "Ship feature",
          author: "alice",
          source: "topic",
          target: "main",
          state,
          draft,
          url: `https://${provider}.com/team/project`,
        },
      });
      expect(html).toContain(`<summary class="badge worktree-review-badge"`);
      expect(html).toContain(
        `${provider === "github" ? "PR" : "MR"} #12: ${label}`,
      );
      expect(html).toContain("Last checked:");
      expect(html).toContain(`dateTime="${base.refreshedAt}"`);
      expect(html).toContain('rel="noopener noreferrer"');
    }
  }
});

test("unresolved and failed worktree badges never claim a merged request", () => {
  const merged = {
    id: "r#1",
    number: 1,
    title: "Old",
    author: "a",
    source: "t",
    target: "m",
    state: "merged",
    draft: false,
    url: "https://github.com/a/r/pull/1",
  };
  for (const state of [
    "select_remote",
    "select_match",
    "unsupported",
    "missing_cli",
    "unauthenticated",
    "no_match",
    "detached",
    "error",
  ] as const) {
    const html = render({
      ...base,
      state,
      message: "Explicit diagnostic",
      request: merged,
    });
    expect(html).not.toContain("Merged");
    expect(html).not.toContain("href=");
    expect(html).toContain("Explicit diagnostic");
  }
  expect(render()).toContain("PR/MR: Loading...");
});

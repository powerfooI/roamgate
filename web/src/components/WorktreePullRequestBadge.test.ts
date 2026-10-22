import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  PullRequestStatus,
  PullRequestSummary,
} from "../../../shared/pullRequest";
import { workspacePullRequest } from "../workspaceTreeBadges";
import { WorktreePullRequestBadge } from "./WorktreePullRequestBadge";

const base: PullRequestStatus = {
  state: "ready",
  root: "/repo",
  branch: "topic",
  remotes: [],
  refreshedAt: "2026-10-01T00:00:00Z",
};
const render = (
  status?: PullRequestStatus & Pick<PullRequestSummary, "stale">,
) => renderToStaticMarkup(createElement(WorktreePullRequestBadge, { status }));

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

test("stale worktree badges stay actionable and show the last successful check", () => {
  const status = {
    ...base,
    provider: "gitlab" as const,
    stale: { failedAt: "2026-10-02T00:00:00Z" },
    request: {
      id: "team/project#3",
      number: 3,
      title: "Ship feature",
      author: "alice",
      source: "topic",
      target: "main",
      state: "opened",
      draft: false,
      url: "https://gitlab.com/team/project/-/merge_requests/3",
    },
  };
  const html = render(status);
  expect(html).toContain("MR #3: Open (last known)");
  expect(html).toContain('data-stale="true"');
  expect(html).toContain("Open MR #3");
  expect(html).toContain('dateTime="2026-10-02T00:00:00Z"');
  expect(html).toContain("Last successful check");
  expect(html).toContain(`dateTime="${base.refreshedAt}"`);
  const cached = {
    ...status,
    stale: { message: "Refreshing PR/MR status." },
  };
  const cachedHtml = render(cached);
  expect(cachedHtml).toContain("MR #3: Open (last known)");
  expect(cachedHtml).toContain("Refreshing PR/MR status.");
  expect(cachedHtml).not.toContain("Refresh failed");
  expect(cachedHtml).not.toContain("Invalid Date");
  expect(workspacePullRequest(cached)?.title).toContain(
    "Refreshing PR/MR status.",
  );
});

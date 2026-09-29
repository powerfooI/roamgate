import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PullRequestStatus } from "../../../shared/pullRequest";
import { PullRequestCardView, PullRequestSelectors } from "./PullRequestCard";

const base: PullRequestStatus = {
  state: "select_remote",
  root: "/repo",
  branch: "feature",
  refreshedAt: "2026-09-29T00:00:00Z",
  remotes: [
    { name: "remaining", host: "github.com", repository: "team/project" },
  ],
};
function render(current: PullRequestStatus) {
  return renderToStaticMarkup(
    createElement(PullRequestSelectors, {
      current,
      onRemoteChange() {},
      onMatchChange() {},
    }),
  );
}

test("a removed selection can be replaced even when only one remote remains", () => {
  const markup = render(base);
  expect(markup).toContain("Source remote");
  expect(markup).toContain("Select remote");
  expect(markup).toContain('aria-label="Source remote"');
  expect(markup).not.toContain("<select");
});

test("a disappeared PR can be replaced even when only one match remains", () => {
  const markup = render({
    ...base,
    state: "select_match",
    remote: "remaining",
    matches: [
      {
        id: "team/project#2",
        number: 2,
        title: "Remaining request",
        author: "alice",
        source: "feature",
        target: "main",
        state: "open",
        draft: false,
        url: "https://github.com/team/project/pull/2",
      },
    ],
  });
  expect(markup).toContain("Matching request");
  expect(markup).toContain("<select>");
  expect(markup).toContain('<option value="team/project#2">');
});

test("status cards keep diagnostics behind disclosure and unavailable checks explicit", () => {
  const renderCard = (current: PullRequestStatus | null, loading = false) =>
    renderToStaticMarkup(
      createElement(PullRequestCardView, {
        current,
        loading,
        error: "",
        finishedAt: current?.refreshedAt ?? "",
        onRefresh() {},
        onRemoteChange() {},
        onMatchChange() {},
      }),
    );
  const failed = renderCard({
    ...base,
    state: "error",
    message: "Check repository access.",
  });
  expect(failed).toContain("Status unavailable");
  expect(failed).toContain('<details class="pull-request-card-context">');
  expect(failed).toContain("Check repository access.");
  expect(failed).toContain("/repo");
  expect(failed).not.toContain(" open=");
  expect(failed).toContain('aria-label="Refresh PR/MR status"');
  expect(renderCard(null, true)).toContain('disabled=""');
  for (const provider of ["github", "gitlab"] as const) {
    const ready = renderCard({
      ...base,
      state: "ready",
      provider,
      request: {
        id: "team/project#2",
        number: 2,
        title: "A focused request",
        author: "alice",
        source: "feature",
        target: "main",
        state: "open",
        draft: true,
        url: "https://github.com/team/project/pull/2",
      },
    });
    expect(ready.match(/A focused request/g)).toHaveLength(1);
    expect(ready).toContain('data-state="draft"');
    expect(ready).toContain(
      `aria-label="Open ${provider === "github" ? "GitHub" : "GitLab"} #2 in a new tab"`,
    );
    expect(ready).toContain(
      `>${provider === "github" ? "GitHub" : "GitLab"} #2<svg`,
    );
    expect(ready).toMatch(
      /class="pull-request-card-signals"><div class="pull-request-card-route"/,
    );
    expect(ready.match(/<dd>Unavailable<\/dd>/g)).toHaveLength(2);
    expect(ready).toContain(
      provider === "github" ? "Review decision" : "Approvals",
    );
    expect(ready).toContain('rel="noopener noreferrer"');
  }
});

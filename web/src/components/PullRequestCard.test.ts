import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PullRequestStatus } from "../../../shared/pullRequest";
import { PullRequestSelectors } from "./PullRequestCard";

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
  expect(markup).toContain("<select>");
  expect(markup).toContain('<option value="remaining">');
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

import { expect, test } from "bun:test";
import { elapsedLabel, initialJiraQuery, relativeAge } from "./issueTrackerFormat";

const now = Date.parse("2026-11-04T12:00:00.000Z");

test("relativeAge uses the largest whole unit", () => {
  expect(relativeAge("2026-11-04T11:59:00.000Z", now)).toBe("1 minute ago");
  expect(relativeAge("2026-10-31T12:00:00.000Z", now)).toBe("4 days ago");
  expect(relativeAge("2026-11-04T12:00:00.000Z", now)).toBe("now");
  expect(relativeAge("nope", now)).toBe("");
});

test("elapsedLabel is compact", () => {
  expect(elapsedLabel("2026-11-04T11:59:15.000Z", now)).toBe("45s");
  expect(elapsedLabel("2026-11-04T11:54:00.000Z", now)).toBe("6m");
  expect(elapsedLabel("2026-11-04T09:55:00.000Z", now)).toBe("2h 5m");
  expect(elapsedLabel("2026-11-04T10:00:00.000Z", now)).toBe("2h");
});

test("default JQL seeds structured filters when it can (AC32)", () => {
  expect(
    initialJiraQuery({
      default_project: "SDS",
      default_jql: "assignee = currentUser()",
    }),
  ).toEqual({
    mode: "filters",
    filters: {
      project: "SDS",
      assignee: "me",
      sort: { field: "updated", dir: "desc" },
    },
  });
  expect(
    initialJiraQuery({ default_project: null, default_jql: "" }),
  ).toEqual({
    mode: "filters",
    filters: { assignee: "any", sort: { field: "updated", dir: "desc" } },
  });
});

test("other default JQL opens raw JQL mode scoped to the project", () => {
  expect(
    initialJiraQuery({
      default_project: "SDS",
      default_jql: "labels = agent-ready",
    }),
  ).toEqual({
    mode: "jql",
    jql: 'project = "SDS" AND (labels = agent-ready)',
  });
});

test("a default ORDER BY stays outside the project scope", () => {
  expect(
    initialJiraQuery({
      default_project: "SDS",
      default_jql: "labels = x ORDER BY created DESC",
    }),
  ).toEqual({
    mode: "jql",
    jql: 'project = "SDS" AND (labels = x) ORDER BY created DESC',
  });
});

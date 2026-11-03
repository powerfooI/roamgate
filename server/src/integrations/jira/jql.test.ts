import { expect, test } from "bun:test";
import { buildJql, jqlQuote } from "./jql";

test("no filters sorts by most recently updated", () => {
  expect(buildJql()).toBe("ORDER BY updated DESC");
});

test("each structured filter becomes one clause, in a stable order", () => {
  expect(
    buildJql({
      project: "SDS",
      types: ["Bug", "Story"],
      statuses: ["To Do", "In Progress"],
      assignee: "me",
      text: "back button",
    }),
  ).toBe(
    'project = "SDS" AND issuetype in ("Bug", "Story") AND status in ("To Do", "In Progress") AND assignee = currentUser() AND text ~ "back button" ORDER BY updated DESC',
  );
});

test("assignee filters", () => {
  expect(buildJql({ assignee: "unassigned" })).toBe(
    "assignee is EMPTY ORDER BY updated DESC",
  );
  expect(buildJql({ assignee: "any" })).toBe("ORDER BY updated DESC");
});

test("an issue key searches by key", () => {
  expect(buildJql({ text: "sds-1679" })).toBe(
    'key = "SDS-1679" ORDER BY updated DESC',
  );
});

test("search text quotes and backslashes are escaped", () => {
  expect(jqlQuote('say "hi" \\ bye')).toBe('"say \\"hi\\" \\\\ bye"');
  expect(buildJql({ text: 'x" OR project = "Y' })).toBe(
    'text ~ "x\\" OR project = \\"Y" ORDER BY updated DESC',
  );
});

test("sort field and direction", () => {
  expect(buildJql({ sort: { field: "created", dir: "asc" } })).toBe(
    "ORDER BY created ASC, updated DESC",
  );
  expect(buildJql({ sort: { field: "key", dir: "desc" } })).toBe(
    "ORDER BY key DESC, updated DESC",
  );
  expect(buildJql({ sort: { field: "updated", dir: "asc" } })).toBe(
    "ORDER BY updated ASC",
  );
});

test("empty and oversized list values are ignored", () => {
  expect(buildJql({ types: ["", " ", "x".repeat(500)] })).toBe(
    "ORDER BY updated DESC",
  );
});

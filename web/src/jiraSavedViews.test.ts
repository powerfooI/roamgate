import { expect, test } from "bun:test";
import { addSavedView, parseSavedViews, removeSavedView } from "./jiraSavedViews";

test("saved views keep filters or raw JQL and replace same-named views (AC36)", () => {
  let views = addSavedView([], "Mine", { filters: { assignee: "me" } }, "a");
  views = addSavedView(views, "Bugs", { jql: "type = Bug" }, "b");
  views = addSavedView(views, "Mine", { filters: { assignee: "any" } }, "c");
  expect(views).toEqual([
    { id: "c", name: "Mine", filters: { assignee: "any" } },
    { id: "b", name: "Bugs", jql: "type = Bug" },
  ]);
  expect(removeSavedView(views, "b").map((view) => view.id)).toEqual(["c"]);
  expect(() => addSavedView(views, " ", { jql: "x" })).toThrow("Name");
});

test("parseSavedViews drops malformed entries", () => {
  expect(
    parseSavedViews([
      { id: "a", name: "ok", jql: "x" },
      { id: "b", name: "no query" },
      { name: "no id", jql: "x" },
      "junk",
    ]),
  ).toEqual([{ id: "a", name: "ok", jql: "x" }]);
  expect(parseSavedViews(null)).toEqual([]);
});

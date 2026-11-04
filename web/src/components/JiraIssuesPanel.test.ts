import { expect, test } from "bun:test";
import { firstPage, nextPage, pageRange, previousPage } from "./JiraIssuesPanel";

test("token pagination moves forward and back (AC38)", () => {
  const second = nextPage(firstPage, "t2");
  expect(second).toEqual({ tokens: [null, "t2"], index: 1 });
  const third = nextPage(second, "t3");
  expect(previousPage(third)).toEqual({ tokens: [null, "t2", "t3"], index: 1 });
  // Moving forward from an earlier page drops the stale tail.
  expect(nextPage(previousPage(third), "t3b")).toEqual({
    tokens: [null, "t2", "t3b"],
    index: 2,
  });
  expect(previousPage(firstPage)).toBe(firstPage);
});

test("pageRange shows the 25-per-page range", () => {
  expect(pageRange(0, 25)).toBe("1–25");
  expect(pageRange(1, 3)).toBe("26–28");
  expect(pageRange(0, 0)).toBe("0 results");
});

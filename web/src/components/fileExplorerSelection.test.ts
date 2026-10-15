import { expect, test } from "bun:test";
import { selectFilePaths } from "./fileExplorerSelection";

test("plain clicks replace selection and Cmd/Ctrl-click toggles it", () => {
  const selected = new Set(["a", "b"]);
  expect([
    ...selectFilePaths(selected, "c", ["a", "b", "c"], "a", false, false),
  ]).toEqual(["c"]);
  expect([
    ...selectFilePaths(selected, "b", ["a", "b", "c"], "a", false, true),
  ]).toEqual(["a"]);
  expect([
    ...selectFilePaths(selected, "c", ["a", "b", "c"], "a", false, true),
  ]).toEqual(["a", "b", "c"]);
  expect([...selected]).toEqual(["a", "b"]);
});

test("Shift selects the visible range in either direction and can extend a selection", () => {
  const paths = ["a", "b", "c", "d"];
  expect([
    ...selectFilePaths(new Set(["d"]), "c", paths, "a", true, false),
  ]).toEqual(["a", "b", "c"]);
  expect([...selectFilePaths(new Set(), "a", paths, "c", true, false)]).toEqual(
    ["a", "b", "c"],
  );
  expect([
    ...selectFilePaths(new Set(["d"]), "b", paths, "a", true, true),
  ]).toEqual(["d", "a", "b"]);
  expect([
    ...selectFilePaths(new Set(["d"]), "c", paths, "missing", true, false),
  ]).toEqual(["c"]);
});

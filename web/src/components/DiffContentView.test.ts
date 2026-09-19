import { describe, expect, test } from "bun:test";
import type { GitDiffEntry, GitDiffFile } from "../types";
import { IMAGE_MIME_TYPES } from "../../../shared/filePreview";
import { expandDiffEntryOnActivate } from "./diffContentState";
import {
  diffContentEntries,
  diffHunkTargets,
  diffSearchGroups,
  nextDiffHunkIndex,
  isImageDiff,
} from "./DiffContentView";

const entries: GitDiffEntry[] = [
  { path: "src/one.ts", kind: "unstaged", status: "M" },
  { path: "src/two.ts", kind: "unstaged", status: "M" },
  { path: "asset.png", kind: "unstaged", status: "M" },
];

function diffFile(path: string, diff: string): GitDiffFile {
  return {
    workspace_id: "workspace",
    root: "/tmp/workspace",
    path,
    kind: "unstaged",
    diff,
    truncated: false,
  };
}

describe("expandDiffEntryOnActivate", () => {
  test("marks a collapsed entry as expanded", () => {
    const current = new Map([["unstaged:a.ts", true]]);
    const next = expandDiffEntryOnActivate(current, "unstaged:a.ts");
    expect(next.get("unstaged:a.ts")).toBe(false);
  });

  test("keeps the same map when the entry is already expanded", () => {
    const current = new Map([["unstaged:a.ts", false]]);
    expect(expandDiffEntryOnActivate(current, "unstaged:a.ts")).toBe(current);
  });

  test("preserves other entries and tolerates an empty state", () => {
    const current = new Map([["unstaged:b.ts", true]]);
    const next = expandDiffEntryOnActivate(current, "unstaged:a.ts");
    expect(next.get("unstaged:b.ts")).toBe(true);
    expect(expandDiffEntryOnActivate(undefined, "unstaged:a.ts").size).toBe(1);
  });
});

test("Changes previews every supported binary image without replacing text diffs", () => {
  for (const extension of IMAGE_MIME_TYPES.keys()) {
    const path = `image.${extension.toUpperCase()}`;
    expect(isImageDiff(path, "Binary files a/image and b/image differ")).toBe(
      true,
    );
    expect(isImageDiff(path, "GIT binary patch\nliteral 3")).toBe(true);
    expect(isImageDiff(path, "")).toBe(true);
    expect(isImageDiff(path, "@@ -1 +1 @@\n-<svg/>\n+<svg>...</svg>")).toBe(
      false,
    );
  }
  expect(isImageDiff("document.pdf", "Binary files a and b differ")).toBe(
    false,
  );
  expect(isImageDiff("README.md", "")).toBe(false);
});

describe("diffContentEntries", () => {
  test("keeps every summary entry even when only one diff is loaded", () => {
    expect(diffContentEntries(entries, entries[0])).toBe(entries);
  });

  test("falls back to the selected entry before a summary is available", () => {
    expect(diffContentEntries([], entries[0])).toEqual([entries[0]]);
    expect(diffContentEntries([], null)).toEqual([]);
  });
});

describe("diffHunkTargets", () => {
  test("starts navigation at the first or last hunk", () => {
    expect(nextDiffHunkIndex(-1, 1, 3)).toBe(0);
    expect(nextDiffHunkIndex(-1, -1, 3)).toBe(2);
    expect(nextDiffHunkIndex(2, 1, 3)).toBe(0);
    expect(nextDiffHunkIndex(0, -1, 3)).toBe(2);
    expect(nextDiffHunkIndex(0, 1, 0)).toBe(-1);
  });

  test("locates the first changed lines in each patch hunk", () => {
    expect(
      diffHunkTargets(
        [
          "@@ -3,4 +3,5 @@",
          " context",
          "-before",
          "+after",
          "+added",
          "@@ -20,2 +21,0 @@",
          "-removed",
        ].join("\n"),
      ),
    ).toEqual([
      { oldLine: 4, newLine: 4 },
      { oldLine: 20, newLine: null },
    ]);
  });
});

describe("diffSearchGroups", () => {
  test("finds loaded files case-insensitively without double-counting lines", () => {
    const result = diffSearchGroups(
      entries,
      {
        "unstaged:src/one.ts": diffFile(
          "src/one.ts",
          "diff --git a/src/one.ts b/src/one.ts\n+Needle needle\n",
        ),
        "unstaged:src/two.ts": diffFile(
          "src/two.ts",
          "diff --git a/src/two.ts b/src/two.ts\n-needle\n",
        ),
      },
      "needle",
    );

    expect(result).toEqual({
      groups: [{ key: "unstaged:src/one.ts" }, { key: "unstaged:src/two.ts" }],
      count: 2,
    });
  });

  test("ignores unloaded and binary diffs", () => {
    const result = diffSearchGroups(
      entries,
      {
        "unstaged:asset.png": diffFile(
          "asset.png",
          "Binary files contain needle",
        ),
      },
      "needle",
    );

    expect(result).toEqual({ groups: [], count: 0 });
  });
});

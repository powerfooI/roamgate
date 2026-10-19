import { describe, expect, test } from "bun:test";
import { selectDiffBase } from "./diff-base";

const refs = (...names: string[]) => names.map((name) => ({ name }));

describe("Inspector comparison base selection", () => {
  test("supports local main and master without a remote", () => {
    for (const branch of ["main", "master"]) {
      expect(
        selectDiffBase(refs(`refs/heads/${branch}`, "refs/heads/feature"), "")
          .base,
      ).toBe(`refs/heads/${branch}`);
    }
  });

  test("prefers the recorded custom remote default and its local branch", () => {
    const branches = [
      ...refs(
        "refs/heads/main",
        "refs/heads/release/stable",
        "refs/remotes/origin/release/stable",
      ),
      {
        name: "refs/remotes/origin/HEAD",
        symbolic: "refs/remotes/origin/release/stable",
      },
    ];
    expect(selectDiffBase(branches, "main")).toEqual({
      base: "refs/heads/release/stable",
      branches: branches.slice(0, 3).map((ref) => ref.name),
    });
    expect(selectDiffBase(branches.slice(2), "").base).toBe(
      "refs/remotes/origin/release/stable",
    );
  });

  test("supports other remotes, configured local defaults, and origin fallbacks", () => {
    expect(
      selectDiffBase(
        [
          ...refs("refs/remotes/upstream/trunk"),
          {
            name: "refs/remotes/upstream/HEAD",
            symbolic: "refs/remotes/upstream/trunk",
          },
        ],
        "",
      ).base,
    ).toBe("refs/remotes/upstream/trunk");
    expect(
      selectDiffBase(refs("refs/heads/trunk", "refs/heads/main"), "trunk").base,
    ).toBe("refs/heads/trunk");
    expect(selectDiffBase(refs("refs/remotes/origin/master"), "").base).toBe(
      "refs/remotes/origin/master",
    );
  });

  test("explicit selection wins and rejects revisions, options, and missing branches", () => {
    const branches = refs(
      "refs/heads/main",
      "refs/heads/custom",
      "refs/remotes/upstream/custom",
    );
    for (const name of ["custom", "refs/heads/custom"]) {
      expect(selectDiffBase(branches, "", name).base).toBe("refs/heads/custom");
    }
    expect(selectDiffBase(branches, "", "upstream/custom").base).toBe(
      "refs/remotes/upstream/custom",
    );
    for (const invalid of [
      "missing",
      "HEAD~1",
      "--help",
      "main; touch /tmp/nope",
      {},
      null,
    ]) {
      expect(() => selectDiffBase(branches, "", invalid)).toThrow(
        "Comparison branch was not found",
      );
    }
  });

  test("does not mistake current feature or stale metadata for a default", () => {
    expect(
      selectDiffBase(
        [
          ...refs("refs/heads/feature"),
          {
            name: "refs/remotes/origin/HEAD",
            symbolic: "refs/remotes/origin/missing",
          },
        ],
        "missing",
      ).base,
    ).toBeUndefined();
  });
});

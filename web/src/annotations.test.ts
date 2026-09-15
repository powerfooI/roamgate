import { describe, expect, test } from "bun:test";
import {
  annotationDraftStorageKey,
  compileReviewFeedback,
  createReviewAnnotation,
  findDiffReviewLine,
  findDiffReviewSelection,
  moveReviewAnnotation,
  parseDiffReviewLines,
  parseReviewAnnotation,
  fileReviewLineLabel,
  readReviewAnnotations,
  reanchorDiffReviewAnnotations,
  reanchorFileReviewAnnotations,
  reviewAgentPanes,
  removeDeliveredReviewAnnotations,
  MAX_QUOTE_LENGTH,
  type TerminalReviewAnnotation,
  writeReviewAnnotations,
  type DiffReviewAnnotation,
  type FileLineReviewAnnotation,
  type ReviewAnnotation,
} from "./annotations";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    values,
  };
}

const diffPatch = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -10,3 +10,4 @@ function run() {",
  " keep();",
  "-oldCall();",
  "+newCall();",
  "+finish();",
  " done();",
].join("\n");

function diffAnnotation(
  patch: Partial<DiffReviewAnnotation> = {},
): DiffReviewAnnotation {
  return {
    id: "a1",
    source: "diff",
    path: "src/app.ts",
    kind: "unstaged",
    side: "new",
    line: 12,
    quote: "finish();",
    hunk: "@@ -10,3 +10,4 @@ function run() {",
    comment: "Handle this failure.",
    createdAt: 1,
    ...patch,
  };
}

describe("review annotation drafts", () => {
  test("uses durable connection and checkout identity for persistence", () => {
    const key = annotationDraftStorageKey({
      kind: "worktree",
      connectionId: "remote/a",
      workspaceId: "workspace-1",
      repoKey: "repo",
      checkoutKey: "checkout",
      checkoutPath: "/worktree",
    });
    expect(key).toContain("remote%2Fa");
    expect(decodeURIComponent(key)).toContain(
      "workspaceAnnotations:v1:checkout:checkout",
    );
  });

  test("round-trips valid drafts and drops malformed records", () => {
    const storage = memoryStorage();
    const annotations = [diffAnnotation()];
    writeReviewAnnotations(storage, "draft", annotations);
    storage.setItem(
      "mixed",
      JSON.stringify([annotations[0], { source: "diff", path: "missing" }]),
    );
    expect(readReviewAnnotations(storage, "draft")).toEqual(annotations);
    expect(readReviewAnnotations(storage, "mixed")).toEqual(annotations);
    expect(writeReviewAnnotations(storage, "draft", [])).toBe(true);
    expect(storage.getItem("draft")).toBeNull();
    expect(
      writeReviewAnnotations(
        {
          setItem: () => {
            throw new Error("storage blocked");
          },
          removeItem: () => {
            throw new Error("storage blocked");
          },
        },
        "draft",
        annotations,
      ),
    ).toBe(false);
  });

  test("creates and reorders annotations without mutating the input", () => {
    const first = createReviewAnnotation(
      {
        source: "file",
        anchor: "line",
        path: "a.ts",
        line: 1,
        quote: "a",
        comment: "First",
      },
      () => "first",
      10,
    );
    const second = { ...first, id: "second", comment: "Second" };
    const source = [first, second];
    expect(
      moveReviewAnnotation(source, "second", -1).map((item) => item.id),
    ).toEqual(["second", "first"]);
    expect(source.map((item) => item.id)).toEqual(["first", "second"]);
  });
});

describe("annotation anchors", () => {
  test("parses old, new, and context sides from a patch", () => {
    const lines = parseDiffReviewLines(diffPatch);
    expect(lines).toContainEqual({
      side: "old",
      line: 11,
      quote: "oldCall();",
      hunk: "@@ -10,3 +10,4 @@ function run() {",
    });
    expect(findDiffReviewLine(diffPatch, "new", 12)?.quote).toBe("finish();");
    expect(findDiffReviewLine(diffPatch, "old", 12)?.quote).toBe("done();");
  });

  test("captures dragged line ranges on one side or across diff sides", () => {
    expect(
      findDiffReviewSelection(diffPatch, {
        start: 11,
        side: "additions",
        end: 12,
      }),
    ).toEqual({
      side: "new",
      line: 11,
      endLine: 12,
      quote: "newCall();\nfinish();",
      hunk: "@@ -10,3 +10,4 @@ function run() {",
    });
    expect(
      findDiffReviewSelection(diffPatch, {
        start: 11,
        side: "deletions",
        end: 12,
        endSide: "additions",
      }),
    ).toEqual({
      side: "old",
      line: 11,
      endSide: "new",
      endLine: 12,
      quote: "oldCall();\nnewCall();\nfinish();",
      hunk: "@@ -10,3 +10,4 @@ function run() {",
    });

    const pairedPatch = [
      "@@ -1,2 +1,2 @@",
      "-oldOne();",
      "-oldTwo();",
      "+newOne();",
      "+newTwo();",
    ].join("\n");
    expect(
      findDiffReviewSelection(
        pairedPatch,
        {
          start: 1,
          side: "deletions",
          end: 1,
          endSide: "additions",
        },
        "split",
      ),
    ).toMatchObject({
      quote: "oldOne();\nnewOne();",
      line: 1,
      endLine: 1,
    });
  });

  test("reanchors moved diff content and marks missing content stale", () => {
    const movedPatch = diffPatch.replace(
      "+finish();",
      "+padding();\n+finish();",
    );
    const moved = reanchorDiffReviewAnnotations(
      [diffAnnotation()],
      "src/app.ts",
      "unstaged",
      movedPatch,
    )[0];
    expect(moved).toMatchObject({ line: 13, stale: false });

    const stale = reanchorDiffReviewAnnotations(
      [diffAnnotation()],
      "src/app.ts",
      "unstaged",
      diffPatch.replace("+finish();\n", ""),
    )[0];
    expect(stale.stale).toBe(true);

    const otherScope = reanchorDiffReviewAnnotations(
      [diffAnnotation()],
      "src/app.ts",
      "staged",
      "@@ -1 +1 @@\n-old\n+new\n",
    )[0];
    expect(otherScope).toMatchObject({ line: 12 });
    expect(otherScope.stale).toBeUndefined();

    const range = {
      ...diffAnnotation(),
      line: 11,
      endLine: 12,
      quote: "newCall();\nfinish();",
    };
    const movedRange = reanchorDiffReviewAnnotations(
      [range],
      "src/app.ts",
      "unstaged",
      diffPatch.replace("+newCall();", "+padding();\n+newCall();"),
    )[0];
    expect(movedRange).toMatchObject({
      line: 12,
      endLine: 13,
      stale: false,
    });
  });

  test("reanchors file lines and preserves stale Markdown quotes", () => {
    const line: ReviewAnnotation = {
      id: "line",
      source: "file",
      anchor: "line",
      path: "docs/plan.md",
      line: 2,
      quote: "target",
      comment: "Explain this.",
      createdAt: 1,
    };
    const quote: ReviewAnnotation = {
      id: "quote",
      source: "file",
      anchor: "quote",
      path: "docs/plan.md",
      quote: "gradual rollout",
      section: ["Launch", "Rollout"],
      comment: "Which cohort?",
      createdAt: 2,
    };
    const anchored = reanchorFileReviewAnnotations(
      [line, quote],
      "docs/plan.md",
      "intro\npadding\ntarget\nA gradual   rollout begins.",
    );
    expect(anchored[0]).toMatchObject({ line: 3, stale: false });
    expect(anchored[1].stale).toBeFalsy();

    const crlfAnchored = reanchorFileReviewAnnotations(
      [{ ...line, line: 2 }],
      "docs/plan.md",
      "intro\r\ntarget\r\nend",
    );
    expect(crlfAnchored[0]).toMatchObject({ line: 2 });
    expect(crlfAnchored[0].stale).toBeUndefined();

    const stale = reanchorFileReviewAnnotations(
      anchored,
      "docs/plan.md",
      "intro only",
    );
    expect(stale.every((annotation) => annotation.stale)).toBe(true);
  });
});

describe("file line ranges", () => {
  const range: FileLineReviewAnnotation = {
    id: "range",
    source: "file",
    anchor: "line",
    path: "src/app.ts",
    line: 2,
    endLine: 4,
    quote: "first\n\nlast",
    comment: "Review this block.",
    createdAt: 1,
  };

  test("persists ranges and rejects invalid end lines", () => {
    const storage = memoryStorage();
    writeReviewAnnotations(storage, "ranges", [range]);
    expect(readReviewAnnotations(storage, "ranges")).toEqual([range]);
    for (const endLine of [0, 1, -1, 2.5, "4", null]) {
      expect(parseReviewAnnotation({ ...range, endLine })).toBeNull();
    }
    expect(
      parseReviewAnnotation({ ...range, endLine: undefined, quote: "first" }),
    ).toMatchObject({ line: 2 });
  });

  test("labels ranges in the panel and compiled feedback", () => {
    expect(fileReviewLineLabel(range)).toBe("lines 2-4");
    expect(fileReviewLineLabel({ line: 2 })).toBe("line 2");
    expect(compileReviewFeedback([range])).toContain(
      "`src/app.ts` (lines 2-4)",
    );
    expect(compileReviewFeedback([range])).toContain("> first\n> \n> last");
  });

  test("reanchors an entire range after lines move, including CRLF files", () => {
    const unchanged = reanchorFileReviewAnnotations(
      [range],
      range.path,
      "intro\nfirst\n\nlast",
    );
    expect(unchanged[0]).toBe(range);
    const moved = reanchorFileReviewAnnotations(
      [range],
      range.path,
      "intro\r\npadding\r\nfirst\r\n\r\nlast",
    );
    expect(moved[0]).toMatchObject({ line: 3, endLine: 5, stale: false });
  });

  test("marks edited ranges stale instead of anchoring only their first line", () => {
    const changed = reanchorFileReviewAnnotations(
      [range],
      range.path,
      "intro\nfirst\nchanged\nlast",
    );
    expect(changed[0]).toMatchObject({ line: 2, endLine: 4, stale: true });
    const restored = reanchorFileReviewAnnotations(
      changed,
      range.path,
      "first\n\nlast",
    );
    expect(restored[0]).toMatchObject({ line: 1, endLine: 3, stale: false });
    expect(reanchorFileReviewAnnotations([range], "other.ts", "")[0]).toBe(
      range,
    );
  });
});

describe("compiled feedback and delivery targets", () => {
  test("compiles diff, file-line, and Markdown annotations", () => {
    const message = compileReviewFeedback([
      diffAnnotation(),
      {
        id: "m1",
        source: "file",
        anchor: "quote",
        path: "docs/plan.md",
        quote: "We will migrate gradually.",
        section: ["Launch", "Rollout"],
        comment: "Which users are first?",
        createdAt: 2,
        stale: true,
      },
    ]);
    expect(message).toContain("Review feedback:");
    expect(message).toContain("`src/app.ts` (new line 12)");
    expect(message).toContain("> finish();");
    expect(message).toContain(
      '`docs/plan.md` § "Launch › Rollout" (anchor may be stale)',
    );
    expect(message).toContain("Which users are first?");

    const rangeMessage = compileReviewFeedback([
      { ...diffAnnotation(), line: 11, endLine: 12 },
    ]);
    expect(rangeMessage).toContain("`src/app.ts` (new lines 11–12)");
  });

  test("prefers the originating agent pane and keeps a clipboard fallback", () => {
    const panes = [
      {
        pane_id: "focused",
        terminal_id: "t1",
        workspace_id: "w1",
        tab_id: "tab",
        focused: true,
        agent: "pi",
        agent_status: "idle",
        revision: 1,
      },
      {
        pane_id: "origin",
        terminal_id: "t2",
        workspace_id: "w1",
        tab_id: "tab",
        focused: false,
        agent: "codex",
        agent_status: "unknown",
        revision: 1,
      },
    ];
    expect(
      reviewAgentPanes(panes, "w1", "origin").map((pane) => pane.pane_id),
    ).toEqual(["origin", "focused"]);
    expect(reviewAgentPanes(panes, "missing")).toEqual([]);
  });
});

describe("terminal review annotations", () => {
  const terminal: TerminalReviewAnnotation = {
    id: "terminal-annotation",
    source: "terminal",
    anchor: "quote",
    paneId: "pane-one",
    title: "Agent · pane-one",
    quote: "Selected output\nnext line",
    comment: "Explain this result.",
    createdAt: 2,
  };
  test("persists mixed sources without requiring or retaining buffer coordinates", () => {
    const storage = memoryStorage();
    const file: FileLineReviewAnnotation = {
      id: "file",
      source: "file",
      anchor: "line",
      path: "file.ts",
      line: 1,
      quote: "code",
      comment: "Fix",
      createdAt: 3,
    };
    const mixed = [diffAnnotation(), terminal, file];
    expect(writeReviewAnnotations(storage, "mixed", mixed)).toBe(true);
    expect(readReviewAnnotations(storage, "mixed")).toEqual(mixed);
    expect(
      parseReviewAnnotation({
        ...terminal,
        path: "ignored",
        line: 99,
        bufferY: 42,
      }),
    ).toEqual(terminal);
    expect(moveReviewAnnotation(mixed, terminal.id, -1)[0]).toEqual(terminal);
    expect(reanchorFileReviewAnnotations(mixed, "file.ts", "code")[1]).toBe(
      terminal,
    );
    expect(
      reanchorDiffReviewAnnotations(
        mixed,
        "src/app.ts",
        "unstaged",
        diffPatch,
      )[1],
    ).toBe(terminal);
    const feedback = compileReviewFeedback(mixed);
    expect(feedback).toContain(
      "2. terminal pane `Agent · pane-one` (selected passage):\n> Selected output\n> next line\n\nExplain this result.",
    );
    expect(feedback).toContain("3. `file.ts` (line 1)");
  });
  test("rejects malformed terminal quotes and preserves old drafts", () => {
    for (const patch of [
      { paneId: "" },
      { title: " " },
      { title: "x".repeat(501) },
      { anchor: "line" },
      { quote: " " },
      { quote: "x".repeat(MAX_QUOTE_LENGTH + 1) },
    ]) {
      expect(parseReviewAnnotation({ ...terminal, ...patch })).toBeNull();
    }
    expect(parseReviewAnnotation(diffAnnotation())).toEqual(diffAnnotation());
    expect(compileReviewFeedback([{ ...terminal, stale: true }])).toContain(
      "selected passage; anchor may be stale",
    );
  });
  test("successful pre-fill clears only unchanged nonblank delivered snapshots", () => {
    const blank = { ...terminal, id: "blank", comment: " " };
    const added = { ...terminal, id: "added" };
    const delivered = [diffAnnotation(), terminal, blank];
    const edited = { ...terminal, comment: "Keep my newer edit" };
    expect(
      removeDeliveredReviewAnnotations(
        [added, blank, edited, diffAnnotation()],
        delivered,
      ),
    ).toEqual([added, blank, edited]);
    expect(
      removeDeliveredReviewAnnotations([terminal, blank], delivered),
    ).toEqual([blank]);
    expect(
      removeDeliveredReviewAnnotations(
        [{ ...terminal, quote: "new quote" }],
        delivered,
      ),
    ).toHaveLength(1);
  });
});

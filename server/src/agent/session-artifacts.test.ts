import { expect, test } from "bun:test";
import { parseSessionArtifacts, publishedArtifact } from "./session-artifacts";

test("a new artifact is named after its title", () => {
  expect(
    publishedArtifact(
      { type_url: "https://claude.ai/artifact/T", title: "Power bills" },
      "Created a new Artifact at https://claude.ai/artifact/CYq8 (version 1-a) from the Artifact type https://claude.ai/artifact/T",
    ),
  ).toEqual({ url: "https://claude.ai/artifact/CYq8", title: "Power bills" });
});

test("an update carries its version, named after the file", () => {
  expect(
    publishedArtifact(
      { file_path: "/tmp/scratch/review-notes.html", url: "x" },
      "Published /tmp/scratch/review-notes.html at https://claude.ai/code/artifact/a-1 (Version 3, version id 17-50)",
    ),
  ).toEqual({
    url: "https://claude.ai/code/artifact/a-1",
    title: "review-notes",
    version: 3,
  });
});

test("an index page is named after its folder", () => {
  expect(
    publishedArtifact(
      { file_path: "/tmp/scratchpad/preview/index.html" },
      "Published /tmp/scratchpad/preview/index.html at https://claude.ai/artifact/P",
    )?.title,
  ).toBe("preview");
});

test("other actions, uploads and refusals publish nothing", () => {
  const url = "https://claude.ai/artifact/A";
  expect(
    publishedArtifact({ action: "read", url }, `Published x at ${url}`),
  ).toBeUndefined();
  expect(
    publishedArtifact({ asset: true, url }, `Published x at ${url}`),
  ).toBeUndefined();
  expect(
    publishedArtifact(
      { file_path: "/a.html" },
      "Publish refused: nothing was published",
    ),
  ).toBeUndefined();
});

test("a session lists each artifact once, at its latest publish", () => {
  const call = (id: string, input: Record<string, unknown>) => ({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name: "Artifact", input }] },
  });
  const result = (id: string, content: unknown, timestamp: string) => ({
    type: "user",
    timestamp,
    message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
  });
  const a = "https://claude.ai/artifact/A";
  const b = "https://claude.ai/artifact/B";
  expect(
    parseSessionArtifacts([
      call("1", { title: "Report" }),
      result("1", `Created a new Artifact at ${a} (version 1)`, "t1"),
      call("2", { file_path: "/s/notes.html" }),
      result(
        "2",
        [{ type: "text", text: `Published /s/notes.html at ${b}` }],
        "t2",
      ),
      call("3", { file_path: "/s/report.html", url: a }),
      result("3", `Published /s/report.html at ${a} (Version 2, id x)`, "t3"),
      call("4", { action: "read", url: b }),
      result("4", `Published x at ${b}`, "t4"),
    ]),
  ).toEqual([
    { url: a, title: "report", version: 2, published_at: "t3" },
    { url: b, title: "notes", published_at: "t2" },
  ]);
});

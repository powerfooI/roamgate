import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shQuote } from "../utils/process-utils";
import { searchWorkspaceFiles } from "./search";

test("searches unloaded checkout files and content while respecting ignores and binary files", async () => {
  const root = await mkdtemp(join(tmpdir(), "roamgate-search-"));
  try {
    const git = Bun.spawnSync(["git", "init", "-q", root]);
    expect(git.exitCode).toBe(0);
    await mkdir(join(root, "deep"));
    await mkdir(join(root, "ignored"));
    await writeFile(join(root, ".gitignore"), "ignored/\n");
    await writeFile(join(root, ".secret"), "needle hidden\n");
    await mkdir(join(root, ".private"));
    await writeFile(join(root, ".private", "target.txt"), "needle hidden\n");
    await writeFile(join(root, "deep", "target.txt"), "first\nneedle here\n");
    await writeFile(join(root, "ignored", "target.txt"), "needle hidden\n");
    await writeFile(
      join(root, "binary.dat"),
      Buffer.from([0, 110, 101, 101, 100, 108, 101]),
    );

    const files = await searchWorkspaceFiles({
      root,
      query: "target",
      mode: "files",
      showHidden: false,
      shQuote,
    });
    expect(files).toEqual({
      results: [{ path: "deep/target.txt" }],
      truncated: false,
    });

    const content = await searchWorkspaceFiles({
      root,
      query: "NEEDLE",
      mode: "content",
      showHidden: false,
      shQuote,
    });
    expect(content).toEqual({
      results: [{ path: "deep/target.txt", line: 2, snippet: "needle here" }],
      truncated: false,
    });

    const hidden = await searchWorkspaceFiles({
      root,
      query: "needle",
      mode: "content",
      showHidden: true,
      shQuote,
    });
    expect(hidden.results.map((result) => result.path)).toEqual([
      ".private/target.txt",
      ".secret",
      "deep/target.txt",
    ]);

    await writeFile(join(root, "tracked.log"), "needle tracked\n");
    expect(
      Bun.spawnSync(["git", "-C", root, "add", "tracked.log"]).exitCode,
    ).toBe(0);
    await writeFile(join(root, ".gitignore"), "ignored/\n*.log\n");
    const tracked = await searchWorkspaceFiles({
      root,
      query: "needle",
      mode: "content",
      showHidden: false,
      shQuote,
    });
    expect(tracked.results).toContainEqual({
      path: "tracked.log",
      line: 1,
      snippet: "needle tracked",
    });
    expect(
      tracked.results.filter((result) => result.path === "deep/target.txt"),
    ).toHaveLength(1);

    for (let index = 0; index < 101; index++) {
      await writeFile(join(root, `match-${index}.txt`), "needle\n");
    }
    const bounded = await searchWorkspaceFiles({
      root,
      query: "match-",
      mode: "files",
      showHidden: false,
      shQuote,
    });
    expect(bounded.results).toHaveLength(100);
    expect(bounded.truncated).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

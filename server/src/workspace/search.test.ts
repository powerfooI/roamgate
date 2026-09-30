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
      shQuote,
    });
    expect(content).toEqual({
      results: [{ path: "deep/target.txt", line: 2, snippet: "needle here" }],
      truncated: false,
    });

    for (let index = 0; index < 101; index++) {
      await writeFile(join(root, `match-${index}.txt`), "needle\n");
    }
    const bounded = await searchWorkspaceFiles({
      root,
      query: "match-",
      mode: "files",
      shQuote,
    });
    expect(bounded.results).toHaveLength(100);
    expect(bounded.truncated).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

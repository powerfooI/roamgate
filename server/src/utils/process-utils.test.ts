import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcessWithCodeTimeout } from "./process-utils";

test("native spawning preserves cwd, environment and literal arguments without a shell on PATH", async () => {
  const directory = await mkdtemp(join(tmpdir(), "roamgate process ' "));
  const literal = "space ' quote \" & $HOME; $(echo injected)";
  try {
    const result = await runProcessWithCodeTimeout(
      [
        process.execPath,
        "-e",
        "console.log(JSON.stringify({cwd:process.cwd(), value:process.env.ROAMGATE_TEST_VALUE, args:process.argv.slice(1)}))",
        literal,
      ],
      5000,
      {
        cwd: directory,
        env: { ...process.env, PATH: "", ROAMGATE_TEST_VALUE: literal },
      },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      cwd: await realpath(directory),
      value: literal,
      args: [literal],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

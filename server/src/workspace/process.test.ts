import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runProcessWithInputTimeout } from "./process";

// `git check-ignore --stdin` exits 128 immediately outside a repository and
// never reads stdin, so a payload larger than the pipe buffer cannot be
// flushed. Bun surfaces that as an asynchronous EPIPE on the stdin FileSink.
function unreadableStdinPayload() {
  const names = Array.from(
    { length: 40000 },
    (_, index) => `entry-${index}-${"padding".repeat(4)}`,
  );
  return `${names.join("\0")}\0`;
}

describe("runProcessWithInputTimeout", () => {
  test("does not leak EPIPE when the child exits before reading stdin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "roamgate-process-"));
    const escaped: unknown[] = [];
    const record = (error: unknown) => {
      escaped.push(error);
    };
    process.on("unhandledRejection", record);
    process.on("uncaughtException", record);
    try {
      const result = await runProcessWithInputTimeout(
        ["git", "-C", directory, "check-ignore", "-z", "--stdin"],
        unreadableStdinPayload(),
        5000,
      );
      // The caller sees an ordinary non-zero exit, which it already handles.
      expect(result.code).toBe(128);
      // The broken pipe must not escape as an unhandled rejection: nothing
      // holds that promise, so it would terminate the whole server process.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(escaped).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
      process.off("uncaughtException", record);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

import { describe, expect, test } from "bun:test";
import { shQuote } from "../utils/process-utils";
import { syncWorktreeBase } from "./create";

describe("worktree creation preparation", () => {
  test.each([undefined, "dev@example.test"])(
    "refreshes the remote default and returns the explicit Herdr base (host: %s)",
    async (host) => {
      const calls: string[][] = [];
      const results = [
        {
          code: 0,
          stdout: "ref: refs/heads/master\tHEAD\nabc123\tHEAD\n",
          stderr: "",
        },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "fetched\n" },
        { code: 0, stdout: "abc123\n", stderr: "" },
      ];
      const result = await syncWorktreeBase({
        workspaceId: "w1",
        resolveGitRoot: async () => ({ root: "/repo with spaces" }),
        host,
        shQuote,
        runProcessWithCodeTimeout: async (argv) => {
          calls.push(argv);
          const result = results.shift();
          if (!result) throw new Error("unexpected process call");
          return result;
        },
      });
      expect(calls).toHaveLength(4);
      expect(calls[0][0]).toBe(host ? "ssh" : "sh");
      if (host) expect(calls[0].slice(-3, -1)).toEqual(["--", host]);
      expect(calls.map((argv) => argv.at(-1))).toEqual([
        "GIT_TERMINAL_PROMPT=0 git -C '/repo with spaces' ls-remote --symref origin HEAD",
        "GIT_TERMINAL_PROMPT=0 git -C '/repo with spaces' check-ref-format 'refs/heads/master'",
        "GIT_TERMINAL_PROMPT=0 git -C '/repo with spaces' fetch --no-tags origin '+refs/heads/master:refs/remotes/origin/master'",
        "GIT_TERMINAL_PROMPT=0 git -C '/repo with spaces' rev-parse --verify 'refs/remotes/origin/master^{commit}'",
      ]);
      expect(result).toMatchObject({
        workspace_id: "w1",
        root: "/repo with spaces",
        base: "origin/master",
        commit: "abc123",
        command:
          "git fetch --no-tags origin '+refs/heads/master:refs/remotes/origin/master'",
        stderr: "fetched",
      });
    },
  );

  test.each([
    {
      name: "remote lookup fails",
      results: [{ code: 128, stdout: "", stderr: "origin is unavailable" }],
      error:
        "Unable to determine origin's default branch: origin is unavailable",
    },
    {
      name: "remote HEAD has no symbolic branch",
      results: [{ code: 0, stdout: "abc123\tHEAD\n", stderr: "" }],
      error: "origin HEAD does not identify a branch",
    },
    {
      name: "remote is empty",
      results: [{ code: 0, stdout: "", stderr: "" }],
      error: "origin HEAD does not identify a branch",
    },
    {
      name: "remote HEAD is invalid",
      results: [
        { code: 0, stdout: "ref: refs/heads/bad:name\tHEAD\n", stderr: "" },
        { code: 1, stdout: "", stderr: "" },
      ],
      error: "origin HEAD contains an invalid branch ref",
    },
    {
      name: "fetch fails",
      results: [
        { code: 0, stdout: "ref: refs/heads/master\tHEAD\n", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 128, stdout: "", stderr: "remote master is unavailable" },
      ],
      error: "Unable to update origin/master: remote master is unavailable",
    },
    {
      name: "fetched commit cannot be resolved",
      results: [
        { code: 0, stdout: "ref: refs/heads/master\tHEAD\n", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
        { code: 128, stdout: "", stderr: "missing commit" },
      ],
      error:
        "Unable to resolve origin/master after fetching it: missing commit",
    },
  ])(
    "does not fall back to another base when $name",
    async ({ results, error }) => {
      let calls = 0;
      await expect(
        syncWorktreeBase({
          workspaceId: "w1",
          resolveGitRoot: async () => ({ root: "/repo" }),
          shQuote,
          runProcessWithCodeTimeout: async () => {
            const result = results[calls++];
            if (!result) throw new Error("unexpected process call");
            return result;
          },
        }),
      ).rejects.toThrow(error);
      expect(calls).toBe(results.length);
    },
  );
});

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shQuote,
  type runProcessWithCodeTimeout,
} from "../utils/process-utils";
import {
  githubChecks,
  gitlabApprovals,
  parseReviewRemote,
  readPullRequestStatus,
} from "./pull-request";

const ok = (value: unknown) => ({
  code: 0,
  stdout: typeof value === "string" ? value : JSON.stringify(value),
  stderr: "",
});
const fail = {
  code: 1,
  stdout: "secret-token",
  stderr: "https://user:secret-token@example.com",
};
const ghPR = {
  number: 12,
  title: "Add card",
  user: { login: "alice" },
  head: {
    ref: "feature/card",
    label: "alice:feature/card",
    repo: { full_name: "alice/project" },
  },
  base: { label: "team:main" },
  state: "open",
  draft: true,
  html_url: "https://github.com/team/project/pull/12",
};
const glMR = {
  iid: 7,
  title: "Add card",
  author: { username: "bob" },
  source_branch: "feature/card",
  target_branch: "main",
  source_project_id: 1,
  target_project_id: 2,
  state: "opened",
  draft: true,
  web_url: "https://gitlab.com/team/project/-/merge_requests/7",
};

function fixture(
  provider: "github" | "gitlab",
  options: {
    host?: string;
    ssh?: boolean;
    remoteOutput?: string;
    override?: (command: string) => ReturnType<typeof ok> | undefined;
  } = {},
) {
  const host = options.host ?? `${provider}.com`;
  const commands: string[][] = [];
  const run: typeof runProcessWithCodeTimeout = async (
    argv,
    _timeout,
    launchOptions,
  ) => {
    commands.push(argv);
    if (options.ssh) {
      expect(launchOptions).toBeUndefined();
    } else {
      expect(launchOptions?.cwd).toBe("/repo with 'quote");
      expect(launchOptions?.env?.GH_PROMPT_DISABLED).toBe("1");
      expect(launchOptions?.env?.GIT_TERMINAL_PROMPT).toBe("0");
      expect(launchOptions?.env?.NO_COLOR).toBe("1");
    }
    const command = options.ssh ? argv.at(-1)! : argv.map(shQuote).join(" ");
    const overridden = options.override?.(command);
    if (overridden) return overridden;
    if (command.includes("'symbolic-ref'")) return ok("feature/card\n");
    if (command.includes("'--git-path'"))
      return ok(".git/rebase-merge/head-name\n.git/rebase-apply/head-name\n");
    if (command.includes("'cat' '--'")) return { ...fail, stdout: "" };
    if (command.includes("'for-each-ref'"))
      return ok("refs/heads/feature/card\0\0\n");
    if (command.includes("'git' 'remote'"))
      return ok(
        options.remoteOutput ??
          `origin\tgit@${host}:alice/project.git (fetch)\norigin\tgit@${host}:alice/project.git (push)\n`,
      );
    if (command.includes("'--version'")) return ok("CLI version");
    if (command.includes("'auth' 'status'")) {
      if (command.includes("'--json'"))
        return ok(provider === "github" ? `${host}\n` : "");
      if (command.includes("'--all'"))
        return ok(provider === "gitlab" ? `${host}\n  authenticated\n` : "");
      return ok("");
    }
    if (command.includes("'repos/alice/project'"))
      return ok({ fork: true, parent: { full_name: "team/project" } });
    if (command.includes("'repos/alice/project/pulls?")) return ok([]);
    if (command.includes("'repos/team/project/pulls?"))
      return ok([
        { ...ghPR, html_url: `https://${host}/team/project/pull/12` },
      ]);
    if (command.includes("'statusCheckRollup'"))
      return ok({
        statusCheckRollup: [
          {
            __typename: "CheckRun",
            status: "COMPLETED",
            conclusion: "FAILURE",
          },
        ],
      });
    if (command.includes("'reviewDecision'"))
      return ok({ reviewDecision: "CHANGES_REQUESTED" });
    if (command.includes("'projects/alice%2Fproject'"))
      return ok({ id: 1, forked_from_project: { id: 2 } });
    if (command.includes("'projects/1/merge_requests?")) return ok([]);
    if (command.includes("'projects/2/merge_requests?"))
      return ok([
        { ...glMR, web_url: `https://${host}/team/project/-/merge_requests/7` },
      ]);
    if (command.includes("'projects/2/merge_requests/7/approvals'"))
      return ok({
        approved: false,
        approved_by: [{ user: { username: "alice" } }],
      });
    if (command.includes("'projects/2/merge_requests/7'"))
      return ok({ head_pipeline: { status: "manual" } });
    throw new Error(`Unexpected command: ${command}`);
  };
  return {
    commands,
    read: (params: Record<string, unknown> = {}) =>
      readPullRequestStatus(
        {
          root: "/repo with 'quote",
          host: options.ssh ? "user@server" : undefined,
          shQuote,
          runProcessWithCodeTimeout: run,
        },
        params,
      ),
  };
}

describe("PR/MR status", () => {
  test("authentication checks the active GitHub account without passing GitHub-only flags to GitLab", async () => {
    for (const provider of ["github", "gitlab"] as const) {
      const result = await fixture(provider, {
        override: (command) => {
          if (!command.includes("'auth' 'status' '--hostname'")) return;
          // GitHub's inactive account is expired; glab rejects --active.
          return command.includes("'--active'") === (provider === "github")
            ? ok("")
            : fail;
        },
      }).read();
      expect(result.state).toBe("ready");
    }
  });

  test("parses network remotes without disclosing credentials or accepting local paths", () => {
    expect(
      parseReviewRemote(
        "origin",
        "https://user:secret@gitlab.example.com:8443/team/sub/repo.git",
      ),
    ).toEqual({
      name: "origin",
      host: "gitlab.example.com:8443",
      repository: "team/sub/repo",
    });
    expect(
      parseReviewRemote("origin", "ssh://git@github.com:2222/team/repo.git")
        ?.host,
    ).toBe("github.com");
    expect(parseReviewRemote("origin", "/tmp/repo")).toBeNull();
    expect(parseReviewRemote("origin", "file:///tmp/repo")).toBeNull();
    expect(
      parseReviewRemote("origin", "git@github.com:team/repo;touch secret"),
    ).toBeNull();
  });

  for (const provider of ["github", "gitlab"] as const) {
    test(`${provider} summarizes open, closed and merged requests without CI/review calls`, async () => {
      for (const state of ["open", "closed", "merged"]) {
        const f = fixture(provider, {
          override: (command) => {
            if (command.includes("'repos/team/project/pulls?"))
              return ok([
                {
                  ...ghPR,
                  state: state === "merged" ? "closed" : state,
                  merged_at: state === "merged" ? "2026-10-01T00:00:00Z" : null,
                },
              ]);
            if (command.includes("'projects/2/merge_requests?"))
              return ok([
                { ...glMR, state: state === "open" ? "opened" : state },
              ]);
          },
        });
        const result = await f.read({ summary: true });
        expect(result.state).toBe("ready");
        expect(result.request?.state).toBe(
          provider === "gitlab" && state === "open" ? "opened" : state,
        );
        expect(result.ci).toBeUndefined();
        expect(result.review).toBeUndefined();
        expect(
          f.commands
            .flat()
            .some((arg) => arg === "view" || arg.includes("/merge_requests/7")),
        ).toBe(false);
      }
    });
    test(`${provider} summaries reject branch changes and ambiguous merged matches`, async () => {
      let reads = 0;
      const changed = await fixture(provider, {
        override: (command) =>
          command.includes("'symbolic-ref'") && ++reads > 1
            ? ok("other")
            : undefined,
      }).read({ summary: true });
      expect(changed.state).toBe("error");
      expect(changed.request).toBeUndefined();
      const ambiguous = await fixture(provider, {
        override: (command) => {
          if (command.includes("'repos/team/project/pulls?"))
            return ok([
              ghPR,
              {
                ...ghPR,
                number: 13,
                state: "closed",
                merged_at: "2026-10-01T00:00:00Z",
              },
            ]);
          if (command.includes("'projects/2/merge_requests?"))
            return ok([glMR, { ...glMR, iid: 8, state: "merged" }]);
        },
      }).read({ summary: true });
      expect(ambiguous.state).toBe("select_match");
      expect(ambiguous.request).toBeUndefined();
    });
    test(`${provider} sidebar summaries choose the newest creation across repositories regardless of state or number`, async () => {
      for (const state of ["open", "closed", "merged"]) {
        const f = fixture(provider, {
          override: (command) => {
            if (command.includes("'repos/alice/project/pulls?"))
              return ok([
                {
                  ...ghPR,
                  number: 99,
                  created_at: "2026-10-02T00:00:00Z",
                  updated_at: "2026-10-20T00:00:00Z",
                },
                {
                  ...ghPR,
                  number: 2,
                  created_at: "2026-10-03T00:00:00Z",
                  state: state === "merged" ? "closed" : state,
                  merged_at: state === "merged" ? "2026-10-04T00:00:00Z" : null,
                  html_url: "https://github.com/alice/project/pull/2",
                },
              ]);
            if (command.includes("'repos/team/project/pulls?"))
              return ok([{ ...ghPR, created_at: "2026-10-01T00:00:00Z" }]);
            if (command.includes("'projects/1/merge_requests?"))
              return ok([
                {
                  ...glMR,
                  iid: 99,
                  target_project_id: 1,
                  created_at: "2026-10-02T00:00:00Z",
                  updated_at: "2026-10-20T00:00:00Z",
                },
                {
                  ...glMR,
                  iid: 2,
                  target_project_id: 1,
                  created_at: "2026-10-03T00:00:00Z",
                  state: state === "open" ? "opened" : state,
                  web_url:
                    "https://gitlab.com/alice/project/-/merge_requests/2",
                },
              ]);
            if (command.includes("'projects/2/merge_requests?"))
              return ok([{ ...glMR, created_at: "2026-10-01T00:00:00Z" }]);
          },
        });
        const result = await f.read({ summary: true, latest: true });
        expect(result.state).toBe("ready");
        expect(result.request).toMatchObject({
          id: provider === "github" ? "alice/project#2" : "1#2",
          number: 2,
          state: provider === "gitlab" && state === "open" ? "opened" : state,
          draft: true,
          url:
            provider === "github"
              ? "https://github.com/alice/project/pull/2"
              : "https://gitlab.com/alice/project/-/merge_requests/2",
        });
        expect(result.ci).toBeUndefined();
        expect(result.review).toBeUndefined();
        expect((await f.read({ summary: true })).state).toBe("select_match");
        expect((await f.read({ latest: true })).state).toBe("select_match");
      }
    });
    test(`${provider} sidebar summaries do not guess when creation times are missing or invalid`, async () => {
      for (const created_at of [undefined, "invalid"]) {
        const result = await fixture(provider, {
          override: (command) => {
            if (command.includes("'repos/team/project/pulls?"))
              return ok([
                { ...ghPR, created_at: "2026-10-01T00:00:00Z" },
                { ...ghPR, number: 13, created_at },
              ]);
            if (command.includes("'projects/2/merge_requests?"))
              return ok([
                { ...glMR, created_at: "2026-10-01T00:00:00Z" },
                { ...glMR, iid: 8, created_at },
              ]);
          },
        }).read({ summary: true, latest: true });
        expect(result.state).toBe("error");
        expect(result.request).toBeUndefined();
      }
    });
    test(`${provider} resolves a renamed local branch through its upstream over local and SSH`, async () => {
      for (const ssh of [false, true]) {
        const f = fixture(provider, {
          ssh,
          override: (command) => {
            if (command.includes("'symbolic-ref'")) return ok("pr-299\n");
            if (command.includes("'for-each-ref'"))
              return ok("refs/heads/pr-299\0origin\0refs/heads/feature/card\n");
          },
        });
        const result = await f.read({ branch: "pr-299" });
        expect(result.state).toBe("ready");
        expect(result.branch).toBe("pr-299");
        expect(result.request?.number).toBe(provider === "github" ? 12 : 7);
        const queries = f.commands
          .flat()
          .filter((arg) => arg.includes("per_page="));
        expect(queries.length).toBeGreaterThan(0);
        expect(queries.every((query) => query.includes("feature%2Fcard"))).toBe(
          true,
        );
      }
    });
    test(`${provider} keeps the rebased branch's request on a detached HEAD over local and SSH`, async () => {
      const gitDir = await mkdtemp(join(tmpdir(), "roamgate-rebase-"));
      try {
        await mkdir(join(gitDir, "rebase-merge"));
        const headName = join(gitDir, "rebase-merge", "head-name");
        // Local reads use headName on disk; SSH reads go through `cat`.
        const rebaseState = (
          ref: string,
          rebasing = () => true,
          // HEAD's reflog, newest first.
          reflog = "commit (amend): Amend\nrebase (edit): Add card\n",
        ) => {
          return (command: string) => {
            if (command.includes("'symbolic-ref'"))
              return rebasing() ? fail : ok("pr-299\n");
            if (command.includes("'--git-path'"))
              return ok(
                `${headName}\n${join(gitDir, "rebase-apply", "head-name")}\n`,
              );
            if (command.includes("'cat' '--'"))
              return command.includes("rebase-merge")
                ? ok(`${ref}\n`)
                : { ...fail, stdout: "" };
            if (command.includes("'--walk-reflogs'")) return ok(reflog);
            if (command.includes("'--verify'"))
              return command.includes("'refs/heads/pr-299'")
                ? ok("abc123\n")
                : fail;
            if (command.includes("'for-each-ref'"))
              return ok("refs/heads/pr-299\0origin\0refs/heads/feature/card\n");
          };
        };
        for (const ssh of [false, true]) {
          await writeFile(headName, "refs/heads/pr-299\n");
          // Workspace status reports the rebase as the "detached" sentinel;
          // the upstream alias still selects the provider-side branch.
          for (const branch of ["detached", "pr-299", undefined]) {
            const f = fixture(provider, {
              ssh,
              override: rebaseState("refs/heads/pr-299"),
            });
            const result = await f.read(branch ? { branch } : {});
            expect(result.state).toBe("ready");
            expect(result.branch).toBe("pr-299");
            expect(result.rebasing).toBe(true);
            expect(result.request?.number).toBe(provider === "github" ? 12 : 7);
            const queries = f.commands
              .flat()
              .filter((arg) => arg.includes("per_page="));
            expect(
              queries.every((query) => query.includes("feature%2Fcard")),
            ).toBe(true);
          }
          // Finishing the rebase mid-request keeps the same association.
          let reads = 0;
          const finished = await fixture(provider, {
            ssh,
            override: rebaseState("refs/heads/pr-299", () => ++reads < 2),
          }).read({ branch: "detached", summary: true });
          expect(finished.state).toBe("ready");
          expect(finished.request).toBeDefined();
          // Only an explicit detached sentinel or the same branch is accepted.
          const switched = await fixture(provider, {
            ssh,
            override: rebaseState("refs/heads/pr-299"),
          }).read({ branch: "other" });
          expect(switched.state).toBe("error");
          expect(switched.retryable).toBeUndefined();
          expect(switched.request).toBeUndefined();
          // HEAD belongs to the rebase only while a rebase step last moved
          // it; commits made at a stop keep it there. A manual checkout or
          // reset mid-rebase, even back to the rebase's base, does not.
          for (const [reflog, owned] of [
            ["rebase (start): checkout main\n", true],
            ["commit: Fix\ncommit (amend): Amend\nrebase (edit): Add\n", true],
            [
              "pull --rebase git@host:a/b.git main (start): checkout abc\n",
              true,
            ],
            ["checkout: moving from abc to def\nrebase (edit): Add\n", false],
            ["reset: moving to HEAD~\nrebase (edit): Add\n", false],
            ["pull: Fast-forward\n", false],
            ["commit: Only commits\n", false],
            ["", false],
          ] as const) {
            const result = await fixture(provider, {
              ssh,
              override: rebaseState("refs/heads/pr-299", () => true, reflog),
            }).read({ branch: "detached" });
            expect(result.state).toBe(owned ? "ready" : "detached");
            expect(result.request === undefined).toBe(!owned);
          }
          // A rebase of a detached HEAD or a deleted branch is not guessed.
          for (const ref of ["detached HEAD", "refs/heads/gone"]) {
            await writeFile(headName, `${ref}\n`);
            const detached = await fixture(provider, {
              ssh,
              override: rebaseState(ref),
            }).read({ branch: "detached" });
            expect(detached.state).toBe("detached");
            expect(detached.request).toBeUndefined();
          }
        }
        // Without rebase metadata a detached checkout stays unresolved.
        await rm(headName);
        for (const ssh of [false, true]) {
          const detached = await fixture(provider, {
            ssh,
            override: (command) => {
              if (command.includes("'symbolic-ref'")) return fail;
              if (command.includes("'--git-path'"))
                return ok(
                  `${headName}\n${join(gitDir, "rebase-apply", "head-name")}\n`,
                );
              if (command.includes("'cat' '--'"))
                return { ...fail, stdout: "" };
            },
          }).read({ branch: "detached" });
          expect(detached.state).toBe("detached");
        }
        // Aborting into a different branch mid-request invalidates the reply.
        await writeFile(headName, "refs/heads/pr-299\n");
        let reads = 0;
        const aborted = await fixture(provider, {
          override: (command) =>
            command.includes("'symbolic-ref'") && ++reads > 1
              ? ok("main\n")
              : rebaseState("refs/heads/pr-299")(command),
        }).read({ branch: "detached" });
        expect(aborted.state).toBe("error");
        expect(aborted.retryable).toBeUndefined();
        expect(aborted.request).toBeUndefined();
      } finally {
        await rm(gitDir, { recursive: true, force: true });
      }
    });
    test(`${provider} never uses a different remote or local upstream's branch`, async () => {
      for (const remote of ["other", "."]) {
        const result = await fixture(provider, {
          override: (command) =>
            command.includes("'for-each-ref'")
              ? ok(`refs/heads/feature/card\0${remote}\0refs/heads/main\n`)
              : undefined,
        }).read();
        expect(result.state).toBe("ready");
      }
    });
    test(`${provider} resolves a fork and preserves provider status over local and SSH`, async () => {
      for (const ssh of [false, true]) {
        const f = fixture(provider, { ssh });
        const result = await f.read();
        expect(result.state).toBe("ready");
        expect(result.provider).toBe(provider);
        expect(result.branch).toBe("feature/card");
        expect(result.request?.draft).toBe(true);
        expect(result.ci).toBe(provider === "github" ? "1 FAILURE" : "manual");
        expect(result.review).toBe(
          provider === "github"
            ? "CHANGES_REQUESTED"
            : "Not approved (provider-reported); 1 approver(s)",
        );
        expect(Number.isFinite(Date.parse(result.refreshedAt))).toBe(true);
        expect(
          f.commands.every((argv) =>
            ssh ? argv[0] === "ssh" : ["git", "gh", "glab"].includes(argv[0]),
          ),
        ).toBe(true);
        expect(
          f.commands
            .map((argv) => (ssh ? argv.at(-1)! : argv.map(shQuote).join(" ")))
            .filter((command) => command.includes("'api'"))
            .every((command) => command.includes("'--method' 'GET'")),
        ).toBe(true);
      }
    });
    test(`${provider} recognizes a configured self-hosted instance`, async () => {
      const result = await fixture(provider, {
        host: "code.example.com",
      }).read();
      expect(result.state).toBe("ready");
      expect(result.provider).toBe(provider);
    });
    test(`${provider} distinguishes missing CLI, auth failure, no match and failed requests`, async () => {
      const cases = [
        ["'--version'", { ...fail, code: 127 }, "missing_cli"],
        ["'auth' 'status' '--hostname'", fail, "unauthenticated"],
        [
          provider === "github"
            ? "'repos/team/project/pulls?"
            : "'projects/2/merge_requests?",
          ok([]),
          "no_match",
        ],
        ["'api'", fail, "error"],
      ] as const;
      for (const [pattern, value, state] of cases) {
        const result = await fixture(provider, {
          override: (command) =>
            command.includes(pattern) ? value : undefined,
        }).read();
        expect(result.state).toBe(state);
        expect(JSON.stringify(result)).not.toContain("secret-token");
        expect(result.request).toBeUndefined();
      }
    });
    test(`${provider} reports a missing native executable explicitly`, async () => {
      const result = await fixture(provider, {
        override: (command) => {
          if (command.includes("'--version'"))
            throw Object.assign(new Error("Executable missing"), {
              code: "ENOENT",
            });
        },
      }).read();
      expect(result.state).toBe("missing_cli");
    });
    test(`${provider} does not promote failed or missing CI/review to success`, async () => {
      const result = await fixture(provider, {
        override: (command) =>
          command.includes("'pr' 'view'") ||
          command.includes("'projects/2/merge_requests/7")
            ? fail
            : undefined,
      }).read();
      expect(result.state).toBe("ready");
      expect(result.ci).toContain("Unavailable");
      expect(result.review).toContain("Unavailable");
    });
    test(`${provider} isolates malformed CI and review responses from request metadata`, async () => {
      const result = await fixture(provider, {
        override: (command) =>
          command.includes("'pr' 'view'") ||
          command.includes("'projects/2/merge_requests/7")
            ? ok(null)
            : undefined,
      }).read();
      expect(result.state).toBe("ready");
      expect(result.request?.title).toBe("Add card");
      expect(result.ci).toContain("Unavailable");
      expect(result.review).toContain("Unavailable");
    });
    test(`${provider} host detection survives a timeout in the other CLI`, async () => {
      const result = await fixture(provider, {
        host: "code.example.com",
        override: (command) => {
          if (
            provider === "github"
              ? command.includes("'--all'")
              : command.includes("'.hosts | keys[]'")
          )
            throw new Error("timed out");
        },
      }).read();
      expect(result.state).toBe("ready");
      expect(result.provider).toBe(provider);
    });
    test(`${provider} preserves closed and merged states`, async () => {
      for (const state of ["closed", "merged"]) {
        const result = await fixture(provider, {
          override: (command) => {
            if (command.includes("'repos/team/project/pulls?"))
              return ok([
                {
                  ...ghPR,
                  state: "closed",
                  merged_at: state === "merged" ? "2026-09-29T00:00:00Z" : null,
                },
              ]);
            if (command.includes("'projects/2/merge_requests?"))
              return ok([{ ...glMR, state }]);
          },
        }).read();
        expect(result.state).toBe("ready");
        expect(result.request?.state).toBe(state);
      }
    });
    test(`${provider} requires explicit selection for multiple matches`, async () => {
      const f = fixture(provider, {
        override: (command) => {
          if (command.includes("'repos/team/project/pulls?"))
            return ok([ghPR, { ...ghPR, number: 13 }]);
          if (command.includes("'projects/2/merge_requests?"))
            return ok([glMR, { ...glMR, iid: 8 }]);
        },
      });
      const ambiguous = await f.read();
      expect(ambiguous.state).toBe("select_match");
      expect(ambiguous.request).toBeUndefined();
      expect((await f.read({ match: ambiguous.matches![0].id })).state).toBe(
        "ready",
      );
      expect((await f.read({ match: "untrusted#123" })).state).toBe(
        "select_match",
      );
    });
    test(`${provider} rejects same-name branches belonging to another source repository`, async () => {
      const result = await fixture(provider, {
        override: (command) => {
          if (command.includes("'repos/team/project/pulls?"))
            return ok([
              {
                ...ghPR,
                head: { ...ghPR.head, repo: { full_name: "other/project" } },
              },
            ]);
          if (command.includes("'projects/2/merge_requests?"))
            return ok([{ ...glMR, source_project_id: 999 }]);
        },
      }).read();
      expect(result.state).toBe("no_match");
    });
  }

  test("origin is the default among multiple remotes; explicit and unknown choices stay distinct", async () => {
    const f = fixture("github", {
      remoteOutput:
        "origin\tgit@github.com:alice/project.git (fetch)\nbackup\thttps://github.com/alice/project.git (fetch)\n",
    });
    const automatic = await f.read();
    expect(automatic.state).toBe("ready");
    expect(automatic.remote).toBe("origin");
    expect(automatic.remotes).toHaveLength(2);
    expect((await f.read({ remote: "backup" })).remote).toBe("backup");
    const beforeInvalid = f.commands.length;
    expect((await f.read({ remote: "'; bad" })).state).toBe("select_remote");
    expect(
      f.commands.slice(beforeInvalid).every((argv) => argv[0] === "git"),
    ).toBe(true);
    expect(
      (
        await fixture("github", {
          remoteOutput:
            "backup\tgit@github.com:alice/project.git (fetch)\nupstream\tgit@github.com:alice/project.git (fetch)\n",
        }).read()
      ).state,
    ).toBe("select_remote");
  });
  test("unsupported hosts and detached HEAD have explicit states", async () => {
    const undiscovered = await fixture("gitlab", {
      host: "git.example.com",
      override: (command) => (command.includes("'auth'") ? ok("") : undefined),
    }).read();
    expect(undiscovered).toMatchObject({
      state: "unsupported",
      retryable: true,
    });
    expect(
      (
        await fixture("github", {
          host: "example.com",
          override: (command) =>
            command.includes("'auth'") ? ok("") : undefined,
        }).read()
      ).state,
    ).toBe("unsupported");
    expect(
      (
        await fixture("github", {
          override: (command) =>
            command.includes("'symbolic-ref'") ? fail : undefined,
        }).read()
      ).state,
    ).toBe("detached");
  });
  test("branch switches before or during a request never return a card", async () => {
    expect(
      (await fixture("github").read({ branch: "other" })).request,
    ).toBeUndefined();
    let reads = 0;
    const result = await fixture("github", {
      override: (command) =>
        command.includes("'symbolic-ref'") && ++reads > 1
          ? ok("other")
          : undefined,
    }).read();
    expect(result.state).toBe("error");
    expect(result.request).toBeUndefined();
  });
  test("GitHub follows canonical identity after repository renames", async () => {
    const result = await fixture("github", {
      remoteOutput: "origin\tgit@github.com:old/project.git (fetch)\n",
      override: (command) =>
        command.includes("'repos/old/project'")
          ? ok({
              full_name: "alice/project",
              fork: true,
              parent: { full_name: "team/project" },
            })
          : undefined,
    }).read();
    expect(result.state).toBe("ready");
    expect(result.request?.number).toBe(12);
  });
  test("GitLab deduplicates outgoing fork requests listed by both projects", async () => {
    const result = await fixture("gitlab", {
      override: (command) =>
        command.includes("'projects/1/merge_requests?")
          ? ok([glMR])
          : undefined,
    }).read();
    expect(result.state).toBe("ready");
    expect(result.matches).toHaveLength(1);
    expect(gitlabApprovals({ approvals_left: 0 })).toBe(
      "0 approvals remaining (provider-reported)",
    );
  });
  test("invalid payloads and unsafe provider URLs fail closed", async () => {
    for (const value of [
      "invalid json",
      {},
      Array(100).fill(ghPR),
      [{ ...ghPR, html_url: "javascript:alert(1)" }],
      [
        {
          ...ghPR,
          html_url: "https://user:secret@github.com/team/project/pull/12",
        },
      ],
    ]) {
      expect(
        (
          await fixture("github", {
            override: (command) =>
              command.includes("'repos/team/project/pulls?")
                ? ok(value)
                : undefined,
          }).read()
        ).state,
      ).toBe("error");
    }
    const failed = await fixture("github", {
      override: (command) =>
        command.includes("'repos/team/project/pulls?") ? fail : undefined,
    }).read();
    expect(failed.state).toBe("error");
    expect(failed.retryable).toBe(true);
  });
  test("missing, skipped and pending checks retain their meaning", () => {
    expect(githubChecks(null)).toBe("Unavailable");
    expect(githubChecks([])).toBe("No checks reported");
    expect(
      githubChecks([
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" },
        { __typename: "StatusContext", state: "PENDING" },
        {},
      ]),
    ).toBe("1 SKIPPED, 1 PENDING, 1 Unknown");
    expect(gitlabApprovals({ approved_by: [{}] })).toBe("Unavailable");
    expect(gitlabApprovals({ approved: true, approved_by: [] })).toBe(
      "Approved (provider-reported); 0 approver(s)",
    );
  });
});

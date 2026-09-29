import { describe, expect, test } from "bun:test";
import { shQuote } from "../utils/process-utils";
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
  const run = async (argv: string[]) => {
    commands.push(argv);
    const command = argv.at(-1)!;
    const overridden = options.override?.(command);
    if (overridden) return overridden;
    if (command.includes("'symbolic-ref'")) return ok("feature/card\n");
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
          f.commands.every((argv) => argv[0] === (ssh ? "ssh" : "sh")),
        ).toBe(true);
        expect(
          f.commands
            .filter((argv) => argv.at(-1)?.includes("'api'"))
            .every((argv) => argv.at(-1)?.includes("'--method' 'GET'")),
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

  test("multiple remotes require a source selection; unknown remotes are never executed", async () => {
    const f = fixture("github", {
      remoteOutput:
        "origin\tgit@github.com:alice/project.git (fetch)\nupstream\thttps://github.com/team/project.git (fetch)\n",
    });
    expect((await f.read()).state).toBe("select_remote");
    expect((await f.read({ remote: "'; bad" })).state).toBe("select_remote");
    expect(f.commands.every((argv) => argv.at(-1)?.includes("'git'"))).toBe(
      true,
    );
    expect((await f.read({ remote: "origin" })).state).toBe("ready");
  });
  test("unsupported hosts and detached HEAD have explicit states", async () => {
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

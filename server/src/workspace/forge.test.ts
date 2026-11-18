import { describe, expect, test } from "bun:test";
import type { ForgeRef } from "../../../shared/forge";
import { createdRequestField, createsRequest } from "../agent/session-history";
import {
  createForgeCache,
  type ForgeContext,
  parseForgeRefParam,
  pickDefaultRemote,
  readGithubStatus,
  readGitlabStatus,
} from "./forge";

const gitlabRef: ForgeRef = {
  provider: "gitlab",
  host: "gitlab.example",
  project: "gst/gstreamer",
  number: 42,
};

const mrJson = {
  iid: 42,
  title: "appsink: keep sticky events",
  state: "opened",
  draft: false,
  author: { username: "me" },
  source_branch: "appsink",
  target_branch: "main",
  updated_at: "2026-11-02T10:00:00Z",
  web_url: "https://gitlab.example/gst/gstreamer/-/merge_requests/42",
  references: { full: "gst/gstreamer!42" },
  head_pipeline: { id: 7, project_id: 3, status: "failed" },
};

/**
 * glab on a fake host: glab's default host is gitlab.example, and it has a
 * login of its own for `logins`. Every other command is an API call.
 */
function fakeGlab(
  answers: Record<string, unknown>,
  logins: string[] = [],
  options: { host?: string } = {},
) {
  const calls: { argv: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const context: ForgeContext = {
    root: "/repo",
    ...(options.host ? { host: options.host } : {}),
    shQuote: (value) => `'${value}'`,
    runProcessWithCodeTimeout: async (argv, _timeout, runOptions) => {
      if (argv.some((arg) => arg.includes("glab config get host"))) {
        const login = logins.some((host) =>
          argv.some((arg) => arg.includes(`token '${host}'`)),
        );
        return {
          code: 0,
          stdout: `glab https://gitlab.example\n${login ? "login\n" : ""}`,
          stderr: "",
        };
      }
      calls.push({ argv, env: runOptions?.env });
      const command = argv.join(" ");
      const key = Object.keys(answers)
        .sort((a, b) => b.length - a.length)
        .find((pattern) => command.includes(pattern));
      if (!key) return { code: 1, stdout: "", stderr: "404 Not Found" };
      return { code: 0, stdout: JSON.stringify(answers[key]), stderr: "" };
    },
  };
  return { context, calls };
}

const fullAnswers = {
  "merge_requests/42": mrJson,
  "merge_requests/42/approvals": {
    approved: false,
    approved_by: [{ user: { username: "a" } }],
  },
  graphql: {
    data: {
      project: {
        mergeRequest: {
          resolvableDiscussionsCount: 5,
          resolvedDiscussionsCount: 2,
        },
      },
    },
  },
  "pipelines/7/jobs": [
    { name: "build fedora", stage: "build", allow_failure: false },
    { name: "lint", stage: "check", allow_failure: true },
  ],
};

describe("GitLab merge request status", () => {
  test("reads state, pipeline, failed jobs, approvals and open threads", async () => {
    const { context, calls } = fakeGlab(fullAnswers);
    const status = await readGitlabStatus(context, gitlabRef);
    expect(status.state).toBe("ready");
    expect(status.request).toEqual({
      url: "https://gitlab.example/gst/gstreamer/-/merge_requests/42",
      project: "gst/gstreamer",
      title: "appsink: keep sticky events",
      state: "open",
      draft: false,
      author: "me",
      sourceBranch: "appsink",
      targetBranch: "main",
      updatedAt: "2026-11-02T10:00:00Z",
      pipeline: {
        status: "failed",
        failed: [
          { name: "build fedora", stage: "build", allowFailure: false },
          { name: "lint", stage: "check", allowFailure: true },
        ],
      },
      approvals: { approved: false, count: 1 },
      unresolved: 3,
    });
    // Only reads: GETs, and a GraphQL query.
    for (const { argv } of calls) {
      expect(argv.slice(0, 4)).toEqual([
        "glab",
        "api",
        "--hostname",
        "gitlab.example",
      ]);
      const method = argv[argv.indexOf("--method") + 1];
      if (method !== "GET") expect(argv).toContain("graphql");
    }
  });

  test("a host glab has no login for is never asked, and gets no token", async () => {
    const { context, calls } = fakeGlab(fullAnswers);
    const status = await readGitlabStatus(context, {
      ...gitlabRef,
      host: "evil.example",
    });
    expect(status.state).toBe("not_signed_in");
    expect(status.message).toContain("evil.example");
    expect(status.request).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("another host glab is logged in to is asked without the environment's tokens", async () => {
    const answers = {
      ...fullAnswers,
      "merge_requests/42": {
        ...mrJson,
        web_url: "https://gitlab.other/gst/gstreamer/-/merge_requests/42",
      },
    };
    const saved = process.env.GITLAB_TOKEN;
    process.env.GITLAB_TOKEN = "for-the-default-host";
    try {
      const { context, calls } = fakeGlab(answers, ["gitlab.other"]);
      const status = await readGitlabStatus(context, {
        ...gitlabRef,
        host: "gitlab.other",
      });
      expect(status.state).toBe("ready");
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(call.env?.GITLAB_TOKEN).toBeUndefined();
      // Over SSH, removed from the remote environment.
      const remote = fakeGlab(answers, ["gitlab.other"], { host: "builder" });
      await readGitlabStatus(remote.context, {
        ...gitlabRef,
        host: "gitlab.other",
      });
      for (const call of remote.calls)
        expect(call.argv.join(" ")).toContain("env -u GITLAB_TOKEN");
    } finally {
      if (saved === undefined) delete process.env.GITLAB_TOKEN;
      else process.env.GITLAB_TOKEN = saved;
    }
  });

  test("only a request's own page is linked, or nothing is shown", async () => {
    // A web URL on another host (or none): no link, nothing shown.
    for (const web_url of [
      "https://evil.example/gst/gstreamer/-/merge_requests/42",
      "http://gitlab.example/gst/gstreamer/-/merge_requests/42",
      "https://user:pw@gitlab.example/gst/gstreamer/-/merge_requests/42",
      "https://gitlab.example/gst/gstreamer/-/merge_requests/43",
      undefined,
    ]) {
      const odd = fakeGlab({
        ...fullAnswers,
        "merge_requests/42": { ...mrJson, web_url },
      });
      const status = await readGitlabStatus(odd.context, gitlabRef);
      expect({ web_url, state: status.state }).toEqual({
        web_url,
        state: "error",
      });
      expect(status.request).toBeUndefined();
    }
  });

  test("a merge request GitLab does not know is not found", async () => {
    const { context } = fakeGlab({});
    expect(await readGitlabStatus(context, gitlabRef)).toMatchObject({
      state: "not_found",
    });
  });
});

describe("GitHub pull request status", () => {
  const ghRef: ForgeRef = {
    provider: "github",
    host: "github.com",
    project: "cli/cli",
    number: 7,
  };
  function fakeGh(loggedIn: boolean) {
    const calls: string[][] = [];
    const context: ForgeContext = {
      root: "/repo",
      shQuote: (value) => `'${value}'`,
      runProcessWithCodeTimeout: async (argv) => {
        calls.push(argv);
        if (argv[1] === "auth")
          return { code: loggedIn ? 0 : 1, stdout: "", stderr: "" };
        return {
          code: 0,
          stdout: JSON.stringify({
            data: {
              repository: {
                nameWithOwner: "cli/cli",
                pullRequest: {
                  number: 7,
                  title: "Fix",
                  url: "https://github.com/cli/cli/pull/7",
                  state: "OPEN",
                  isDraft: false,
                  updatedAt: "2026-11-01T00:00:00Z",
                  baseRefName: "trunk",
                  headRefName: "fix",
                  author: { login: "me" },
                  reviewDecision: "APPROVED",
                  reviews: { totalCount: 2 },
                  reviewThreads: {
                    nodes: [{ isResolved: false }, { isResolved: true }],
                  },
                  commits: {
                    nodes: [
                      {
                        commit: {
                          statusCheckRollup: {
                            state: "FAILURE",
                            contexts: {
                              nodes: [
                                {
                                  __typename: "CheckRun",
                                  name: "test (ubuntu)",
                                  status: "COMPLETED",
                                  conclusion: "FAILURE",
                                },
                                {
                                  __typename: "CheckRun",
                                  name: "lint",
                                  status: "COMPLETED",
                                  conclusion: "SUCCESS",
                                },
                              ],
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              },
            },
          }),
          stderr: "",
        };
      },
    };
    return { context, calls };
  }

  test("reads state, checks, approvals and open threads through gh", async () => {
    const { context, calls } = fakeGh(true);
    const status = await readGithubStatus(context, ghRef);
    expect(status.request).toMatchObject({
      url: "https://github.com/cli/cli/pull/7",
      state: "open",
      pipeline: { status: "failed", failed: [{ name: "test (ubuntu)" }] },
      approvals: { approved: true, count: 2 },
      unresolved: 1,
    });
    expect(calls.at(-1)!.slice(0, 5)).toEqual([
      "gh",
      "api",
      "--hostname",
      "github.com",
      "graphql",
    ]);
  });

  test("a host gh is not logged in to is never asked", async () => {
    const { context, calls } = fakeGh(false);
    const status = await readGithubStatus(context, {
      ...ghRef,
      host: "ghe.example",
    });
    expect(status.state).toBe("not_signed_in");
    expect(calls.map((argv) => argv[1])).toEqual(["auth"]);
  });
});

describe("the shared cache", () => {
  test("coalesces identical requests and keeps an answer a few seconds", async () => {
    let now = 0;
    const cache = createForgeCache(() => now);
    const { context, calls } = fakeGlab(fullAnswers);
    const count = () =>
      calls.filter((call) =>
        call.argv.some((arg) => arg.endsWith("merge_requests/42")),
      ).length;
    await Promise.all([
      cache.status(context, gitlabRef),
      cache.status(context, { ...gitlabRef, project: "GST/gstreamer" }),
    ]);
    expect(count()).toBe(1);
    now += 10_000;
    await cache.status(context, gitlabRef);
    expect(count()).toBe(1);
    now += 10_000;
    await cache.status(context, gitlabRef);
    expect(count()).toBe(2);
  });
});

describe("chips asked together", () => {
  const node = (iid: number, extra: Record<string, unknown> = {}) => ({
    iid: String(iid),
    webUrl: `https://gitlab.example/gst/gstreamer/-/merge_requests/${iid}`,
    reference: `gst/gstreamer!${iid}`,
    title: `MR ${iid}`,
    state: "opened",
    draft: false,
    updatedAt: "2026-11-02T10:00:00Z",
    sourceBranch: "b",
    targetBranch: "main",
    author: { username: "me" },
    approved: true,
    approvedBy: { nodes: [{ username: "a" }] },
    resolvableDiscussionsCount: 4,
    resolvedDiscussionsCount: 1,
    headPipeline: {
      status: "FAILED",
      jobs: {
        nodes: [{ name: "build", allowFailure: false, stage: { name: "b" } }],
      },
    },
    ...extra,
  });
  /** glab whose GraphQL answers each project alias with these nodes. */
  function batchGlab(nodes: Record<string, unknown[]>) {
    const queries: string[] = [];
    const { context, calls } = fakeGlab({});
    const run = context.runProcessWithCodeTimeout;
    context.runProcessWithCodeTimeout = async (argv, timeout, options) => {
      const query = argv.find((arg) => arg.startsWith("query="));
      if (!query) return run(argv, timeout, options);
      queries.push(query);
      const data: Record<string, unknown> = {};
      for (const [, alias, path] of query.matchAll(
        /(p\d+): project\(fullPath: "([^"]+)"\)/g,
      ))
        data[alias!] = { mergeRequests: { nodes: nodes[path!] ?? [] } };
      return { code: 0, stdout: JSON.stringify({ data }), stderr: "" };
    };
    return { context, calls, queries };
  }

  test("one GraphQL query reads every request of a host on screen", async () => {
    const cache = createForgeCache();
    const { context, queries, calls } = batchGlab({
      "gst/gstreamer": [
        node(42),
        node(43, { state: "merged", headPipeline: null }),
      ],
      "gst/gst-plugins-rs": [],
    });
    const [a, b, c] = await Promise.all([
      cache.status(context, gitlabRef),
      cache.status(context, { ...gitlabRef, number: 43 }),
      cache.status(context, {
        ...gitlabRef,
        project: "gst/gst-plugins-rs",
        number: 7,
      }),
    ]);
    expect(queries).toHaveLength(1);
    // Nothing else: no REST reads.
    expect(calls).toHaveLength(0);
    expect(a.request).toMatchObject({
      state: "open",
      pipeline: {
        status: "failed",
        failed: [{ name: "build", stage: "b", allowFailure: false }],
      },
      approvals: { approved: true, count: 1 },
      unresolved: 3,
    });
    expect(b.request?.state).toBe("merged");
    expect(b.request?.pipeline).toBeNull();
    expect(c.state).toBe("not_found");
  });

  test("a chip asked later brings the others along, and answers stand", async () => {
    let now = 0;
    const cache = createForgeCache(() => now);
    const { context, queries } = batchGlab({
      "gst/gstreamer": [node(42), node(44)],
    });
    await cache.status(context, gitlabRef);
    now += 20_000;
    await cache.status(context, { ...gitlabRef, number: 44 });
    expect(queries).toHaveLength(2);
    expect(queries[1]).toContain('["44","42"]');
    // 42 was read with 44: asked again past the shared 15 s, no call.
    now += 20_000;
    await cache.status(context, gitlabRef);
    expect(queries).toHaveLength(2);
    // A click on refresh asks anyway.
    await cache.status(context, gitlabRef, { fresh: true });
    expect(queries).toHaveLength(3);
  });

  test("GitHub pull requests of a repository share one query", async () => {
    const cache = createForgeCache();
    const calls: string[][] = [];
    const pr = (number: number) => ({
      number,
      title: `PR ${number}`,
      url: `https://github.com/cli/cli/pull/${number}`,
      state: "OPEN",
      isDraft: false,
      reviewThreads: { nodes: [] },
    });
    const context: ForgeContext = {
      root: "/repo",
      shQuote: (value) => `'${value}'`,
      runProcessWithCodeTimeout: async (argv) => {
        calls.push(argv);
        if (argv[1] === "auth") return { code: 0, stdout: "", stderr: "" };
        // A missing one is an error beside the others' data.
        return {
          code: 1,
          stdout: JSON.stringify({
            data: { r0: { nameWithOwner: "cli/cli", n7: pr(7), n9: null } },
            errors: [{ type: "NOT_FOUND" }],
          }),
          stderr: "gh: Could not resolve to a PullRequest",
        };
      },
    };
    const ref: ForgeRef = {
      provider: "github",
      host: "github.com",
      project: "cli/cli",
      number: 7,
    };
    const [seven, nine] = await Promise.all([
      cache.status(context, ref),
      cache.status(context, { ...ref, number: 9 }),
    ]);
    expect(calls.filter((argv) => argv[1] === "api")).toHaveLength(1);
    expect(calls.find((argv) => argv[1] === "api")!.at(-1)).toContain(
      "n7: pullRequest(number: 7)",
    );
    expect(seven.request?.url).toBe("https://github.com/cli/cli/pull/7");
    expect(nine.state).toBe("not_found");
  });
});

test("references from the browser are checked before anything runs", () => {
  expect(parseForgeRefParam(gitlabRef)).toEqual(gitlabRef);
  for (const bad of [
    null,
    { ...gitlabRef, provider: "bitbucket" },
    { ...gitlabRef, host: "a b" },
    { ...gitlabRef, host: "-x" },
    { ...gitlabRef, project: "../etc" },
    { ...gitlabRef, project: "one" },
    { ...gitlabRef, project: "a/b;rm -rf" },
    { ...gitlabRef, number: 0 },
    { ...gitlabRef, number: 1.5 },
    { ...gitlabRef, number: "42" },
  ])
    expect(parseForgeRefParam(bad)).toBeNull();
});

test("`!N` means the upstream remote's project, else origin's", () => {
  expect(pickDefaultRemote({ origin: "o", upstream: "u" })).toBe("upstream");
  expect(pickDefaultRemote({ origin: "o", fork: "f" })).toBe("origin");
  expect(pickDefaultRemote({ fork: "f" })).toBe("fork");
  expect(pickDefaultRemote({ a: "a", b: "b" })).toBeNull();
});

test("a request a command opened is found in its output", () => {
  expect(createsRequest("glab mr create --fill --yes")).toBe(true);
  expect(createsRequest("cd x && gh pr create -t T -b B")).toBe(true);
  expect(createsRequest("glab mr list")).toBe(false);
  expect(createsRequest(undefined)).toBe(false);
  expect(
    createdRequestField(
      "Creating merge request for appsink into main in gst/gstreamer\n\n!42 appsink (appsink)\n https://gitlab.example/gst/gstreamer/-/merge_requests/42\n",
    ),
  ).toEqual({
    created_request: "https://gitlab.example/gst/gstreamer/-/merge_requests/42",
  });
  expect(createdRequestField("https://github.com/cli/cli/pull/7\n")).toEqual({
    created_request: "https://github.com/cli/cli/pull/7",
  });
  expect(createdRequestField("error: no commits")).toEqual({});
});

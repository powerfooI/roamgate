import { describe, expect, test } from "bun:test";
import type { ForgeProject, ForgeSession } from "../../shared/forge";
import {
  branchRequests,
  conversationRequests,
  findForgeMentions,
  resolveForgeMention,
  stripMarkdownCode,
} from "./forgeRefs";

const gst: ForgeProject = {
  provider: "gitlab",
  host: "gitlab.freedesktop.org",
  project: "gstreamer/gstreamer",
};
const gh: ForgeProject = {
  provider: "github",
  host: "github.com",
  project: "cli/cli",
};

function refs(text: string, project: ForgeProject | null = gst) {
  return findForgeMentions(text).map((match) => ({
    text: match.text,
    ref: resolveForgeMention(match.mention, project),
  }));
}

describe("merge and pull request references", () => {
  test("finds `!N`, `group/project!N` and MR URLs", () => {
    expect(
      refs(
        "See !12909, gstreamer/gstreamer-rs!2096 and https://gitlab.freedesktop.org/gstreamer/cerbero/-/merge_requests/1804/diffs#note_1.",
      ),
    ).toEqual([
      {
        text: "!12909",
        ref: { ...gst, number: 12909 },
      },
      {
        text: "gstreamer/gstreamer-rs!2096",
        ref: { ...gst, project: "gstreamer/gstreamer-rs", number: 2096 },
      },
      {
        text: "https://gitlab.freedesktop.org/gstreamer/cerbero/-/merge_requests/1804/diffs#note_1",
        ref: { ...gst, project: "gstreamer/cerbero", number: 1804 },
      },
    ]);
  });

  test("finds GitHub `#N`, `owner/repo#N` and PR URLs against a GitHub repository", () => {
    expect(
      refs(
        "Fixed in #42 (cli/go-gh#7), see https://github.com/cli/cli/pull/11000",
        gh,
      ).map(({ ref }) => ref),
    ).toEqual([
      { ...gh, number: 42 },
      { ...gh, project: "cli/go-gh", number: 7 },
      { ...gh, number: 11000 },
    ]);
  });

  test("`!N` means nothing in a GitHub chat, nor `#N` in a GitLab one", () => {
    expect(refs("!12 and #13", gh).map(({ ref }) => ref)).toEqual([
      null,
      { ...gh, number: 13 },
    ]);
    expect(refs("!12 and #13", gst).map(({ ref }) => ref)).toEqual([
      { ...gst, number: 12 },
      null,
    ]);
    // Without a repository, only references that name theirs.
    expect(
      refs("!12 gstreamer/gstreamer!3 https://github.com/a/b/pull/4", null).map(
        ({ ref }) => ref?.number ?? null,
      ),
    ).toEqual([null, null, 4]);
  });

  test("ignores what only looks like one", () => {
    const none = [
      "a { color: red !important; }",
      "if (a != b) return !!x;",
      "! git log -1",
      "!ls -la",
      "foo!12 bar",
      "a.b!12",
      "&#12; is an entity",
      "## 12 headings",
      "path/to/file#L12 is a line, x#1",
      "version 1.2!3",
      "!12abc",
      "ratio !1.5",
      "mail me at me@host.org!1",
    ];
    for (const text of none)
      expect({ text, found: refs(text).filter(({ ref }) => ref) }).toEqual({
        text,
        found: [],
      });
  });

  test("a URL is one reference, not a path with a number in it", () => {
    expect(
      refs(
        "https://gitlab.freedesktop.org/gstreamer/gstreamer/-/merge_requests/1",
      ).map(({ text }) => text),
    ).toEqual([
      "https://gitlab.freedesktop.org/gstreamer/gstreamer/-/merge_requests/1",
    ]);
    // Other URLs name no request, and their paths none either.
    expect(
      refs("https://example.com/a/b!12 http://x/-/merge_requests/3"),
    ).toEqual([]);
  });

  test("Markdown code is not scanned", () => {
    const text = [
      "Merged !1 at last.",
      "```sh",
      "echo !2 # history expansion",
      "```",
      "Run `git log !3` and ~~~",
      "~~~",
      "!4 inside a tilde fence",
      "~~~",
      "then !5.",
    ].join("\n");
    expect(
      findForgeMentions(stripMarkdownCode(text)).map((match) => match.text),
    ).toEqual(["!1", "!5"]);
  });
});

const session = (repos: ForgeSession["repos"]): ForgeSession => ({
  defaultProject: gst,
  repos,
  refreshedAt: "2026-11-02T00:00:00Z",
});

describe("a conversation's requests", () => {
  const multi = session([
    {
      root: "/src/gstreamer",
      branch: "appsink-flush",
      project: { ...gst, project: "me/gstreamer" },
      request: {
        url: "https://gitlab.freedesktop.org/gstreamer/gstreamer/-/merge_requests/12855",
        number: 12855,
        title: "appsink",
      },
    },
    {
      root: "/src/gstreamer/subprojects/gst-plugins-rs",
      branch: "ocio",
      project: { ...gst, project: "me/gst-plugins-rs" },
      request: {
        url: "https://gitlab.freedesktop.org/gstreamer/gst-plugins-rs/-/merge_requests/2001",
        number: 2001,
        title: "ocio",
      },
    },
    {
      root: "/src/ocio-rs",
      branch: "bindings",
      project: {
        provider: "github",
        host: "github.com",
        project: "me/ocio-rs",
      },
      request: {
        url: "https://github.com/AcademySoftwareFoundation/ocio-rs/pull/5",
        number: 5,
        title: "bindings",
      },
    },
    // A repository without a request (or on a forge nobody answers).
    { root: "/src/other", branch: "x", project: null, request: null },
  ]);

  test("the header has one request per repository whose branch has one", () => {
    expect(
      branchRequests(multi).map(({ ref, root }) => [ref.project, root]),
    ).toEqual([
      ["gstreamer/gstreamer", "/src/gstreamer"],
      ["gstreamer/gst-plugins-rs", "/src/gstreamer/subprojects/gst-plugins-rs"],
      ["AcademySoftwareFoundation/ocio-rs", "/src/ocio-rs"],
    ]);
    expect(branchRequests(null)).toEqual([]);
  });

  test("lists branches', created and mentioned requests, by repository", () => {
    const groups = conversationRequests(
      [
        { role: "user", kind: "message", text: "Look at !12855 and !100" },
        {
          role: "assistant",
          kind: "message",
          text: "Done: gstreamer/gst-plugins-rs!2001 passes. `!999` is code.",
          sent_at: "2026-11-02T10:00:00Z",
        },
        // A tool payload (redacted) only counts by what it created.
        {
          role: "tool",
          kind: "tool_result",
          text: "",
          created_request:
            "https://gitlab.freedesktop.org/gstreamer/cerbero/-/merge_requests/1900",
        },
        { role: "tool", kind: "tool_call", text: "!777" },
        {
          role: "assistant",
          kind: "message",
          text: "Upstream PR: https://github.com/AcademySoftwareFoundation/ocio-rs/pull/5",
        },
      ],
      multi,
    );
    expect(
      groups.map((group) => [
        group.project.project,
        group.root ?? null,
        group.requests.map((request) => [
          request.ref.number,
          request.sources.join("+"),
        ]),
      ]),
    ).toEqual([
      [
        "gstreamer/gstreamer",
        "/src/gstreamer",
        [
          [12855, "branch+mentioned"],
          [100, "mentioned"],
        ],
      ],
      [
        "gstreamer/gst-plugins-rs",
        "/src/gstreamer/subprojects/gst-plugins-rs",
        [[2001, "branch+mentioned"]],
      ],
      [
        "AcademySoftwareFoundation/ocio-rs",
        "/src/ocio-rs",
        [[5, "branch+mentioned"]],
      ],
      ["gstreamer/cerbero", null, [[1900, "created"]]],
    ]);
  });

  test("works before the session is known: references that name their project", () => {
    const groups = conversationRequests(
      [
        {
          role: "assistant",
          kind: "message",
          text: "!12 and https://gitlab.freedesktop.org/a/b/-/merge_requests/3",
        },
      ],
      null,
    );
    expect(groups.map((group) => group.project.project)).toEqual(["a/b"]);
  });
});

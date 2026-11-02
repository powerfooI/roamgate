import { describe, expect, test } from "bun:test";
import {
  findTerminalHttpLinks,
  sanitizeTerminalHttpUrl,
  terminalFileUriPath,
  terminalForwardCandidate,
} from "./terminalLinks";

describe("terminal HTTP links", () => {
  test("stops before Unicode prose punctuation", () => {
    const input = "Visit https://baidu.com。 then continue";
    expect(findTerminalHttpLinks(input).map((link) => link.url)).toEqual([
      "https://baidu.com",
    ]);
    for (const punctuation of [
      "。",
      "（",
      "）",
      "「",
      "」",
      "【",
      "】",
      "“",
      "”",
      "，",
    ]) {
      expect(
        sanitizeTerminalHttpUrl("https://baidu.com" + punctuation + "后续文本"),
      ).toBe("https://baidu.com");
    }
  });

  test("stops before zero-width and control characters", () => {
    expect(sanitizeTerminalHttpUrl("https://example.com\u200bhidden")).toBe(
      "https://example.com",
    );
    expect(sanitizeTerminalHttpUrl("https://example.com\u001b[31m")).toBe(
      "https://example.com",
    );
  });

  test("removes trailing ASCII prose punctuation", () => {
    expect(sanitizeTerminalHttpUrl("https://example.com/path!?")).toBe(
      "https://example.com/path",
    );
  });

  test("stops before unmatched ASCII opening delimiters", () => {
    const input =
      "MR !1205:https://git.example.com/acme/project/-/merge_requests/1205(commit e649debf)";
    expect(findTerminalHttpLinks(input).map((link) => link.url)).toEqual([
      "https://git.example.com/acme/project/-/merge_requests/1205",
    ]);
    expect(
      sanitizeTerminalHttpUrl("https://example.com/path[commit details"),
    ).toBe("https://example.com/path");
  });

  test("keeps normal URL path, query, fragment, and percent encoding", () => {
    expect(
      sanitizeTerminalHttpUrl(
        "https://example.com/a%20b?q=hello&lang=en#result",
      ),
    ).toBe("https://example.com/a%20b?q=hello&lang=en#result");
    expect(sanitizeTerminalHttpUrl("https://example.com/中文路径")).toBe(
      "https://example.com/中文路径",
    );
  });

  test("keeps balanced delimiters and IPv6 addresses", () => {
    expect(
      sanitizeTerminalHttpUrl("https://example.com/wiki/Function_(math)"),
    ).toBe("https://example.com/wiki/Function_(math)");
    expect(sanitizeTerminalHttpUrl("http://[::1]:8787/path")).toBe(
      "http://[::1]:8787/path",
    );
    expect(sanitizeTerminalHttpUrl("https://example.com/path) next")).toBe(
      "https://example.com/path",
    );
  });

  test("does not detect a URL embedded in another identifier", () => {
    expect(findTerminalHttpLinks("abchttps://example.com")).toEqual([]);
    expect(
      findTerminalHttpLinks("(https://one.example)。https://two.example").map(
        (link) => link.url,
      ),
    ).toEqual(["https://one.example", "https://two.example"]);
  });

  test("rejects unsupported or incomplete destinations", () => {
    expect(sanitizeTerminalHttpUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeTerminalHttpUrl("https://")).toBeNull();
  });
});

describe("terminal OSC 8 local file URIs", () => {
  test.each([
    ["file:///tmp/docs/guide%20one.md", "/tmp/docs/guide one.md"],
    ["file://localhost/tmp/docs", "/tmp/docs"],
    ["file://LOCALHOST/tmp/guide%23notes.md", "/tmp/guide#notes.md"],
    ["file:///tmp/guide%3Fnotes.md", "/tmp/guide?notes.md"],
    ["file:///C:/docs/guide.md", "C:/docs/guide.md"],
    ["file:///tmp/%E7%95%8C.md", "/tmp/界.md"],
  ])("decodes local target %s", (uri, path) => {
    expect(terminalFileUriPath(uri)).toBe(path);
  });
  test.each([
    "file://example.com/tmp/docs",
    "file:////example.com/share",
    "file:///%2Fexample.com/share",
    "file:///%5C%5Cexample.com/share",
    "file:///tmp/%00hidden",
    "file:///tmp/%1Bhidden",
    "file:///tmp/%C2%85hidden",
    "file:///tmp/%zz",
    "file:///tmp/docs?",
    "file:///tmp/docs#",
    "file:///tmp/docs?query",
    "file:///tmp/docs#fragment",
    "file://user@localhost/tmp/docs",
    "file:relative",
    "file:/tmp/docs",
    "javascript:alert(1)",
    "data:text/html,hello",
    "vscode://file/tmp/docs",
  ])("rejects unsupported or unsafe target %s", (uri) => {
    expect(terminalFileUriPath(uri)).toBeNull();
  });
});

describe("forward candidates", () => {
  test("only loopback URLs are worth forwarding", () => {
    expect(terminalForwardCandidate("http://localhost:5173/")?.port).toBe(5173);
    expect(terminalForwardCandidate("http://127.0.0.1:3000")?.port).toBe(3000);
    // Bound to every interface on the remote is still the remote's port.
    expect(terminalForwardCandidate("http://0.0.0.0:8080/app")?.port).toBe(
      8080,
    );

    // A routable host already works from here; forwarding it would be wrong.
    expect(terminalForwardCandidate("https://example.com/app")).toBeNull();
    expect(terminalForwardCandidate("http://192.168.1.10:3000")).toBeNull();
    expect(terminalForwardCandidate("not a url")).toBeNull();
  });

  test("defaults the port from the scheme when none is written", () => {
    expect(terminalForwardCandidate("http://localhost/")?.port).toBe(80);
    expect(terminalForwardCandidate("https://localhost/")?.port).toBe(443);
  });

  test("an IPv6 loopback link is rewritten to localhost on the local port", () => {
    const candidate = terminalForwardCandidate("http://[::1]:5173/ws?x=1#top");
    expect(candidate?.port).toBe(5173);
    expect(candidate?.rewrite(5180)).toBe("http://localhost:5180/ws?x=1#top");
  });

  test("rewrites to the local port while keeping path and query", () => {
    const candidate = terminalForwardCandidate("http://localhost:3000/app?x=1");
    expect(candidate?.rewrite(4123)).toBe("http://localhost:4123/app?x=1");
  });
});

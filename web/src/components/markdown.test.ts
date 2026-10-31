import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window as BrowserWindow } from "happy-dom";
import { isSafeMarkdownUrl, renderMarkdown } from "./markdown";

const browser = new BrowserWindow({ url: "http://localhost:8787/" });
const globalsUsed = {
  DOMParser: browser.DOMParser,
  NodeFilter: browser.NodeFilter,
};
const saved = new Map<string, PropertyDescriptor | undefined>();

beforeAll(() => {
  for (const [key, value] of Object.entries(globalsUsed)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
});

afterAll(() => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

/** The href of every link in the rendered HTML. */
function hrefs(html: string): (string | null)[] {
  const doc = new browser.DOMParser().parseFromString(html, "text/html");
  return [...doc.querySelectorAll("a")].map((a) => a.getAttribute("href"));
}

/** What a browser would run: the href without what it ignores. */
function runsScript(href: string | null) {
  return (
    href !== null &&
    /^javascript:/i.test(
      [...href].filter((char) => char > " " && char !== "\u007f").join(""),
    )
  );
}

test("a scheme split by a tab or a line break is not a relative link", () => {
  for (const html of [
    '<a href="java&#9;script:x">a</a>',
    '<a href="java&#10;script:x">a</a>',
    '<a href="&#1;javascript:x">a</a>',
    "[y](java&#9;script:alert(2))",
  ]) {
    const found = hrefs(renderMarkdown(html));
    expect(found.length).toBe(1);
    expect(found.some(runsScript)).toBe(false);
  }
  expect(isSafeMarkdownUrl("java\tscript:x")).toBe(false);
  expect(isSafeMarkdownUrl("java\nscript:x")).toBe(false);
  expect(isSafeMarkdownUrl("java\r\nscript:x")).toBe(false);
});

test("a backslash after the slash is another origin", () => {
  expect(isSafeMarkdownUrl("/\\evil.com")).toBe(false);
  expect(isSafeMarkdownUrl("\\\\evil.com")).toBe(false);
  expect(isSafeMarkdownUrl("\\/evil.com")).toBe(false);
  expect(hrefs(renderMarkdown('<a href="/\\evil.com">a</a>'))).toEqual([null]);
});

test("ordinary links still work", () => {
  expect(
    hrefs(
      renderMarkdown(
        "[a](https://example.com/x) [b](/review/1) [c](#part) [d](docs/a.md) [e](mailto:me@example.com)",
      ),
    ),
  ).toEqual([
    "https://example.com/x",
    "/review/1",
    "#part",
    "docs/a.md",
    "mailto:me@example.com",
  ]);
  expect(isSafeMarkdownUrl("javascript:alert(1)")).toBe(false);
  expect(isSafeMarkdownUrl("//evil.com")).toBe(false);
});

test("a list split by a code block keeps its numbers", () => {
  const doc = new browser.DOMParser().parseFromString(
    renderMarkdown("1. a\n\n```\ncode\n```\n\n2. b\n\n7. c"),
    "text/html",
  );
  expect(
    [...doc.querySelectorAll("ol")].map((list) => list.getAttribute("start")),
  ).toEqual([null, "2"]);
  const odd = new browser.DOMParser().parseFromString(
    renderMarkdown(
      '<ol start="2;x" onclick="y"><li>a</li></ol><ul start="3"><li>b</li></ul>',
    ),
    "text/html",
  );
  expect(odd.querySelector("ol")?.getAttributeNames()).toEqual([]);
  expect(odd.querySelector("ul")?.getAttributeNames()).toEqual([]);
});

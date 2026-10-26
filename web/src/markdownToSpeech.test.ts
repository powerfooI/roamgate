import { expect, test } from "bun:test";
import { chunkSpeech, markdownToSpeech } from "./markdownToSpeech";

test("formats paragraphs, headings, emphasis, quotes, lists and tasks structurally", () => {
  expect(
    markdownToSpeech(
      "# Status\n\n**Ready** and *working*.\n\n> A quote\n\n- first\n- second\n\n1. one\n2. two\n\n- [x] done\n- [ ] later",
    ),
  ).toBe(
    "Status\n\nReady and working.\n\nA quote\n\nfirst\n\nsecond\n\n1. one\n\n2. two\n\nCompleted. done\n\nNot completed. later",
  );
});

test("preserves short technical identifiers and escapes but omits code and diagrams", () => {
  expect(
    markdownToSpeech(
      "Use `foo_bar<T>` and `x => x + 1`, foo\\_bar &amp; &#x41;.\n\n```rust\nfn secret() {}\n```\n\n```mermaid\ngraph TD; A-->B\n```",
    ),
  ).toBe(
    "Use foo_bar<T> and x => x + 1, foo_bar & A.\n\nrust code block omitted.\n\nMermaid diagram omitted.",
  );
  expect(markdownToSpeech("    hidden code")).toBe("Code block omitted.");
});

test("reads simple tables with column context and omits oversized tables", () => {
  const header = "| Environment | Errors |\n| --- | --- |\n";
  expect(
    markdownToSpeech(header + "| Production | 17 |\n| Staging | 2 |"),
  ).toBe(
    "Table.\n\nEnvironment: Production. Errors: 17.\n\nEnvironment: Staging. Errors: 2.",
  );
  expect(markdownToSpeech(header + "| production | 1 |\n".repeat(13))).toBe(
    "Table omitted.",
  );
  expect(markdownToSpeech(header + `| ${"x".repeat(161)} | 1 |`)).toBe(
    "Table omitted.",
  );
});

test("speaks link labels, image descriptions and hostnames without leaking lengthy values", () => {
  const result = markdownToSpeech(
    "[Guide](https://example.com/private?q=secret) ![Flow chart](image.png) ![](blank.png)\n\nhttps://example.org/very/long/path?q=secret\n\n" +
      "a9".repeat(30) +
      "\n\n" +
      "x".repeat(120),
  );
  expect(result).toContain("Guide Image: Flow chart.");
  expect(result).toContain("link to example.org");
  expect(result).toContain("long hash omitted");
  expect(result).toContain("long value omitted");
  expect(result).not.toContain("secret");
  expect(markdownToSpeech("![**Flow** &#65; &amp; B](image.png)")).toBe(
    "Image: Flow A & B.",
  );
});

test("preserves long Chinese and Japanese prose without spaces", () => {
  for (const sentence of [
    "这是一段正常的中文回复，说明问题的原因以及如何处理，并且包含用户真正需要听到的详细内容。",
    "これは通常の日本語の説明です。設定を変更する前に現在の状態を確認してください。",
  ]) {
    const text = sentence.repeat(8);
    expect(text.length).toBeGreaterThan(240);
    const spoken = markdownToSpeech(text);
    expect(spoken).toBe(text);
    expect(chunkSpeech(spoken).join("")).toBe(text);
  }
});

test("omits repeated log lines without discarding distinct information", () => {
  expect(markdownToSpeech("INFO ready\n".repeat(12) + "ERROR failed")).toBe(
    "INFO ready\nRepeated line omitted 11 times.\nERROR failed",
  );
  expect(markdownToSpeech("Literal `&amp;` and `getHTTPResponse_v2`")).toBe(
    "Literal &amp; and getHTTPResponse_v2",
  );
});

test("empty, malformed and raw HTML inputs are safe and deterministic", () => {
  expect(markdownToSpeech("")).toBe("");
  expect(markdownToSpeech(" \n\n")).toBe("");
  expect(markdownToSpeech("**unfinished `expression")).toBe(
    "**unfinished `expression",
  );
  expect(markdownToSpeech("<script>alert('secret')</script>\n\nNormal")).toBe(
    "Normal",
  );
  expect(markdownToSpeech("&#99999999; &#xD800;")).toBe("\uFFFD");
  expect(markdownToSpeech("&#65; &#x1f600; &amp;#65; &amp;lt;")).toBe(
    "A 😀 &#65; &lt;",
  );
});

test("long responses remain intact and chunks prefer paragraph and sentence boundaries", () => {
  const text = markdownToSpeech(
    "A useful sentence with `foo_bar`.\n\n".repeat(1000),
  );
  const chunks = chunkSpeech(text);
  expect(chunks.length).toBeGreaterThan(100);
  expect(chunks.every((chunk) => chunk.length <= 240)).toBe(true);
  expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
  expect(
    chunkSpeech("First paragraph.\n\nNext paragraph is longer.", 25)[0],
  ).toBe("First paragraph.");
  expect(chunkSpeech("First sentence. Next sentence is longer.", 25)[0]).toBe(
    "First sentence.",
  );
  expect(chunkSpeech("x".repeat(1000)).join("")).toBe("x".repeat(1000));
  expect(chunkSpeech("😀".repeat(20), 9).join("")).toBe("😀".repeat(20));
  expect(chunkSpeech("")).toEqual([]);
  expect(() => chunkSpeech("text", 0)).toThrow();
});

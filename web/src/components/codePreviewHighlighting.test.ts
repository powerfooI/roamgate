import { describe, expect, test } from "bun:test";
import { jsonLanguage } from "@codemirror/lang-json";
import { javascriptLanguage } from "@codemirror/lang-javascript";
import { HighlightStyle } from "@codemirror/language";
import { highlightTree, tags } from "@lezer/highlight";

// The app creates its theme with direct Lezer tags while CodeMirror's parsers
// provide the syntax tree. Both must resolve to the same highlight tag instance.
const style = HighlightStyle.define([
  { tag: tags.propertyName, class: "property" },
  { tag: tags.string, class: "string" },
  { tag: tags.number, class: "number" },
  { tag: tags.bool, class: "bool" },
  { tag: tags.keyword, class: "keyword" },
]);

describe("CodePreview highlighting dependency alignment", () => {
  test("styles JSON tokens with the application's direct Lezer tags", () => {
    const text = '{"name": "Ada", "count": 42, "active": true}';
    const tokens: Array<[string, string]> = [];
    highlightTree(jsonLanguage.parser.parse(text), style, (from, to, name) => {
      tokens.push([text.slice(from, to), name]);
    });
    expect(tokens).toEqual([
      ['"name"', "property"],
      ['"Ada"', "string"],
      ['"count"', "property"],
      ["42", "number"],
      ['"active"', "property"],
      ["true", "bool"],
    ]);
  });

  test("styles JavaScript keywords and literals through the same theme", () => {
    const text = 'const answer = 42; const name = "Ada";';
    const tokens: Array<[string, string]> = [];
    highlightTree(
      javascriptLanguage.parser.parse(text),
      style,
      (from, to, name) => tokens.push([text.slice(from, to), name]),
    );
    expect(tokens).toEqual([
      ["const", "keyword"],
      ["42", "number"],
      ["const", "keyword"],
      ['"Ada"', "string"],
    ]);
  });
});

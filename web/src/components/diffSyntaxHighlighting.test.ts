import { describe, expect, test } from "bun:test";
import { hljs } from "diff2html/lib-esm/ui/js/highlight.js-slim";
import { bundledThemes } from "shiki/themes";
import {
  bundledLanguages,
  createHighlighter,
  createOnigurumaEngine,
} from "../shiki";
import { diffSyntaxLanguageForPath } from "./diffSyntaxHighlighting";
import { highlightCodeTokens } from "./syntaxHighlighting";

const fixtures = [
  [
    "schema.proto",
    "protobuf",
    'syntax = "proto3";\nmessage User { string name = 1; }',
  ],
  ["app.rb", "ruby", 'class User\n  def name\n    "Ada"\n  end\nend'],
  ["app.php", "php", '<?php echo "hello";'],
  ["app.cs", "csharp", 'public class User { string name = "Ada"; }'],
  ["main.kt", "kotlin", 'fun main() { println("hello") }'],
  ["build.gradle", "groovy", 'plugins { id "java" }'],
  ["config.xml", "xml", '<user name="Ada" />'],
  ["config.ini", "ini", '[user]\nname = "Ada"'],
  ["worker.ps1", "powershell", 'Write-Host "hello"'],
  ["script.pl", "perl", 'my $name = "Ada";'],
  ["main.m", "objective-c", "@interface User : NSObject\n@end"],
  ["query.pgsql", "sql", "SELECT * FROM users WHERE id = 1;"],
  ["policy.csp", "csp", "default-src 'self'; script-src 'none';"],
  ["analysis.R", "r", 'print("hello")'],
  ["script.sh", "zsh", 'echo "hello"'],
  ["config.yml", "yml", 'name: "Ada"'],
  ["config/.env.local", "bash", 'NAME="Ada"'],
  ["containers/Containerfile", "dockerfile", 'FROM alpine\nRUN echo "hello"'],
  ["build/GNUmakefile", "makefile", 'all:\n\techo "hello"'],
  ["ios/Podfile", "ruby", 'platform :ios, "16.0"'],
  ["config/settings.toml", "toml", '[user]\nname = "Ada"'],
  ["styles/theme.sass", "sass", "$color: red\nbody\n  color: $color"],
  ["src\\SERVICE.PROTO", "protobuf", "message User { string name = 1; }"],
] as const;

describe("Changes syntax highlighting", () => {
  test("covers every language registered by Files Preview", async () => {
    // Loading Preview also registers its extra R grammar.
    await highlightCodeTokens("x <- 1", "test.r");
    for (const language of hljs.listLanguages()) {
      if (language === "plaintext") continue;
      for (const name of [
        language,
        ...(hljs.getLanguage(language)?.aliases ?? []),
      ]) {
        expect(diffSyntaxLanguageForPath(`file.${name}`)).not.toBe("text");
      }
    }
  });

  test.each(fixtures)("resolves %s to %s", (path, language) => {
    expect(diffSyntaxLanguageForPath(path)).toBe(language);
  });

  test("preserves richer native grammars and plain-text fallback", () => {
    for (const language of ["tsx", "jsx", "vue", "mdx", "jsonc", "json5"]) {
      expect(diffSyntaxLanguageForPath(`src/file.${language}`)).toBe(language);
    }
    for (const path of [
      "README",
      "file.unknown",
      "file.txt",
      "file.constructor",
    ]) {
      expect(diffSyntaxLanguageForPath(path)).toBe("text");
    }
  });

  test.each(Object.entries(bundledLanguages))(
    "loads %s independently",
    async (language, load) => {
      const highlighter = await createHighlighter({
        langs: (await load()).default,
        themes: [await bundledThemes["github-dark"]()],
        engine: createOnigurumaEngine(import("shiki/wasm")),
      });
      try {
        // Other grammars must not mask a loader's missing dependencies or aliases.
        expect(
          highlighter.codeToTokens("value = 42", {
            lang: language,
            theme: "github-dark",
          }).tokens.length,
        ).toBeGreaterThan(0);
        for (const [path, expectedLanguage, code] of fixtures) {
          if (expectedLanguage !== language) continue;
          expect(
            (await highlightCodeTokens(code, path)).length,
          ).toBeGreaterThan(0);
          const { tokens, fg } = highlighter.codeToTokens(code, {
            lang: language,
            theme: "github-dark",
          });
          expect(tokens.flat().some((token) => token.color !== fg)).toBe(true);
        }
      } finally {
        highlighter.dispose();
      }
    },
  );
});

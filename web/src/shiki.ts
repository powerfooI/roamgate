import {
  codeToHtml,
  createCssVariablesTheme,
  createHighlighterCore,
  getTokenStyleObject,
  stringifyTokenStyle,
} from "@shikijs/core";
import type { LanguageRegistration } from "shiki/types";
export { createJavaScriptRegexEngine } from "shiki/engine/javascript";
export { createOnigurumaEngine } from "shiki/engine/oniguruma";

// Pierre normally imports Shiki's complete language registry, which makes Vite
// emit hundreds of grammar assets. Include the languages supported by Files
// Preview, plus their more specific Shiki variants; keep loading them lazily.
// Import canonical modules: tiny alias wrappers can merge into shared UI chunks
// and pull grammar groups into unrelated feature loads.
export const bundledLanguages = {
  awk: () => import("@shikijs/langs/awk"),
  bash: () => import("@shikijs/langs/shellscript"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  clojure: () => import("@shikijs/langs/clojure"),
  crystal: () => import("@shikijs/langs/crystal"),
  csharp: () => import("@shikijs/langs/csharp"),
  // Shiki has no bundled CSP grammar. Match Preview's directives and strings.
  csp: async (): Promise<{ default: LanguageRegistration[] }> => ({
    default: [
      {
        name: "csp",
        scopeName: "source.csp",
        repository: {},
        patterns: [
          { name: "entity.other.attribute-name.csp", match: "^Content[^:]*" },
          { name: "string.quoted.single.csp", begin: "'", end: "'" },
          {
            name: "keyword.control.csp",
            match:
              "\\b(?:base-uri|child-src|connect-src|default-src|font-src|form-action|frame-ancestors|frame-src|img-src|manifest-src|media-src|object-src|plugin-types|report-uri|sandbox|script-src|style-src|trusted-types|unsafe-hashes|worker-src)\\b",
          },
        ],
      },
    ],
  }),
  css: () => import("@shikijs/langs/css"),
  dart: () => import("@shikijs/langs/dart"),
  diff: () => import("@shikijs/langs/diff"),
  dockerfile: () => import("@shikijs/langs/docker"),
  elixir: () => import("@shikijs/langs/elixir"),
  elm: () => import("@shikijs/langs/elm"),
  erlang: () => import("@shikijs/langs/erlang"),
  fish: () => import("@shikijs/langs/fish"),
  fsharp: () => import("@shikijs/langs/fsharp"),
  go: () => import("@shikijs/langs/go"),
  groovy: () => import("@shikijs/langs/groovy"),
  handlebars: () => import("@shikijs/langs/handlebars"),
  haskell: () => import("@shikijs/langs/haskell"),
  html: () => import("@shikijs/langs/html"),
  ini: () => import("@shikijs/langs/ini"),
  java: () => import("@shikijs/langs/java"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  json5: () => import("@shikijs/langs/json5"),
  jsonl: () => import("@shikijs/langs/jsonl"),
  jsx: () => import("@shikijs/langs/jsx"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  less: () => import("@shikijs/langs/less"),
  lisp: () => import("@shikijs/langs/common-lisp"),
  lua: () => import("@shikijs/langs/lua"),
  makefile: () => import("@shikijs/langs/make"),
  markdown: () => import("@shikijs/langs/markdown"),
  mdx: () => import("@shikijs/langs/mdx"),
  nginx: () => import("@shikijs/langs/nginx"),
  "objective-c": () => import("@shikijs/langs/objective-c"),
  "objective-cpp": () => import("@shikijs/langs/objective-cpp"),
  perl: () => import("@shikijs/langs/perl"),
  php: () => import("@shikijs/langs/php"),
  powershell: () => import("@shikijs/langs/powershell"),
  properties: () => import("@shikijs/langs/ini"),
  protobuf: () => import("@shikijs/langs/proto"),
  python: () => import("@shikijs/langs/python"),
  r: () => import("@shikijs/langs/r"),
  ruby: () => import("@shikijs/langs/ruby"),
  rust: () => import("@shikijs/langs/rust"),
  sass: () => import("@shikijs/langs/sass"),
  scala: () => import("@shikijs/langs/scala"),
  scss: () => import("@shikijs/langs/scss"),
  shell: () => import("@shikijs/langs/shellscript"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  sh: () => import("@shikijs/langs/shellscript"),
  sql: () => import("@shikijs/langs/sql"),
  swift: () => import("@shikijs/langs/swift"),
  toml: () => import("@shikijs/langs/toml"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  vue: () => import("@shikijs/langs/vue"),
  xml: () => import("@shikijs/langs/xml"),
  yaml: () => import("@shikijs/langs/yaml"),
  yml: () => import("@shikijs/langs/yaml"),
  zsh: () => import("@shikijs/langs/shellscript"),
} as const;

export const createHighlighter = createHighlighterCore;
export {
  codeToHtml,
  createCssVariablesTheme,
  getTokenStyleObject,
  stringifyTokenStyle,
};

import { getFiletypeFromFileName } from "@pierre/diffs";
import { getLanguage } from "diff2html/lib-esm/ui/js/highlight.js-helpers";
import { bundledLanguages } from "../shiki";
import { syntaxLanguageHintForPath } from "./syntaxHighlighting";

// These Preview grammar names differ from Shiki's bundled names.
const PREVIEW_LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  "c++": "cpp",
  "h++": "cpp",
  "c#": "csharp",
  "f#": "fsharp",
  console: "shell",
  golang: "go",
  gradle: "groovy",
  htmlbars: "handlebars",
  ipython: "python",
  irb: "ruby",
  objectivec: "objective-c",
  pgsql: "sql",
  pluto: "lua",
  pwsh: "powershell",
  shellsession: "shell",
  wsf: "xml",
};

export function diffSyntaxLanguageForPath(path: string) {
  const name = path.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
  const hint = syntaxLanguageHintForPath(path);
  const previewLanguage = getLanguage(hint);
  // Preserve richer native grammars (TSX, Vue, TOML), but fall back to Preview's
  // path rules for extensionless files, extra extensions and conflicting names.
  for (const language of [
    getFiletypeFromFileName(name),
    PREVIEW_LANGUAGE_ALIASES[previewLanguage] ?? previewLanguage,
    PREVIEW_LANGUAGE_ALIASES[hint] ?? hint,
  ]) {
    if (Object.prototype.hasOwnProperty.call(bundledLanguages, language)) {
      return language as keyof typeof bundledLanguages;
    }
  }
  return "text";
}

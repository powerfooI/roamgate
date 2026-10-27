import { expect, test } from "bun:test";
import { DEFAULT_THEMES } from "@pierre/diffs";
import { themes as highlightsThemes } from "./diffHighlightsThemes";
import { themes } from "./diffThemes";
import config from "../vite.config";

test("diff bundles use curated language and theme catalogs", () => {
  const aliases = config.resolve?.alias;
  expect(Array.isArray(aliases)).toBe(true);
  if (!Array.isArray(aliases))
    throw new Error("Expected explicit Vite aliases");
  const replacement = (specifier: string) =>
    aliases.find(({ find }) =>
      typeof find === "string" ? find === specifier : find.test(specifier),
    )?.replacement;
  expect(replacement("shiki")).toEndWith("/src/shiki.ts");
  expect(replacement("shiki/langs")).toBe(replacement("shiki"));
  expect(replacement("shiki/core")).toBeUndefined();
  expect(replacement("shiki/wasm")).toBeUndefined();
  expect(replacement("@pierre/theming/themes")).toEndWith("/src/diffThemes.ts");
  expect(replacement("@pierre/highlights/themes/loader")).toEndWith(
    "/src/diffHighlightsThemes.ts",
  );
});

test("curated diff catalogs load both default theme formats", async () => {
  expect(Object.keys(highlightsThemes).sort()).toEqual(
    Object.values(DEFAULT_THEMES).sort(),
  );
  for (const name of Object.values(DEFAULT_THEMES)) {
    const descriptor = themes.getTheme(name);
    expect(descriptor).toBeDefined();
    const textmate = (await descriptor!.load()).default;
    expect(textmate.name).toBe(name);
    const zed = (
      await highlightsThemes[name as keyof typeof highlightsThemes]()
    ).default;
    expect(zed.appearance).toBe(textmate.type);
    expect(zed.style).toBeDefined();
  }
  expect(themes.getTheme("toString")).toBeUndefined();
  expect(themes.getTheme("github-dark")).toBeUndefined();
});

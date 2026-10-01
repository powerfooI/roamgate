import { describe, expect, test } from "bun:test";
import {
  assertLazyGrammarAssets,
  assertLazyEditorAssets,
  initialAssetFiles,
} from "./check-web-assets.mjs";

describe("initial web asset budget", () => {
  test("counts transitive eager JS/CSS once, without charging lazy features", () => {
    expect(
      initialAssetFiles({
        "index.html": {
          isEntry: true,
          file: "app.js",
          imports: ["shared", "other"],
          css: ["app.css"],
          dynamicImports: ["preview"],
        },
        shared: { file: "shared.js", imports: ["other"], css: ["shared.css"] },
        other: { file: "other.js", imports: ["shared"], css: ["shared.css"] },
        preview: {
          isDynamicEntry: true,
          file: "preview.js",
          css: ["preview.css"],
        },
      }).sort(),
    ).toEqual(["app.css", "app.js", "other.js", "shared.css", "shared.js"]);
  });

  test("keeps grammar groups out of unrelated feature dependency graphs", () => {
    const manifest = {
      settings: {
        name: "ConfigurationDialog",
        file: "settings.js",
        imports: ["shared"],
      },
      inspector: {
        name: "WorkspaceInspectorHost",
        file: "inspector.js",
        imports: ["shared"],
      },
      shared: { file: "shared.js", dynamicImports: ["grammar"] },
      grammar: { name: "syntax-extra", file: "grammar.js" },
    };
    expect(() => assertLazyGrammarAssets(manifest)).not.toThrow();
    expect(() =>
      assertLazyGrammarAssets({
        ...manifest,
        shared: { file: "shared.js", imports: ["grammar"] },
      }),
    ).toThrow("ConfigurationDialog eagerly loads syntax grammar asset");
    expect(() =>
      assertLazyGrammarAssets({
        ...manifest,
        inspector: { ...manifest.inspector, imports: ["grammar"] },
      }),
    ).toThrow("WorkspaceInspectorHost eagerly loads syntax grammar asset");
    expect(() => assertLazyGrammarAssets({})).toThrow(
      "Missing Vite feature chunk",
    );
  });

  test("keeps the editor lazy from the app and surrounding features", () => {
    const manifest = {
      app: { isEntry: true, file: "app.js", dynamicImports: ["editor"] },
      inspector: {
        name: "WorkspaceInspectorHost",
        file: "inspector.js",
        dynamicImports: ["editor"],
      },
      editor: { name: "code-preview", file: "editor.js" },
    };
    expect(() => assertLazyEditorAssets(manifest)).not.toThrow();
    expect(() =>
      assertLazyEditorAssets({
        ...manifest,
        app: { ...manifest.app, imports: ["editor"] },
      }),
    ).toThrow("app eagerly loads the code editor");
    expect(() =>
      assertLazyEditorAssets({
        ...manifest,
        inspector: { ...manifest.inspector, imports: ["editor"] },
      }),
    ).toThrow("inspector eagerly loads the code editor");
    expect(() => assertLazyEditorAssets({})).toThrow(
      "Missing lazy code-preview chunk",
    );
  });

  test("fails closed on missing entry points or missing eager chunks", () => {
    expect(() => initialAssetFiles({})).toThrow("no entry points");
    expect(() =>
      initialAssetFiles({
        app: { isEntry: true, file: "app.js", imports: ["missing"] },
      }),
    ).toThrow("Missing Vite manifest chunk");
  });
});

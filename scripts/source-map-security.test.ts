import { expect, test } from "bun:test";
import { createRequire } from "node:module";

const root = createRequire(new URL("../package.json", import.meta.url));
const web = createRequire(new URL("../web/package.json", import.meta.url));

test("build and DOM tooling reject excessive indexed source-map offsets", () => {
  const vite = createRequire(web.resolve("vite/package.json"));
  const jsdom = createRequire(root.resolve("jsdom/package.json"));
  for (const entry of [vite.resolve("postcss"), jsdom.resolve("css-tree")]) {
    const { SourceMapConsumer } = createRequire(entry)("source-map-js");
    const map = (line: number) => ({
      version: 3,
      sections: [
        {
          offset: { line, column: 0 },
          map: {
            version: 3,
            sources: ["input.js"],
            names: [],
            mappings: "AAAA",
          },
        },
      ],
    });
    expect(new SourceMapConsumer(map(0)).sources).toEqual(["input.js"]);
    // Construction alone must reject this before mappings can cause enormous
    // synchronous work (GHSA-68fv-2mgg-jv7q). Never expand the malicious map.
    expect(() => new SourceMapConsumer(map(Number.MAX_SAFE_INTEGER))).toThrow();
  }
});

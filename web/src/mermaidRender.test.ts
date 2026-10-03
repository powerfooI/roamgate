import { afterAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import type { RenderOptions } from "beautiful-mermaid";
import {
  loadMermaidModule,
  normalizeMermaidSource,
  prepareMermaidSvg,
  renderMermaidDiagram,
} from "./mermaidRender";

const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" width="100" height="50" style="--bg:#000;--fg:#fff">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400&amp;display=swap');
  text { font-family: 'Inter', system-ui, sans-serif; }
  svg { --_text: var(--fg); }
</style>
<defs>
  <marker id="arrowhead" markerWidth="8" markerHeight="5" refX="7" refY="2.5" orient="auto">
    <polygon points="0 0, 8 2.5, 0 5" fill="var(--_arrow)" />
  </marker>
</defs>
<polyline class="edge" data-from="A" data-to="B" points="1,2 3,4" fill="none" stroke="var(--_line)" marker-end="url(#arrowhead)" />
<g class="node" data-id="A" id="A"><text>A</text></g>
<g class="node" data-id="B" id="B"><text>&lt;img src=x onerror=alert(1)&gt;</text></g>
<style type="text/css">
  svg { --_chart-grid: var(--_inner-stroke); }
</style>
</svg>`;

// DOMPurify supports jsdom for unit tests; browser security is also checked in
// a real browser. Keep DOM globals isolated from the other Bun test files.
if (process.env.ROAMGATE_MERMAID_DOM_TEST !== "1") {
  test("Mermaid SVG preparation in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_MERMAID_DOM_TEST: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
    expect(code).toBe(0);
  }, 15_000);
} else {
  registerDomTests();
}

function registerDomTests() {
  const browser = new JSDOM("", { url: "http://localhost" });
  Object.assign(globalThis, {
    window: browser.window,
    DOMParser: browser.window.DOMParser,
  });
  afterAll(() => browser.window.close());

  describe("prepareMermaidSvg", () => {
    test("strips the document-global style block", () => {
      const prepared = prepareMermaidSvg(SAMPLE_SVG, "mmd-7");
      expect(prepared).not.toContain("<style");
      expect(prepared).not.toContain("fonts.googleapis.com");
    });

    test("namespaces ids and marker references so diagrams cannot collide", () => {
      const prepared = prepareMermaidSvg(SAMPLE_SVG, "mmd-7");
      expect(prepared).toContain('id="mmd-7-arrowhead"');
      expect(prepared).toContain("url(#mmd-7-arrowhead)");
      expect(prepared).toContain('id="mmd-7-A"');
      expect(prepared).toContain('id="mmd-7-B"');
      expect(prepared).not.toContain(' id="A"');
      // Attribute-only lookalikes stay untouched.
      expect(prepared).toContain('data-id="A"');
    });
  });

  describe("SVG security boundary", () => {
    const wrap = (content: string) =>
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">${content}</svg>`;
    const parse = (svg: string) =>
      new DOMParser().parseFromString(svg, "image/svg+xml");

    test("removes active SVG/HTML content, event attributes, and unsafe URLs", () => {
      const prepared = prepareMermaidSvg(
        wrap(`
      <script>window.__mermaidXss = true</script>
      <g onload="alert(1)" ONCLICK="alert(1)"><text>safe label</text></g>
      <a href="javascript:alert(1)"><text>link</text></a>
      <a xlink:href="data:text/html,evil"><text>data</text></a>
      <foreignObject><div xmlns="http://www.w3.org/1999/xhtml" onclick="alert(1)">html</div></foreignObject>
      <image href="https://example.invalid/tracker.svg" onerror="alert(1)" />
      <animate attributeName="href" values="javascript:alert(1)" />
      <set attributeName="onload" to="alert(1)" />
      <path fill="url(https://example.invalid/paint.svg#p)" style="background:url(https://example.invalid/style)" />
      <path FILL="url(https://example.invalid/uppercase)" STYLE="position:fixed;background:url(https://example.invalid/css)" />
      <a HREF="https://example.invalid/uppercase"><text>uppercase link</text></a>
    `),
        "mmd-safe",
      );
      const document = parse(prepared);
      expect(
        document.querySelector("script, foreignObject, image, animate, set"),
      ).toBeNull();
      expect(prepared).not.toMatch(
        /onload|onclick|javascript:|data:text|example\.invalid/i,
      );
      expect(document.querySelector("text")?.textContent).toBe("safe label");
      expect(document.documentElement.getAttribute("style")).toContain(
        "--fg:var(--text)",
      );
    });

    test("removes nested and namespaced style nodes and rejects malformed/non-SVG markup", () => {
      const prepared = prepareMermaidSvg(
        wrap(
          `<style><style>text { fill:red }</style></style><g><style type="text/css">@import 'bad';</style></g><text>ok</text>`,
        ),
        "mmd-style",
      );
      expect(parse(prepared).querySelector("style")).toBeNull();
      expect(prepared).not.toContain("@import");
      for (const invalid of [
        "<svg><style></svg>",
        "<html><body>bad</body></html>",
        "<svg xmlns='urn:wrong' />",
      ]) {
        expect(() => prepareMermaidSvg(invalid, "mmd-invalid")).toThrow(
          "Invalid Mermaid SVG",
        );
      }
    });

    test("rewrites root IDs, quoted fragments, hrefs, and accessibility ID references", () => {
      const input = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" id="chart" aria-labelledby="title desc"><title id="title">Title</title><desc id="desc">Description</desc><defs><marker id="arrow"><path d="M0 0L1 1" /></marker></defs><path marker-end="url( '#arrow' )"/><a href="#arrow"><text>local link</text></a><a xlink:href="#arrow"><text>xlink</text></a><text>&lt;img src=x onerror=alert(1)&gt; &amp; safe</text></svg>`;
      const first = parse(prepareMermaidSvg(input, "mmd-one"));
      const second = parse(prepareMermaidSvg(input, "mmd-two"));
      expect(first.documentElement.id).toBe("mmd-one-chart");
      expect(first.documentElement.getAttribute("aria-labelledby")).toBe(
        "mmd-one-title mmd-one-desc",
      );
      expect(
        first.querySelector("path[marker-end]")?.getAttribute("marker-end"),
      ).toBe("url(#mmd-one-arrow)");
      const links = first.querySelectorAll("a");
      expect(links.length).toBe(2);
      for (const link of links) {
        expect(
          link.getAttribute("href") ?? link.getAttribute("xlink:href"),
        ).toBe("#mmd-one-arrow");
      }
      expect(first.querySelector("svg > text")?.textContent).toBe(
        "<img src=x onerror=alert(1)> & safe",
      );
      expect(first.querySelector("img")).toBeNull();
      expect(second.querySelector("marker")?.id).toBe("mmd-two-arrow");
      const mixedCase = parse(
        prepareMermaidSvg(
          wrap(
            '<defs><marker ID="arrow" /></defs><path Id="edge" MARKER-END="url(#arrow)"/>',
          ),
          "mmd-case",
        ),
      );
      expect(mixedCase.querySelector("marker")?.id).toBe("mmd-case-arrow");
      expect(mixedCase.querySelector("path")?.id).toBe("mmd-case-edge");
      expect(mixedCase.querySelector("path")?.getAttribute("marker-end")).toBe(
        "url(#mmd-case-arrow)",
      );
    });
  });

  describe("renderMermaidDiagram", () => {
    test("renders with theme variables and a unique token", () => {
      let seenOptions: RenderOptions | undefined;
      const mermaid = {
        renderMermaidSVG(_code: string, options?: RenderOptions) {
          seenOptions = options;
          return SAMPLE_SVG;
        },
      };
      const first = renderMermaidDiagram(mermaid, "graph LR\n  A --> B");
      const second = renderMermaidDiagram(mermaid, "graph LR\n  A --> B");
      expect(seenOptions).toMatchObject({
        bg: "var(--viewer-code-bg)",
        fg: "var(--text)",
        line: "var(--accent)",
        transparent: true,
      });
      if (!first.ok || !second.ok) throw new Error("expected rendered svgs");
      expect(first.svg).toContain("<svg");
      const firstToken = first.svg.match(/id="(mmd-\d+)-arrowhead"/)?.[1];
      const secondToken = second.svg.match(/id="(mmd-\d+)-arrowhead"/)?.[1];
      expect(firstToken).toBeTruthy();
      expect(secondToken).toBeTruthy();
      expect(firstToken).not.toBe(secondToken);
    });

    test("reports renderer failures without throwing", () => {
      const mermaid = {
        renderMermaidSVG() {
          throw new Error('Invalid mermaid header: "junk"');
        },
      };
      const result = renderMermaidDiagram(mermaid, "junk");
      expect(result).toEqual({
        ok: false,
        error: 'Invalid mermaid header: "junk"',
      });
    });
  });

  describe("standalone Mermaid source", () => {
    test("renders supported diagrams with leading file comments", async () => {
      const renderer = await loadMermaidModule();
      for (const source of [
        "sequenceDiagram\n Alice->>Bob: Hello",
        "classDiagram\n A --> B",
        "flowchart LR\n A[Start] --> B[End]\n classDef blue fill:#123456,stroke:#abcdef\n class A blue",
        "stateDiagram-v2\n [*] --> Running\n Running --> [*]",
        "erDiagram\n CUSTOMER ||--o{ ORDER : places",
      ]) {
        expect(
          renderMermaidDiagram(
            renderer,
            "\uFEFF%% File header\r\n\r\n" + source,
          ).ok,
        ).toBe(true);
      }
    });

    test("unwraps fenced files and YAML headers without altering diagram labels", async () => {
      const source = "flowchart LR\n A[Start] --> B[End]";
      expect(normalizeMermaidSource("```mermaid\n" + source + "\n```")).toBe(
        source,
      );
      expect(
        normalizeMermaidSource("---\ntitle: Example\n---\n" + source),
      ).toBe(source);
      expect(
        normalizeMermaidSource('%%{init: {"theme": "dark"}}%%\n' + source),
      ).toBe(source);
      expect(
        renderMermaidDiagram(
          await loadMermaidModule(),
          "---\ntitle: Example\n---\n" + source,
        ).ok,
      ).toBe(true);
      expect(normalizeMermaidSource("flowchart LR\n A[100%%] --> B")).toContain(
        "100%%",
      );
    });
  });
}

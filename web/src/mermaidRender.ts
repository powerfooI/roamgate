import createDOMPurify from "dompurify";

/**
 * Mermaid diagram rendering backed by beautiful-mermaid. The renderer and its
 * layout engine are lazily code-split so the main bundle stays small; both
 * file previews and Markdown code fences share the cached module promise.
 */

export type MermaidRenderResult =
  | { ok: true; svg: string }
  | { ok: false; error: string };

type MermaidModule = typeof import("beautiful-mermaid");

let mermaidModulePromise: Promise<MermaidModule> | null = null;

export function loadMermaidModule(): Promise<MermaidModule> {
  mermaidModulePromise ??= import("beautiful-mermaid");
  return mermaidModulePromise;
}

let mermaidDiagramCounter = 0;

const MERMAID_THEME = {
  bg: "var(--viewer-code-bg)",
  fg: "var(--text)",
  line: "var(--accent)",
} as const;

/**
 * Prepare the renderer's SVG in an inert document, then sanitize the finished
 * markup for HTML insertion. DOM parsing/ID rewriting alone is not sanitization.
 */
export function prepareMermaidSvg(svg: string, token: string): string {
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = document.documentElement;
  if (
    root.localName !== "svg" ||
    root.namespaceURI !== "http://www.w3.org/2000/svg" ||
    document.querySelector("parsererror")
  ) {
    throw new Error("Invalid Mermaid SVG");
  }

  // The renderer's global selectors and font imports must not escape the chart.
  for (const style of root.querySelectorAll("style")) style.remove();
  const elements = [root, ...root.querySelectorAll("*")];
  const ids = new Map<string, string>();
  for (const element of elements) {
    // XML preserves case, while the final HTML parse folds attribute names.
    // Handle case variants here too, before the sanitizer sees that context.
    for (const attribute of [...element.attributes]) {
      const name = attribute.localName.toLowerCase();
      // DOMPurify does not sanitize CSS. Only our trusted root theme is needed.
      if (name === "style") element.removeAttributeNode(attribute);
      else if (name === "id" && attribute.name !== "id") {
        element.removeAttributeNode(attribute);
        element.setAttribute("id", attribute.value);
      }
    }
    const id = element.getAttribute("id");
    if (id) ids.set(id, `${token}-${id}`);
  }
  for (const element of elements) {
    const id = element.getAttribute("id");
    if (id) element.setAttribute("id", ids.get(id)!);
    for (const attribute of [...element.attributes]) {
      const name = attribute.localName.toLowerCase();
      if (name === "href") {
        const target = attribute.value.startsWith("#")
          ? ids.get(attribute.value.slice(1))
          : undefined;
        if (target) attribute.value = `#${target}`;
        else element.removeAttributeNode(attribute);
      } else if (
        [
          "fill",
          "stroke",
          "filter",
          "clip-path",
          "mask",
          "marker-start",
          "marker-mid",
          "marker-end",
        ].includes(name)
      ) {
        // Only references to this SVG's definitions are supported. Never leave
        // external paint/filter URLs or CSS-escaped URL spellings in the page.
        const reference = attribute.value.match(
          /^url\(\s*(["']?)#([^\s"'()]+)\1\s*\)$/i,
        );
        const target = reference ? ids.get(reference[2]!) : undefined;
        if (target) attribute.value = `url(#${target})`;
        else if (/url|\\/i.test(attribute.value))
          element.removeAttributeNode(attribute);
      } else if (["aria-labelledby", "aria-describedby"].includes(name)) {
        attribute.value = attribute.value
          .split(/\s+/)
          .map((value) => ids.get(value) ?? value)
          .join(" ");
      }
    }
  }
  root.setAttribute(
    "style",
    Object.entries(MERMAID_THEME)
      .map(([key, value]) => `--${key}:${value}`)
      .join(";"),
  );

  // This must be the final transformation before dangerouslySetInnerHTML.
  // Keep HTML/foreignObject, scripts, event handlers, and global CSS out.
  return createDOMPurify(window).sanitize(root.outerHTML, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["style", "foreignObject", "image"],
  });
}

/** Standalone sources often include a file header before the diagram type. */
export function normalizeMermaidSource(code: string): string {
  let source = code.replace(/^\uFEFF/, "").trim();
  const fenced = source.match(
    /^(`{3,}|~{3,})mermaid[^\S\n]*\r?\n([\s\S]*?)\r?\n\1$/i,
  );
  if (fenced) source = fenced[2]!.trim();
  // Layout/theme are controlled by Studio; a YAML document header is not a
  // diagram statement. Preserve the original file for source views and Copy.
  source = source
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
    .trimStart();
  while (source.startsWith("%%")) {
    const header = source.startsWith("%%{")
      ? source.match(/^%%\{[\s\S]*?\}%%(?:[^\S\n]*\r?\n|$)/)?.[0]
      : source.match(/^%%[^\n]*(?:\n|$)/)?.[0];
    if (!header) break;
    source = source.slice(header.length).trimStart();
  }
  return source;
}

export function renderMermaidDiagram(
  mermaid: Pick<MermaidModule, "renderMermaidSVG">,
  code: string,
): MermaidRenderResult {
  try {
    const svg = mermaid.renderMermaidSVG(normalizeMermaidSource(code), {
      // Reference app theme variables so light/dark switches apply without a
      // re-render. Diagram labels are XML-escaped by the renderer.
      ...MERMAID_THEME,
      transparent: true,
    });
    mermaidDiagramCounter += 1;
    return {
      ok: true,
      svg: prepareMermaidSvg(svg, `mmd-${mermaidDiagramCounter}`),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

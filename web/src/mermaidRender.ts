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

/**
 * Rewrites renderer output for safe inline embedding:
 * - drops the bundled <style> block, whose bare `svg`/`text` selectors and
 *   Google Fonts @import would leak into the whole document (the scoped
 *   replacement lives in components/MermaidDiagram.css);
 * - prefixes svg-internal ids so multiple diagrams on one page cannot share
 *   `arrowhead`/node ids and cross-reference each other's markers.
 */
export function prepareMermaidSvg(svg: string, token: string): string {
  let result = svg.replace(/<style[^>]*>[\s\S]*?<\/style>/g, "");
  const ids = new Set(
    Array.from(result.matchAll(/\sid="([^"]+)"/g), (match) => match[1]),
  );
  for (const id of ids) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result
      .replace(new RegExp(`(\\s)id="${escaped}"`, "g"), `$1id="${token}-${id}"`)
      .split(`url(#${id})`)
      .join(`url(#${token}-${id})`);
  }
  return result;
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
      bg: "var(--viewer-code-bg)",
      fg: "var(--text)",
      line: "var(--accent)",
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

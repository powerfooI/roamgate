import { useEffect, useState } from "react";
import {
  loadMermaidModule,
  normalizeMermaidSource,
  renderMermaidDiagram,
} from "../mermaidRender";

import { ZoomablePreview } from "./ZoomablePreview";
import "./MermaidDiagram.css";

type MermaidDiagramState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "error"; error: string }
  | { kind: "svg"; svg: string; width: number; height: number };

export function MermaidDiagram({
  code,
  className = "",
}: {
  code: string;
  className?: string;
}) {
  const [state, setState] = useState<MermaidDiagramState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    if (!normalizeMermaidSource(code).trim()) {
      setState({ kind: "empty" });
      return () => {
        cancelled = true;
      };
    }
    setState({ kind: "loading" });
    void loadMermaidModule().then(
      (mermaid) => {
        if (cancelled) return;
        const rendered = renderMermaidDiagram(mermaid, code);
        if (!rendered.ok) {
          setState({ kind: "error", error: rendered.error });
          return;
        }
        const svg = new DOMParser().parseFromString(
          rendered.svg,
          "image/svg+xml",
        ).documentElement;
        const viewBox = svg
          .getAttribute("viewBox")
          ?.trim()
          .split(/[\s,]+/)
          .map(Number);
        const width = Number(svg.getAttribute("width")) || viewBox?.[2] || 800;
        const height =
          Number(svg.getAttribute("height")) || viewBox?.[3] || 600;
        setState({ kind: "svg", svg: rendered.svg, width, height });
      },
      (error) => {
        if (cancelled) return;
        setState({
          kind: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (state.kind === "loading") {
    return (
      <div
        className={`mermaid-diagram is-loading ${className}`.trim()}
        role="status"
        aria-live="polite"
      >
        <span className="file-loading-spinner" />
        Rendering diagram
      </div>
    );
  }
  if (state.kind === "empty") {
    return (
      <div className={`mermaid-diagram is-empty ${className}`.trim()}>
        Empty diagram
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className={`mermaid-diagram-error ${className}`.trim()} role="alert">
        Mermaid render failed: {state.error}
        <details>
          <summary>Show diagram source</summary>
          <pre>
            <code>{code}</code>
          </pre>
        </details>
      </div>
    );
  }
  return (
    <ZoomablePreview
      key={code}
      dimensions={state}
      label="Mermaid diagram"
      className={`mermaid-diagram ${className}`.trim()}
    >
      <div
        className="mermaid-svg"
        role="img"
        aria-label="Mermaid diagram"
        // Renderer labels are escaped, styles are scoped, and IDs are unique.
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
    </ZoomablePreview>
  );
}

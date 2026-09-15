import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ImagePreview } from "./ImagePreview";
import { MermaidDiagram } from "./MermaidDiagram";
import { MarkdownPreview } from "./markdown";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/vendor.css";

const failures: string[] = [];
const check = (condition: boolean, message: string) => {
  if (!condition) failures.push(message);
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await settle();
  }
  throw new Error(
    "Preview did not become ready: " + document.body.innerText.slice(0, 1000),
  );
}
async function run() {
  const container = document.createElement("div");
  container.style.cssText =
    "width:600px;height:850px;display:flex;flex-direction:column";
  document.body.append(container);
  const root = createRoot(container);
  const text =
    "# Diagrams\n\n```mermaid\nflowchart LR\n A[Start] --> B[Done]\n```\n\n```mermaid\n%% file header\nsequenceDiagram\n Alice->>Bob: Hello\n```";
  const renderMarkdown = (text: string) =>
    root.render(
      <StrictMode>
        <MarkdownPreview text={text} />
      </StrictMode>,
    );
  const diagrams = () =>
    container.querySelectorAll<HTMLElement>(".mermaid-diagram.visual-preview");
  const level = (element: Element) =>
    element.querySelector("output")?.textContent;
  try {
    renderMarkdown(text);
    await waitFor(
      () => container.querySelectorAll(".mermaid-svg > svg").length === 2,
    );
    check(diagrams().length === 2, "StrictMode lost Markdown diagrams");
    const first = diagrams()[0]!;
    const second = diagrams()[1]!;
    const before = level(first);
    const other = level(second);
    first.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click();
    await settle();
    check(level(first) !== before, "Zoom did not change the selected diagram");
    check(level(second) === other, "Zoom affected another diagram");
    renderMarkdown("# Replacement\n\n```mermaid\nflowchart TD\n X --> Y\n```");
    await waitFor(
      () =>
        container.querySelectorAll(".mermaid-svg > svg").length === 1 &&
        container.textContent!.includes("Replacement"),
    );
    renderMarkdown(text);
    await waitFor(
      () => container.querySelectorAll(".mermaid-svg > svg").length === 2,
    );
    check(
      container.querySelectorAll(".markdown-mermaid-slot").length === 2,
      "Navigation leaked diagram mounts",
    );

    root.render(
      <StrictMode>
        <MermaidDiagram
          code={"%% Header\nsequenceDiagram\n Alice->>Bob: Standalone"}
          className="file-preview-mermaid"
        />
      </StrictMode>,
    );
    await waitFor(
      () =>
        !!container.querySelector(".file-preview-mermaid .mermaid-svg > svg"),
    );
    check(
      container.textContent!.includes("Standalone"),
      "Standalone source header did not render",
    );
    check(
      container.querySelector(".visual-preview-viewport")!.clientHeight > 200,
      "Standalone viewport collapsed",
    );
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600"><rect width="1200" height="600" fill="blue"/></svg>';
    root.render(
      <StrictMode>
        <ImagePreview
          src={`data:image/svg+xml,${encodeURIComponent(svg)}`}
          name="vector.svg"
        />
      </StrictMode>,
    );
    await waitFor(
      () => !!container.querySelector(".visual-preview-content > img"),
    );
    const viewport = container.querySelector<HTMLElement>(
      ".visual-preview-viewport",
    )!;
    container
      .querySelector<HTMLButtonElement>('[title="Actual size"]')!
      .click();
    await settle();
    check(
      viewport.scrollWidth > viewport.clientWidth,
      "Actual-size image cannot be panned",
    );
    container
      .querySelector<HTMLButtonElement>('[title="Fit preview"]')!
      .click();
    await settle();
    check(
      viewport.scrollWidth <= viewport.clientWidth + 1,
      "Fit image overflows its viewport",
    );
  } finally {
    root.unmount();
    container.remove();
  }
}
run()
  .catch((error: unknown) => failures.push(String(error)))
  .finally(() => {
    document.documentElement.dataset.visualPreviewResult =
      JSON.stringify(failures);
    void fetch("/result", { method: "POST", body: JSON.stringify(failures) });
  });

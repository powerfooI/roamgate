import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";

export const PDF_PAGE_WINDOW = 3;
const MAX_CANVAS_PIXELS = 2_000_000;
const MAX_CANVAS_SIDE = 4096;

/** A bounded window: advancing releases the previous canvases, including GPU memory. */
export function renderPdfPages(
  document: PDFDocumentProxy,
  box: HTMLDivElement,
  first: number,
  width: number,
  pixelRatio: number,
) {
  let cancelled = false;
  let active: RenderTask | undefined;
  const canvases: HTMLCanvasElement[] = [];
  const done = (async () => {
    const last = Math.min(document.numPages, first + PDF_PAGE_WINDOW - 1);
    for (let number = first; number <= last; number++) {
      const page = await document.getPage(number);
      try {
        if (cancelled) return;
        const natural = page.getViewport({ scale: 1 });
        const scale = Math.min(
          (width / natural.width) * Math.min(pixelRatio || 1, 2),
          Math.sqrt(MAX_CANVAS_PIXELS / (natural.width * natural.height)),
          MAX_CANVAS_SIDE / Math.max(natural.width, natural.height),
        );
        const viewport = page.getViewport({ scale });
        const canvas = box.ownerDocument.createElement("canvas");
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        canvas.style.width = "100%";
        canvas.style.height = "auto";
        canvas.setAttribute("role", "img");
        canvas.setAttribute("aria-label", `Page ${number}`);
        canvases.push(canvas);
        box.append(canvas);
        active = page.render({ canvas, viewport });
        await active.promise;
        active = undefined;
      } finally {
        page.cleanup();
      }
      if (cancelled) return;
    }
  })();
  return {
    done,
    cancel() {
      cancelled = true;
      active?.cancel();
      for (const canvas of canvases) {
        canvas.remove();
        canvas.width = 0;
        canvas.height = 0;
      }
    },
  };
}

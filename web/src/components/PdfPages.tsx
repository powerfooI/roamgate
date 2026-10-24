import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";
import "./PdfPages.css";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Pages drawn past this many wait for a tap: each one is a full canvas. */
const PAGE_BATCH = 30;
/** Sharp enough on a phone, without canvases too large for its memory. */
const MAX_PIXEL_RATIO = 2;

type PdfState =
  | { status: "loading" }
  | { status: "ready"; pages: number; shown: number }
  | { status: "error"; message: string };

/**
 * A PDF drawn page by page with PDF.js, for browsers that do not show PDFs
 * in a frame themselves (Chrome on Android, Safari on iOS).
 */
export default function PdfPages({ url, name }: { url: string; name: string }) {
  const pagesRef = useRef<HTMLDivElement>(null);
  const documentRef = useRef<pdfjs.PDFDocumentProxy | null>(null);
  const drawnRef = useRef(0);
  const [state, setState] = useState<PdfState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    drawnRef.current = 0;
    pagesRef.current?.replaceChildren();
    setState({ status: "loading" });
    const task = pdfjs.getDocument({ url });
    task.promise.then(
      (document) => {
        if (cancelled) return;
        documentRef.current = document;
        setState({
          status: "ready",
          pages: document.numPages,
          shown: Math.min(document.numPages, PAGE_BATCH),
        });
      },
      (error: unknown) => {
        if (!cancelled)
          setState({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
      },
    );
    return () => {
      cancelled = true;
      documentRef.current = null;
      void task.destroy();
    };
  }, [url]);

  const shown = state.status === "ready" ? state.shown : 0;
  useEffect(() => {
    const document = documentRef.current;
    const box = pagesRef.current;
    if (!document || !box || drawnRef.current >= shown) return;
    let cancelled = false;
    void (async () => {
      const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
      for (let number = drawnRef.current + 1; number <= shown; number++) {
        if (cancelled) return;
        const page = await document.getPage(number);
        if (cancelled) return;
        // Fit the page to the viewer's width, drawn at the screen's density.
        const width = Math.max(box.clientWidth - 16, 200);
        const scale = width / page.getViewport({ scale: 1 }).width;
        const viewport = page.getViewport({ scale: scale * ratio });
        const canvas = window.document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
        canvas.style.height = `${Math.floor(viewport.height / ratio)}px`;
        canvas.setAttribute("role", "img");
        canvas.setAttribute("aria-label", `Page ${number}`);
        box.append(canvas);
        drawnRef.current = number;
        await page.render({ canvas, viewport }).promise;
      }
    })().catch((error: unknown) => {
      if (!cancelled)
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
    });
    return () => {
      cancelled = true;
    };
  }, [shown]);

  return (
    <div className="pdf-pages" role="document" aria-label={`PDF: ${name}`}>
      {state.status === "loading" ? (
        <div className="file-preview-state">Loading the PDF...</div>
      ) : null}
      {state.status === "error" ? (
        <div className="file-preview-state">
          Cannot show this PDF: {state.message}
        </div>
      ) : null}
      <div ref={pagesRef} className="pdf-pages-list" />
      {state.status === "ready" && state.shown < state.pages ? (
        <button
          type="button"
          className="secondary-btn pdf-pages-more"
          onClick={() =>
            setState({
              ...state,
              shown: Math.min(state.pages, state.shown + PAGE_BATCH),
            })
          }
        >
          Show the next pages ({state.shown} of {state.pages} shown)
        </button>
      ) : null}
    </div>
  );
}

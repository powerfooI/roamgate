import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";
import { PDF_PAGE_WINDOW, renderPdfPages } from "./pdfPageRenderer";
import "./PdfPages.css";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type PdfState =
  | { status: "loading" }
  | { status: "ready"; document: pdfjs.PDFDocumentProxy; first: number }
  | { status: "error"; message: string };

/** Native-viewer fallback with a bounded number of canvases on mobile. */
export default function PdfPages({ url, name }: { url: string; name: string }) {
  const pagesRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<PdfState>({ status: "loading" });
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const box = pagesRef.current;
    if (!box) return;
    const resize = () => setWidth(Math.max(1, box.clientWidth - 16));
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    const task = pdfjs.getDocument({ url });
    task.promise.then(
      (document) => {
        if (!cancelled) setState({ status: "ready", document, first: 1 });
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: "error", message: String(error) });
      },
    );
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [url]);

  const document = state.status === "ready" ? state.document : null;
  const first = state.status === "ready" ? state.first : 1;
  useEffect(() => {
    const box = pagesRef.current;
    if (!document || !box || !width) return;
    let cancelled = false;
    const render = renderPdfPages(
      document,
      box,
      first,
      width,
      window.devicePixelRatio,
    );
    void render.done.catch((error: unknown) => {
      if (!cancelled) setState({ status: "error", message: String(error) });
    });
    return () => {
      cancelled = true;
      render.cancel();
    };
  }, [document, first, width]);

  const move = (offset: number) => {
    if (state.status !== "ready") return;
    setState({ ...state, first: state.first + offset });
    pagesRef.current?.parentElement?.scrollTo(0, 0);
  };
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
      {state.status === "ready" ? (
        <nav className="pdf-pages-navigation" aria-label="PDF pages">
          <button
            type="button"
            className="secondary-btn"
            disabled={first === 1}
            onClick={() => move(-PDF_PAGE_WINDOW)}
          >
            Previous pages
          </button>
          <span>
            Pages {first}-
            {Math.min(document!.numPages, first + PDF_PAGE_WINDOW - 1)} of{" "}
            {document!.numPages}
          </span>
          <button
            type="button"
            className="secondary-btn"
            disabled={first + PDF_PAGE_WINDOW > document!.numPages}
            onClick={() => move(PDF_PAGE_WINDOW)}
          >
            Next pages
          </button>
        </nav>
      ) : null}
      <div ref={pagesRef} className="pdf-pages-list" />
    </div>
  );
}

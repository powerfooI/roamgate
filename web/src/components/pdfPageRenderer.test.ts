import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { renderPdfPages } from "./pdfPageRenderer";

function fixture(pending = false) {
  const browser = new Window();
  const box = browser.document.createElement("div");
  const visited: number[] = [];
  let cleaned = 0;
  let cancelled = 0;
  let reject!: (reason: Error) => void;
  const document = {
    numPages: 100,
    async getPage(number: number) {
      visited.push(number);
      return {
        getViewport: ({ scale }: { scale: number }) => ({
          width: 600 * scale,
          height: 900 * scale,
        }),
        render: () => ({
          promise: pending
            ? new Promise<void>((_, no) => {
                reject = no;
              })
            : Promise.resolve(),
          cancel: () => {
            cancelled++;
            reject(new Error("cancelled"));
          },
        }),
        cleanup: () => {
          cleaned++;
        },
      };
    },
  } as unknown as PDFDocumentProxy;
  return {
    document,
    box: box as unknown as HTMLDivElement,
    visited,
    cleaned: () => cleaned,
    cancelled: () => cancelled,
  };
}

test("a long PDF keeps only three canvases with bounded pixel memory", async () => {
  const f = fixture();
  const first = renderPdfPages(f.document, f.box, 1, 4000, 4);
  await first.done;
  expect(f.visited).toEqual([1, 2, 3]);
  const old = [...f.box.querySelectorAll("canvas")];
  expect(old).toHaveLength(3);
  for (const canvas of old) {
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(2_000_000);
    expect(canvas.style.height).toBe("auto");
  }
  first.cancel();
  expect(f.box.children.length).toBe(0);
  expect(old.every((c) => c.width === 0 && c.height === 0)).toBe(true);
  const next = renderPdfPages(f.document, f.box, 4, 320, 2);
  await next.done;
  expect(f.visited).toEqual([1, 2, 3, 4, 5, 6]);
  expect(f.box.children.length).toBe(3);
  expect(f.cleaned()).toBe(6);
  next.cancel();
});

test("resizing and backward navigation rerender with the right proportions", async () => {
  const f = fixture();
  const wide = renderPdfPages(f.document, f.box, 4, 1000, 2);
  await wide.done;
  wide.cancel();
  const narrow = renderPdfPages(f.document, f.box, 1, 320, 2);
  await narrow.done;
  const canvas = f.box.querySelector("canvas")!;
  expect(canvas.width).toBe(640);
  expect(canvas.height).toBe(960);
  expect(canvas.style.width).toBe("100%");
  expect(f.visited).toEqual([4, 5, 6, 1, 2, 3]);
  narrow.cancel();
});

test("unmount cancels an active render and releases its canvas", async () => {
  const f = fixture(true);
  const render = renderPdfPages(f.document, f.box, 1, 320, 2);
  await Promise.resolve();
  render.cancel();
  await expect(render.done).rejects.toThrow("cancelled");
  expect(f.cancelled()).toBe(1);
  expect(f.cleaned()).toBe(1);
  expect(f.visited).toEqual([1]);
  expect(f.box.children.length).toBe(0);
});

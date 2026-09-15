import { createRoot } from "react-dom/client";
import { OverlayScrollbarLayer } from "./OverlayScrollbarLayer";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/vendor.css";

const failures: string[] = [];
function check(condition: boolean, message: string) {
  if (!condition) failures.push(message);
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

async function run() {
  const host = document.createElement("div");
  const scroller = document.createElement("div");
  scroller.style.cssText =
    "position:fixed;right:20px;top:40px;width:300px;height:200px;overflow:auto";
  const content = document.createElement("div");
  content.style.cssText = "width:800px;height:1000px";
  scroller.append(content);
  document.body.append(scroller, host);
  const root = createRoot(host);
  root.render(<OverlayScrollbarLayer />);
  await settle();
  try {
    for (const scale of [1, 0.9, 1.25]) {
      document.documentElement.style.zoom = String(scale);
      for (const width of [300, 400]) {
        scroller.style.width = `${width}px`;
        scroller.scrollTop = 160;
        scroller.scrollLeft = 80;
        scroller.dispatchEvent(new Event("scroll"));
        await settle();
        const vertical = host.querySelector<HTMLElement>(".is-vertical");
        const horizontal = host.querySelector<HTMLElement>(".is-horizontal");
        check(!!vertical && !!horizontal, "Both axes must render");
        if (!vertical || !horizontal) continue;
        const bounds = scroller.getBoundingClientRect();
        const v = vertical.getBoundingClientRect();
        const h = horizontal.getBoundingClientRect();
        check(
          Math.abs(v.right - (bounds.right - 3)) < 1,
          `${scale}/${width}: vertical thumb must align with panel right edge`,
        );
        check(
          Math.abs(h.bottom - (bounds.bottom - 3)) < 1,
          `${scale}/${width}: horizontal thumb must align with panel bottom edge`,
        );
        check(
          v.top >= bounds.top && v.bottom <= bounds.bottom,
          `${scale}/${width}: vertical thumb must stay inside the panel`,
        );
        for (const [thumb, axis, viewport, size, maxScroll] of [
          [
            vertical,
            "y",
            bounds.height,
            v.height,
            scroller.scrollHeight - scroller.clientHeight,
          ],
          [
            horizontal,
            "x",
            bounds.width,
            h.width,
            scroller.scrollWidth - scroller.clientWidth,
          ],
        ] as const) {
          // Synthetic pointers do not have a native capture session.
          thumb.setPointerCapture = () => {};
          thumb.hasPointerCapture = () => false;
          const initial =
            axis === "y" ? scroller.scrollTop : scroller.scrollLeft;
          thumb.dispatchEvent(
            new PointerEvent("pointerdown", {
              bubbles: true,
              pointerId: 1,
              clientX: 100,
              clientY: 100,
            }),
          );
          thumb.dispatchEvent(
            new PointerEvent("pointermove", {
              bubbles: true,
              pointerId: 1,
              clientX: axis === "x" ? 120 : 100,
              clientY: axis === "y" ? 120 : 100,
            }),
          );
          const actual =
            axis === "y" ? scroller.scrollTop : scroller.scrollLeft;
          const expected = initial + (20 / (viewport - 6 - size)) * maxScroll;
          check(
            Math.abs(actual - expected) < 2,
            `${scale}/${width}: ${axis} drag must use viewport pointer units`,
          );
          thumb.dispatchEvent(
            new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }),
          );
          await settle();
        }
      }
    }
  } finally {
    root.unmount();
    scroller.remove();
    host.remove();
    document.documentElement.style.zoom = "";
  }
}
run()
  .catch((error) => failures.push(String(error)))
  .finally(() =>
    fetch("/result", { method: "POST", body: JSON.stringify(failures) }),
  );

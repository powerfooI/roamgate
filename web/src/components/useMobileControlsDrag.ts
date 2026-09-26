import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import {
  clampMobileControlsOffset,
  type MobileControlsPlacement,
  type MobileControlsStackBounds,
  mobileControlsSideForRelease,
} from "../mobileControlsPlacement";

/** The fixed elements that make up the floating mobile control stack. */
const STACK_SELECTOR =
  ".mobile-workspace-shortcut, .mobile-terminal-controls, .mobile-nav:not(.mobile-terminal-tools)";
/** Chrome along the top that the stack must not cover. */
const HEADER_SELECTOR = ".topbar, .main > .tabbar";
/** Controls pinned to the top right of the terminal, clear of a right-edge stack. */
const RIGHT_EDGE_SELECTOR = ".terminal-mobile-keys-toggle";
const DRAG_THRESHOLD_PX = 8;
const EDGE_GAP_PX = 8;
const SETTLE_MS = 220;

function stackElements(app: HTMLElement) {
  return Array.from(app.querySelectorAll<HTMLElement>(STACK_SELECTOR)).filter(
    (element) => getComputedStyle(element).display !== "none",
  );
}

let safeAreaProbe: HTMLDivElement | null = null;

/** CSS env() values are not readable from script; measure a fixed probe instead. */
function safeAreaBottom() {
  if (!safeAreaProbe) {
    safeAreaProbe = document.createElement("div");
    safeAreaProbe.setAttribute("aria-hidden", "true");
    safeAreaProbe.style.cssText =
      "position:fixed;left:0;bottom:0;width:0;height:env(safe-area-inset-bottom,0px);visibility:hidden;pointer-events:none";
    document.body.append(safeAreaProbe);
  }
  return safeAreaProbe.offsetHeight;
}

/**
 * Stack geometry in CSS pixels at `offsetY = 0`. Layout boxes come from the resolved
 * `bottom` so collapse/keyboard transforms and drag translation are ignored.
 */
function measureStackBounds(
  app: HTMLElement,
  appliedOffset: number,
  side: MobileControlsPlacement["side"],
): MobileControlsStackBounds | null {
  const elements = stackElements(app);
  if (elements.length === 0) return null;
  // Fixed children resolve against the transformed .app box.
  const appRect = app.getBoundingClientRect();
  const scale = appRect.width / app.offsetWidth;
  let top = Infinity;
  let bottom = -Infinity;
  for (const element of elements) {
    const elementBottom =
      appRect.bottom / scale -
      Number.parseFloat(getComputedStyle(element).bottom);
    if (!Number.isFinite(elementBottom)) continue;
    top = Math.min(top, elementBottom - element.offsetHeight);
    bottom = Math.max(bottom, elementBottom);
  }
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) return null;
  // Keep the header and the session tab strip (with its close buttons) clear.
  let headerBottom = 0;
  const selector =
    side === "right"
      ? `${HEADER_SELECTOR}, ${RIGHT_EDGE_SELECTOR}`
      : HEADER_SELECTOR;
  for (const header of app.querySelectorAll<HTMLElement>(selector)) {
    const rect = header.getBoundingClientRect();
    if (rect.height === 0 || getComputedStyle(header).display === "none")
      continue;
    headerBottom = Math.max(headerBottom, rect.bottom / scale);
  }
  return {
    top: top + appliedOffset,
    bottom: bottom + appliedOffset,
    minTop: headerBottom + EDGE_GAP_PX,
    maxBottom:
      Math.min(appRect.bottom, window.innerHeight) / scale -
      EDGE_GAP_PX -
      safeAreaBottom(),
  };
}

function reducedMotion() {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Drag the mobile controls toggle to move the whole floating stack. Release
 * snaps to the nearer side edge and keeps the dragged height. Returns the
 * offset to apply, which is re-clamped when the viewport changes while the
 * stored placement stays untouched.
 */
export function useMobileControlsDrag({
  enabled,
  appRef,
  toggleRef,
  placement,
  onPlacementChange,
}: {
  enabled: boolean;
  appRef: RefObject<HTMLElement | null>;
  toggleRef: RefObject<HTMLElement | null>;
  placement: MobileControlsPlacement;
  onPlacementChange: (placement: MobileControlsPlacement) => void;
}): number {
  const [appliedOffset, setAppliedOffset] = useState(placement.offsetY);
  const latest = useRef({ placement, appliedOffset, onPlacementChange });
  useLayoutEffect(() => {
    latest.current = { placement, appliedOffset, onPlacementChange };
  });
  const dragging = useRef(false);

  // Clamp the stored height against the current layout. The stored value is
  // kept, so returning to a taller viewport restores it.
  const reclamp = useRef(() => {});
  reclamp.current = () => {
    const app = appRef.current;
    if (!enabled || !app || dragging.current) return;
    if (document.documentElement.dataset.layout !== "mobile") return;
    const bounds = measureStackBounds(
      app,
      latest.current.appliedOffset,
      latest.current.placement.side,
    );
    if (!bounds) return;
    setAppliedOffset(
      clampMobileControlsOffset(latest.current.placement.offsetY, bounds),
    );
  };
  // After every commit: headers such as the tab strip mount after first paint.
  useLayoutEffect(() => reclamp.current());
  // The viewport height is applied outside React; observe the settled size.
  useEffect(() => {
    const app = appRef.current;
    if (!enabled || !app || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => reclamp.current());
    observer.observe(app);
    return () => observer.disconnect();
  }, [enabled, appRef]);

  useEffect(() => {
    const app = appRef.current;
    const toggle = toggleRef.current;
    if (!enabled || !app || !toggle) return;
    let animations: Animation[] = [];
    let dragged = false;
    let start: {
      x: number;
      y: number;
      scale: number;
      claimed: boolean;
      baseOffset: number;
      bounds: MobileControlsStackBounds | null;
    } | null = null;

    const clearDrag = () => {
      app.classList.remove("mobile-controls-dragging");
      app.style.removeProperty("--mobile-controls-drag-x");
      app.style.removeProperty("--mobile-controls-drag-y");
      dragging.current = false;
    };
    const offsetFor = (dy: number) =>
      start?.bounds
        ? clampMobileControlsOffset(start.baseOffset - dy, start.bounds)
        : (start?.baseOffset ?? 0);
    const begin = (x: number, y: number) => {
      dragged = false;
      if (document.documentElement.dataset.layout !== "mobile") return;
      start = {
        x,
        y,
        scale: app.getBoundingClientRect().width / app.offsetWidth,
        claimed: false,
        baseOffset: latest.current.appliedOffset,
        bounds: null,
      };
    };
    const move = (x: number, y: number) => {
      if (!start) return false;
      const dx = x - start.x;
      const dy = y - start.y;
      if (!start.claimed) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_THRESHOLD_PX)
          return false;
        start.claimed = true;
        dragged = true;
        dragging.current = true;
        for (const animation of animations) animation.cancel();
        animations = [];
        // Follow the finger past side-specific obstacles; release re-clamps.
        start.bounds = measureStackBounds(app, start.baseOffset, "left");
        app.classList.add("mobile-controls-dragging");
      }
      // Horizontal follows the finger; vertical stops at the clamp.
      app.style.setProperty(
        "--mobile-controls-drag-x",
        `${dx / start.scale}px`,
      );
      app.style.setProperty(
        "--mobile-controls-drag-y",
        `${start.baseOffset - offsetFor(dy / start.scale)}px`,
      );
      return true;
    };
    const finish = (x: number, y: number) => {
      const current = start;
      start = null;
      if (!current?.claimed) return;
      const side = mobileControlsSideForRelease(x, window.innerWidth);
      const bounds = measureStackBounds(app, current.baseOffset, side);
      const next: MobileControlsPlacement = {
        side,
        offsetY: bounds
          ? clampMobileControlsOffset(
              current.baseOffset - (y - current.y) / current.scale,
              bounds,
            )
          : current.baseOffset,
      };
      const elements = stackElements(app);
      const before = elements.map((element) => element.getBoundingClientRect());
      clearDrag();
      flushSync(() => {
        setAppliedOffset(next.offsetY);
        latest.current.onPlacementChange(next);
      });
      if (reducedMotion()) return;
      const scale = app.getBoundingClientRect().width / app.offsetWidth;
      animations = elements.map((element, index) => {
        const after = element.getBoundingClientRect();
        const from = before[index]!;
        return element.animate(
          [
            {
              translate: `${(from.left - after.left) / scale}px ${(from.top - after.top) / scale}px`,
            },
            { translate: "0px 0px" },
          ],
          { duration: SETTLE_MS, easing: "cubic-bezier(0.2, 0.9, 0.3, 1)" },
        );
      });
    };
    const cancel = () => {
      start = null;
      clearDrag();
    };

    const touchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return cancel();
      const touch = event.touches[0]!;
      begin(touch.clientX, touch.clientY);
    };
    const touchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) return cancel();
      const touch = event.touches[0]!;
      if (move(touch.clientX, touch.clientY) && event.cancelable)
        event.preventDefault();
    };
    const touchEnd = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      if (touch) finish(touch.clientX, touch.clientY);
      else cancel();
      // A drag must not turn into a tap on the toggle.
      if (dragged && event.cancelable) event.preventDefault();
    };
    const pointerDown = (event: PointerEvent) => {
      if (event.pointerType === "touch" || !event.isPrimary || event.button)
        return;
      begin(event.clientX, event.clientY);
      toggle.setPointerCapture(event.pointerId);
    };
    const pointerMove = (event: PointerEvent) => {
      if (event.pointerType !== "touch") move(event.clientX, event.clientY);
    };
    const pointerUp = (event: PointerEvent) => {
      if (event.pointerType !== "touch") finish(event.clientX, event.clientY);
    };
    const pointerCancel = (event: PointerEvent) => {
      if (event.pointerType !== "touch" && start) cancel();
    };
    const clickCapture = (event: MouseEvent) => {
      if (!dragged) return;
      dragged = false;
      event.preventDefault();
      event.stopPropagation();
    };

    toggle.addEventListener("touchstart", touchStart, { passive: true });
    toggle.addEventListener("touchmove", touchMove, { passive: false });
    toggle.addEventListener("touchend", touchEnd);
    toggle.addEventListener("touchcancel", cancel);
    toggle.addEventListener("pointerdown", pointerDown);
    toggle.addEventListener("pointermove", pointerMove);
    toggle.addEventListener("pointerup", pointerUp);
    toggle.addEventListener("pointercancel", pointerCancel);
    toggle.addEventListener("lostpointercapture", pointerCancel);
    toggle.addEventListener("click", clickCapture, true);
    return () => {
      for (const animation of animations) animation.cancel();
      cancel();
      toggle.removeEventListener("touchstart", touchStart);
      toggle.removeEventListener("touchmove", touchMove);
      toggle.removeEventListener("touchend", touchEnd);
      toggle.removeEventListener("touchcancel", cancel);
      toggle.removeEventListener("pointerdown", pointerDown);
      toggle.removeEventListener("pointermove", pointerMove);
      toggle.removeEventListener("pointerup", pointerUp);
      toggle.removeEventListener("pointercancel", pointerCancel);
      toggle.removeEventListener("lostpointercapture", pointerCancel);
      toggle.removeEventListener("click", clickCapture, true);
    };
  }, [enabled, appRef, toggleRef]);

  return appliedOffset;
}

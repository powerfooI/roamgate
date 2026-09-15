import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  calculateOverlayThumb,
  overlayScrollbarExcludedElement,
  type OverlayThumbGeometry,
} from "./overlayScrollbar";
import "./OverlayScrollbarLayer.css";

type Axis = "vertical" | "horizontal";

type ThumbLayout = OverlayThumbGeometry & {
  top: number;
  left: number;
  width: number;
  height: number;
};

type ScrollbarLayout = {
  vertical: ThumbLayout | null;
  horizontal: ThumbLayout | null;
};

type DragState = {
  axis: Axis;
  pointerId: number;
  pointerStart: number;
  scrollStart: number;
  maxScroll: number;
  travel: number;
  target: HTMLElement;
};

const THUMB_SIZE = 7;
const TRACK_INSET = 3;
const HIDE_DELAY_MS = 900;
const FADE_DURATION_MS = 160;

function hasScrollableOverflow(element: HTMLElement) {
  const style = window.getComputedStyle(element);
  const canScrollY = /^(auto|scroll|overlay)$/.test(style.overflowY);
  const canScrollX = /^(auto|scroll|overlay)$/.test(style.overflowX);
  return (
    (canScrollY && element.scrollHeight > element.clientHeight + 1) ||
    (canScrollX && element.scrollWidth > element.clientWidth + 1)
  );
}

function findScrollableElement(target: EventTarget | null) {
  let element = target instanceof HTMLElement ? target : null;
  if (element && overlayScrollbarExcludedElement(element)) return null;
  while (element && element !== document.documentElement) {
    if (hasScrollableOverflow(element)) return element;
    const xterm = element.closest(".xterm");
    const viewport = xterm?.querySelector<HTMLElement>(".xterm-viewport");
    if (viewport && hasScrollableOverflow(viewport)) return viewport;
    element = element.parentElement;
  }
  return null;
}

function measureScrollbars(
  target: HTMLElement,
  layer: HTMLElement,
): ScrollbarLayout | null {
  if (!target.isConnected) return null;
  const rect = target.getBoundingClientRect();
  const layerRect = layer.getBoundingClientRect();
  if (
    !layer.offsetWidth ||
    !layer.offsetHeight ||
    !layerRect.width ||
    !layerRect.height
  )
    return null;
  // Rects and pointer events share viewport units; positioned CSS lengths
  // use the layer's local units. Measure the ratio so root CSS zoom is not
  // applied twice, including engines with different zoom/rect behavior.
  const scaleX = layerRect.width / layer.offsetWidth;
  const scaleY = layerRect.height / layer.offsetHeight;
  const top = Math.max(layerRect.top, rect.top);
  const right = Math.min(layerRect.right, rect.right);
  const bottom = Math.min(layerRect.bottom, rect.bottom);
  const left = Math.max(layerRect.left, rect.left);
  const visibleWidth = Math.max(0, right - left);
  const visibleHeight = Math.max(0, bottom - top);

  const verticalGeometry = calculateOverlayThumb({
    viewportStart: top,
    viewportSize: visibleHeight,
    clientSize: target.clientHeight,
    scrollSize: target.scrollHeight,
    scrollOffset: target.scrollTop,
    inset: TRACK_INSET,
  });
  const horizontalGeometry = calculateOverlayThumb({
    viewportStart: left,
    viewportSize: visibleWidth,
    clientSize: target.clientWidth,
    scrollSize: target.scrollWidth,
    scrollOffset: target.scrollLeft,
    inset: TRACK_INSET,
  });

  const vertical = verticalGeometry
    ? {
        ...verticalGeometry,
        top: (verticalGeometry.start - layerRect.top) / scaleY,
        left: (right - TRACK_INSET - THUMB_SIZE - layerRect.left) / scaleX,
        width: THUMB_SIZE / scaleX,
        height: verticalGeometry.size / scaleY,
      }
    : null;
  const horizontal = horizontalGeometry
    ? {
        ...horizontalGeometry,
        top: (bottom - TRACK_INSET - THUMB_SIZE - layerRect.top) / scaleY,
        left: (horizontalGeometry.start - layerRect.left) / scaleX,
        width: horizontalGeometry.size / scaleX,
        height: THUMB_SIZE / scaleY,
      }
    : null;

  return vertical || horizontal ? { vertical, horizontal } : null;
}

function sameThumb(a: ThumbLayout | null, b: ThumbLayout | null) {
  if (!a || !b) return a === b;
  return (
    a.top === b.top &&
    a.left === b.left &&
    a.width === b.width &&
    a.height === b.height &&
    a.trackLength === b.trackLength &&
    a.maxScroll === b.maxScroll
  );
}

function sameLayout(a: ScrollbarLayout | null, b: ScrollbarLayout | null) {
  return (
    a === b ||
    (!!a &&
      !!b &&
      sameThumb(a.vertical, b.vertical) &&
      sameThumb(a.horizontal, b.horizontal))
  );
}

export function OverlayScrollbarLayer() {
  const [layout, setLayout] = useState<ScrollbarLayout | null>(null);
  const [visible, setVisible] = useState(false);
  const layerRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const refreshRef = useRef<(target: HTMLElement) => void>(() => undefined);
  const hideTimerRef = useRef<number | null>(null);
  const clearTimerRef = useRef<number | null>(null);

  const clearHideTimers = useCallback(() => {
    if (hideTimerRef.current !== null)
      window.clearTimeout(hideTimerRef.current);
    if (clearTimerRef.current !== null)
      window.clearTimeout(clearTimerRef.current);
    hideTimerRef.current = null;
    clearTimerRef.current = null;
  }, []);

  const scheduleHide = useCallback(() => {
    clearHideTimers();
    hideTimerRef.current = window.setTimeout(() => {
      if (dragRef.current) return;
      setVisible(false);
      clearTimerRef.current = window.setTimeout(() => {
        if (!dragRef.current) setLayout(null);
      }, FADE_DURATION_MS);
    }, HIDE_DELAY_MS);
  }, [clearHideTimers]);

  useEffect(() => {
    let frame = 0;
    let pendingTarget: HTMLElement | null = null;

    // Coalesce scroll and pointer events so geometry is measured at most once per frame.
    const refresh = (target: HTMLElement) => {
      pendingTarget = target;
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const nextTarget = pendingTarget;
        pendingTarget = null;
        if (!nextTarget || !layerRef.current) return;
        const nextLayout = measureScrollbars(nextTarget, layerRef.current);
        targetRef.current = nextTarget;
        setLayout((current) =>
          sameLayout(current, nextLayout) ? current : nextLayout,
        );
        setVisible(Boolean(nextLayout));
        if (nextLayout) scheduleHide();
      });
    };
    refreshRef.current = refresh;

    const onScroll = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (overlayScrollbarExcludedElement(target)) {
        if (
          targetRef.current &&
          overlayScrollbarExcludedElement(targetRef.current)
        ) {
          targetRef.current = null;
          setVisible(false);
          setLayout(null);
        }
        return;
      }
      if (hasScrollableOverflow(target)) refresh(target);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (dragRef.current) return;
      const eventTarget =
        event.target instanceof HTMLElement ? event.target : null;
      const activeTarget = targetRef.current;
      if (eventTarget && activeTarget) {
        const xtermViewport = eventTarget
          .closest(".xterm")
          ?.querySelector<HTMLElement>(".xterm-viewport");
        if (
          activeTarget.contains(eventTarget) ||
          activeTarget === xtermViewport
        ) {
          refresh(activeTarget);
          return;
        }
      }
      const target = findScrollableElement(event.target);
      if (target) refresh(target);
    };
    const onWheel = (event: WheelEvent) => {
      const target = findScrollableElement(event.target);
      if (target) refresh(target);
    };
    const onResize = () => {
      if (targetRef.current) refresh(targetRef.current);
    };

    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("wheel", onWheel, {
      capture: true,
      passive: true,
    });
    window.addEventListener("resize", onResize);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      clearHideTimers();
      refreshRef.current = () => undefined;
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("resize", onResize);
    };
  }, [clearHideTimers, scheduleHide]);

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>, axis: Axis) => {
    const target = targetRef.current;
    const thumb = axis === "vertical" ? layout?.vertical : layout?.horizontal;
    if (!target || !thumb) return;
    event.preventDefault();
    event.stopPropagation();
    clearHideTimers();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      axis,
      pointerId: event.pointerId,
      pointerStart: axis === "vertical" ? event.clientY : event.clientX,
      scrollStart: axis === "vertical" ? target.scrollTop : target.scrollLeft,
      maxScroll: thumb.maxScroll,
      travel: Math.max(1, thumb.trackLength - thumb.size),
      target,
    };
    setVisible(true);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const pointer = drag.axis === "vertical" ? event.clientY : event.clientX;
    const nextScroll =
      drag.scrollStart +
      ((pointer - drag.pointerStart) / drag.travel) * drag.maxScroll;
    if (drag.axis === "vertical") drag.target.scrollTop = nextScroll;
    else drag.target.scrollLeft = nextScroll;
    refreshRef.current(drag.target);
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!event.currentTarget.matches(":hover")) scheduleHide();
  };

  const thumbStyle = (thumb: ThumbLayout): CSSProperties => ({
    top: thumb.top,
    left: thumb.left,
    width: thumb.width,
    height: thumb.height,
  });

  return (
    <div
      ref={layerRef}
      className={`overlay-scrollbar-layer ${visible ? "is-visible" : ""}`}
    >
      {layout?.vertical ? (
        <div
          className="overlay-scrollbar-thumb is-vertical"
          data-testid="overlay-scrollbar-vertical"
          style={thumbStyle(layout.vertical)}
          aria-hidden="true"
          onPointerEnter={clearHideTimers}
          onPointerLeave={scheduleHide}
          onPointerDown={(event) => beginDrag(event, "vertical")}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
      ) : null}
      {layout?.horizontal ? (
        <div
          className="overlay-scrollbar-thumb is-horizontal"
          data-testid="overlay-scrollbar-horizontal"
          style={thumbStyle(layout.horizontal)}
          aria-hidden="true"
          onPointerEnter={clearHideTimers}
          onPointerLeave={scheduleHide}
          onPointerDown={(event) => beginDrag(event, "horizontal")}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
      ) : null}
    </div>
  );
}

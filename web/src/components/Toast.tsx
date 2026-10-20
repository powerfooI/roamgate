import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useLayoutEffect,
  useRef,
} from "react";
import { isMobileLayout } from "../layoutPreferences";

type ToastProps = {
  className: string;
  role: "status" | "alert";
  onDismiss: () => void;
  /** Identifies the displayed notification; changes cancel in-flight swipes. */
  notificationKey: string | number | undefined;
  dismissDisabled?: boolean;
  children: ReactNode;
};

type SwipeState = {
  pointerId: number;
  startX: number;
  startY: number;
  startTime: number;
  offset: number;
  swiping: boolean;
};

const SWIPE_SLOP_PX = 6;
const SWIPE_DISMISS_PX = 36;
const SWIPE_DISMISS_VELOCITY = 0.45;
const SWIPE_EXIT_MS = 180;

// Touch-only swipe-up dismissal in the mobile layout, matching native
// notification banners. Desktop layouts, mouse, and pen keep the explicit
// close button.
export function Toast({
  className,
  role,
  onDismiss,
  notificationKey,
  dismissDisabled = false,
  children,
}: ToastProps) {
  const ref = useRef<HTMLDivElement>(null);
  const swipeRef = useRef<SwipeState | null>(null);
  const exitTimerRef = useRef<number | null>(null);

  // A replacement notification reuses this element. Abandon gestures and
  // exits that began on the previous one before the new one paints, so they
  // cannot dismiss it; this also cancels a pending exit on unmount.
  useLayoutEffect(() => {
    const el = ref.current;
    return () => {
      swipeRef.current = null;
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
      el?.classList.remove("toast-swiping");
      el?.style.removeProperty("transform");
      el?.style.removeProperty("opacity");
    };
  }, [notificationKey]);

  const setOffset = (offset: number, swiping: boolean) => {
    const el = ref.current;
    if (!el) return;
    el.classList.toggle("toast-swiping", swiping);
    if (offset === 0) {
      el.style.removeProperty("transform");
      el.style.removeProperty("opacity");
      return;
    }
    el.style.transform = `translate3d(0, ${offset}px, 0)`;
    el.style.opacity = String(Math.max(0, 1 + Math.min(0, offset) / 140));
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      event.pointerType !== "touch" ||
      swipeRef.current ||
      exitTimerRef.current !== null ||
      !isMobileLayout()
    )
      return;
    // Buttons keep their taps; scrollable output keeps its native pan.
    if ((event.target as Element).closest("button, .toast-output pre")) return;
    swipeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startTime: event.timeStamp,
      offset: 0,
      swiping: false,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const swipe = swipeRef.current;
    if (!swipe || swipe.pointerId !== event.pointerId) return;
    const dx = event.clientX - swipe.startX;
    const dy = event.clientY - swipe.startY;
    if (!swipe.swiping) {
      if (Math.abs(dx) < SWIPE_SLOP_PX && Math.abs(dy) < SWIPE_SLOP_PX) return;
      if (Math.abs(dx) > Math.abs(dy)) {
        swipeRef.current = null;
        return;
      }
      swipe.swiping = true;
      // A running entry animation overrides the inline transform, so jump it
      // to its end state; finishing (unlike removing it) never replays it.
      for (const animation of ref.current?.getAnimations() ?? [])
        animation.finish();
    }
    // Follow upward drags; resist downward or blocked ones like a rubber band.
    swipe.offset = dy < 0 && !dismissDisabled ? dy : dy / 5;
    setOffset(swipe.offset, true);
  };

  const finishSwipe = (event: ReactPointerEvent<HTMLDivElement>) => {
    const swipe = swipeRef.current;
    if (!swipe || swipe.pointerId !== event.pointerId) return;
    swipeRef.current = null;
    if (!swipe.swiping) return;
    const elapsed = Math.max(1, event.timeStamp - swipe.startTime);
    const velocity = swipe.offset / elapsed;
    const dismiss =
      event.type === "pointerup" &&
      !dismissDisabled &&
      (swipe.offset <= -SWIPE_DISMISS_PX ||
        (swipe.offset < -SWIPE_SLOP_PX && velocity <= -SWIPE_DISMISS_VELOCITY));
    if (!dismiss) {
      setOffset(0, false);
      return;
    }
    const el = ref.current;
    const exit = -((el?.offsetHeight ?? 120) + (el?.offsetTop ?? 0) + 24);
    setOffset(exit, false);
    exitTimerRef.current = window.setTimeout(() => {
      exitTimerRef.current = null;
      onDismiss();
      setOffset(0, false);
    }, SWIPE_EXIT_MS);
  };

  return (
    <div
      ref={ref}
      className={className}
      role={role}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishSwipe}
      onPointerCancel={finishSwipe}
    >
      {children}
      <span className="toast-grabber" aria-hidden="true" />
    </div>
  );
}

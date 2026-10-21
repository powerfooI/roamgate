import {
  useCallback,
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

/**
 * Touch release fallback for composer submit buttons. Native focus transfer
 * can close the soft keyboard and move a bottom-anchored button before click;
 * cancelling pointerdown protects focus but some WebKit versions then omit
 * click. A short, still, single-finger touch therefore submits on release,
 * never on down, and the later compatibility click is consumed even if the
 * request has already completed (or failed and restored the draft). Mouse and
 * pen keep the plain click path.
 *
 * One instance is shared by all submit buttons of a composer, so a touch
 * retargeted to a sibling button by layout is still consumed. `resetKey`
 * changes invalidate a pending touch, even an away-and-back transition.
 */
export function useTouchReleaseSubmit({
  submitKey,
  resetKey,
  canStart,
  canFinish,
}: {
  // Identity of the draft being submitted; a touch must end on the same one.
  submitKey: string;
  resetKey: string;
  // Checked on touch down, beyond the button's own disabled state.
  canStart: () => boolean;
  // Checked on touch release, beyond the button's own disabled state.
  canFinish: () => boolean;
}) {
  const submitTouchRef = useRef<{
    id: number;
    button: HTMLButtonElement;
    key: string;
    x: number;
    y: number;
    bounds: DOMRect;
    time: number;
    cancelled: boolean;
  } | null>(null);
  const submitClickTouchRef = useRef<{
    id: number;
    button: HTMLButtonElement;
    x: number;
    y: number;
  } | null>(null);
  useEffect(() => {
    const cancelAdditionalPointer = (event: PointerEvent) => {
      const touch = submitTouchRef.current;
      if (touch && event.pointerId !== touch.id) touch.cancelled = true;
    };
    document.addEventListener("pointerdown", cancelAdditionalPointer, true);
    return () =>
      document.removeEventListener(
        "pointerdown",
        cancelAdditionalPointer,
        true,
      );
  }, []);
  useEffect(() => {
    void resetKey;
    submitTouchRef.current = null;
  }, [resetKey]);

  // Stable: it only touches refs, so effects can depend on it.
  const cancel = useCallback(() => {
    if (submitTouchRef.current) submitTouchRef.current.cancelled = true;
  }, []);
  const pointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType !== "touch") {
      submitTouchRef.current = null;
      submitClickTouchRef.current = null;
      return;
    }
    event.preventDefault();
    // A second finger cannot replace the first press with a fresh tap.
    if (!event.isPrimary) {
      cancel();
      return;
    }
    submitTouchRef.current = null;
    submitClickTouchRef.current = {
      id: event.pointerId,
      button: event.currentTarget,
      x: event.clientX,
      y: event.clientY,
    };
    // Do not focus the textarea: a keyboard dismissed by Back stays dismissed.
    if (event.currentTarget.disabled || !canStart()) return;
    submitTouchRef.current = {
      id: event.pointerId,
      button: event.currentTarget,
      key: submitKey,
      x: event.clientX,
      y: event.clientY,
      bounds: event.currentTarget.getBoundingClientRect(),
      time: event.timeStamp,
      cancelled: false,
    };
  };
  const pointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const touch = submitTouchRef.current;
    if (!touch || touch.id !== event.pointerId) return;
    const { left, right, top, bottom } = touch.bounds;
    // Latch cancellation: moving out and back is not a completed tap. Use the
    // press-time bounds so a viewport resize alone is not mistaken for a drag.
    if (
      Math.hypot(event.clientX - touch.x, event.clientY - touch.y) > 10 ||
      event.clientX < left ||
      event.clientX > right ||
      event.clientY < top ||
      event.clientY > bottom
    )
      touch.cancelled = true;
  };
  const pointerUp = (
    event: ReactPointerEvent<HTMLButtonElement>,
    submit: () => void,
  ) => {
    const touch = submitTouchRef.current;
    if (!touch || touch.id !== event.pointerId) return;
    pointerMove(event);
    if (submitClickTouchRef.current) {
      submitClickTouchRef.current.x = event.clientX;
      submitClickTouchRef.current.y = event.clientY;
    }
    submitTouchRef.current = null;
    if (
      touch.cancelled ||
      event.timeStamp - touch.time >= 500 ||
      touch.button !== event.currentTarget ||
      touch.key !== submitKey ||
      event.currentTarget.disabled ||
      !canFinish()
    )
      return;
    submit();
  };
  const click = (
    event: ReactMouseEvent<HTMLButtonElement>,
    submit: () => void,
  ) => {
    const touch = submitClickTouchRef.current;
    const native = event.nativeEvent;
    // Modern touch clicks carry their pointer identity. Older WebKit emits a
    // MouseEvent instead; match its button and coordinates. A known touch ID
    // is consumed even if layout retargets click to the other submit button.
    // A fresh mouse/pen pointerdown clears the association.
    const duplicate =
      touch &&
      (("pointerType" in native &&
        native.pointerType === "touch" &&
        "pointerId" in native &&
        native.pointerId === touch.id) ||
        (!("pointerType" in native) &&
          touch.button === event.currentTarget &&
          event.detail > 0 &&
          Math.hypot(event.clientX - touch.x, event.clientY - touch.y) < 1));
    if (duplicate) {
      event.preventDefault();
      return;
    }
    submit();
  };

  /** Pointer and click props for one submit button running `submit`. */
  const buttonProps = (submit: () => void) => ({
    onPointerDown: pointerDown,
    onPointerMove: pointerMove,
    onPointerCancel: cancel,
    onLostPointerCapture: cancel,
    onContextMenu: cancel,
    onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) =>
      pointerUp(event, submit),
    onClick: (event: ReactMouseEvent<HTMLButtonElement>) =>
      click(event, submit),
  });

  return { cancel, buttonProps };
}

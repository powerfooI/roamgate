import { useEffect, useRef, useState } from "react";
import "./GlobalTooltip.css";

type TooltipPlacement = "top" | "bottom";

type TooltipState = {
  text: string;
  left: number;
  top: number;
  placement: TooltipPlacement;
};

const TOOLTIP_DELAY_MS = 260;
const VIEWPORT_PADDING = 12;
const MAX_TOOLTIP_WIDTH = 360;
const MIN_TOOLTIP_WIDTH = 44;

function tooltipTarget(start: EventTarget | null): HTMLElement | null {
  if (!(start instanceof Element)) return null;
  const target = start.closest<HTMLElement>("[title]");
  const title = target?.getAttribute("title")?.trim();
  return title ? target : null;
}

// matches() throws a SyntaxError for :focus-visible on browsers without the
// pseudo-class (e.g. Safari < 15.4); this runs inside a document-level focus
// listener, so translate that failure into "not keyboard focus" and skip the
// focus tooltip instead of throwing on every focus event.
function matchesFocusVisible(target: HTMLElement) {
  try {
    return target.matches(":focus-visible");
  } catch {
    return false;
  }
}

function estimatedTooltipWidth(text: string) {
  return Math.min(
    MAX_TOOLTIP_WIDTH,
    Math.max(MIN_TOOLTIP_WIDTH, text.length * 7 + 22),
  );
}

function tooltipPosition(element: HTMLElement, text: string) {
  const rect = element.getBoundingClientRect();
  const center = rect.left + rect.width / 2;
  const halfWidth = Math.min(
    estimatedTooltipWidth(text) / 2,
    Math.max(0, (window.innerWidth - VIEWPORT_PADDING * 2) / 2),
  );
  const left = Math.min(
    Math.max(center, VIEWPORT_PADDING + halfWidth),
    window.innerWidth - VIEWPORT_PADDING - halfWidth,
  );
  const placement: TooltipPlacement = rect.top > 52 ? "top" : "bottom";
  return {
    left,
    top: placement === "top" ? rect.top - 9 : rect.bottom + 9,
    placement,
  };
}

export function GlobalTooltip() {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const activeElementRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current === null) return;
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };

    const restoreTitle = (element: HTMLElement | null) => {
      if (!element) return;
      const title = element.dataset.herdrTooltipTitle;
      if (title === undefined) return;
      element.setAttribute("title", title);
      delete element.dataset.herdrTooltipTitle;
    };

    const hide = () => {
      clearTimer();
      restoreTitle(activeElementRef.current);
      activeElementRef.current = null;
      setTooltip(null);
    };

    const dispose = () => {
      clearTimer();
      restoreTitle(activeElementRef.current);
      activeElementRef.current = null;
    };

    const showFor = (element: HTMLElement) => {
      if (activeElementRef.current === element) return;
      hide();
      const text = element.getAttribute("title")?.trim();
      if (!text) return;
      activeElementRef.current = element;
      element.dataset.herdrTooltipTitle = text;
      element.removeAttribute("title");
      timerRef.current = window.setTimeout(() => {
        if (activeElementRef.current !== element) return;
        setTooltip({
          text,
          ...tooltipPosition(element, text),
        });
      }, TOOLTIP_DELAY_MS);
    };

    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const target = tooltipTarget(event.target);
      if (target) showFor(target);
    };
    const onPointerOut = (event: PointerEvent) => {
      const active = activeElementRef.current;
      if (!active) return;
      const related = event.relatedTarget;
      if (related instanceof Node && active.contains(related)) return;
      hide();
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = tooltipTarget(event.target);
      // Only keyboard-driven focus deserves a tooltip. Touch taps also focus
      // buttons on some mobile browsers, and a tooltip shown then lingers
      // until the next tap blurs the button. Browsers exclude exactly that
      // case from :focus-visible while keeping keyboard navigation focused.
      if (!target || !matchesFocusVisible(target)) return;
      showFor(target);
    };
    const onFocusOut = () => hide();
    const onPointerDown = () => hide();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };

    document.addEventListener("pointerover", onPointerOver, true);
    document.addEventListener("pointerout", onPointerOut, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.removeEventListener("pointerover", onPointerOver, true);
      document.removeEventListener("pointerout", onPointerOut, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("keydown", onKeyDown, true);
      dispose();
    };
  }, []);

  if (!tooltip) return null;

  return (
    <div
      className={`global-tooltip global-tooltip-${tooltip.placement}`}
      style={{ left: tooltip.left, top: tooltip.top }}
      role="tooltip"
    >
      {tooltip.text}
    </div>
  );
}

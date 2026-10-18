import { useEffect, useRef, useState } from "react";
import {
  tabRevealScrollLeft,
  tabStripOverflow,
  tabStripWheelScrollLeft,
} from "../tabStripScroll";

type Overflow = ReturnType<typeof tabStripOverflow>;

const NO_OVERFLOW: Overflow = { start: false, end: false };

/**
 * Makes horizontal tab strip overflow discoverable with hidden scrollbars:
 * reports which edges hide tabs (for edge fades), lets a plain mouse wheel
 * scroll the strip, and scrolls the active tab into view when it changes.
 */
export function useTabStripScroll({
  activeTabId,
  tabsKey,
}: {
  activeTabId: string | undefined;
  /** Changes whenever the set of rendered tabs changes. */
  tabsKey: string;
}) {
  // State rather than a ref so effects follow the strip mounting and unmounting.
  const [strip, setStrip] = useState<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState<Overflow>(NO_OVERFLOW);
  const revealed = useRef<{ strip: HTMLElement; tabId: string } | null>(null);

  useEffect(() => {
    if (!strip) {
      setOverflow(NO_OVERFLOW);
      return;
    }
    const update = () => {
      const next = tabStripOverflow(strip);
      setOverflow((current) =>
        current.start === next.start && current.end === next.end
          ? current
          : next,
      );
    };
    // Tabs resize on rename and agent status changes without resizing the strip.
    const observer = new ResizeObserver(update);
    observer.observe(strip);
    for (const child of strip.children) observer.observe(child);
    strip.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      observer.disconnect();
      strip.removeEventListener("scroll", update);
    };
  }, [strip, tabsKey]);

  useEffect(() => {
    if (!strip) return;
    const onWheel = (event: WheelEvent) => {
      // Reorder drag measures tab positions once; keep them valid.
      if (strip.classList.contains("is-reordering")) return;
      const next = tabStripWheelScrollLeft(strip, event);
      if (next === null) return;
      event.preventDefault();
      strip.scrollLeft = next;
    };
    strip.addEventListener("wheel", onWheel, { passive: false });
    return () => strip.removeEventListener("wheel", onWheel);
  }, [strip]);

  // Reveal each newly active tab once, retrying until its element renders, so
  // tabs appearing elsewhere do not undo the user's own scrolling.
  useEffect(() => {
    if (!strip || !activeTabId) return;
    const last = revealed.current;
    if (last?.strip === strip && last.tabId === activeTabId) return;
    const tab = Array.from(strip.children).find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child.dataset.tabId === activeTabId,
    );
    if (!tab) return;
    // Offsets ignore drag transforms and stay in CSS pixels under UI zoom.
    const next = tabRevealScrollLeft(strip, {
      left: tab.offsetLeft,
      width: tab.offsetWidth,
    });
    const firstReveal = last?.strip !== strip;
    revealed.current = { strip, tabId: activeTabId };
    if (next === null) return;
    const smooth =
      !firstReveal &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    strip.scrollTo({ left: next, behavior: smooth ? "smooth" : "auto" });
  }, [strip, activeTabId, tabsKey]);

  return { ref: setStrip, overflow };
}

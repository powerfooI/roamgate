import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { prefersReducedMotion } from "../utils";
import "./ConversationMinimap.css";

export type ConversationMinimapEntry = {
  id: string;
  role: "user" | "assistant" | "tool";
  label: string;
  text: string;
};

type VisibleRange = { start: number; end: number };

// At or below this conversation width a side rail would crowd the messages,
// so an auto-oriented map lies flat under them instead.
const RAIL_MAX_HORIZONTAL_WIDTH = 600;
const PAN_THRESHOLD_PX = 6;

// Marks never preview while the track reads this index (see the CSS).
const NO_PREVIEW_INDEX = -1000;

function previewText(text: string, emptyText: string) {
  return text.trim().replace(/\s+/g, " ").slice(0, 160) || emptyText;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

// Marks fill the track uniformly with no gaps or main-axis padding, so a
// position along the track maps to an entry index from its geometry alone,
// whether or not the marks overflow and the track scrolls.
function trackGeometry(track: HTMLElement, horizontal: boolean, count: number) {
  const rect = track.getBoundingClientRect();
  const rectStart = horizontal ? rect.left : rect.top;
  const rectLength = horizontal ? rect.width : rect.height;
  const clientLength =
    (horizontal ? track.clientWidth : track.clientHeight) || rectLength;
  const scrollLength = Math.max(
    clientLength,
    horizontal ? track.scrollWidth : track.scrollHeight,
  );
  return {
    rectStart,
    rectLength,
    clientLength,
    scrollLength,
    scroll: horizontal ? track.scrollLeft : track.scrollTop,
    stride: scrollLength / Math.max(1, count),
  };
}

// Track which entries the conversation viewport contains. Entry elements are
// children of itemsRef carrying a 1-based data-sequence that matches their
// minimap position; other children (such as tool blocks) are skipped.
// Geometry-based instead of IntersectionObserver: it updates every scroll
// frame and does not depend on observer delivery timing, which mobile
// browsers throttle aggressively during momentum scrolling.
function useVisibleRange(
  scrollerRef: RefObject<HTMLElement | null>,
  itemsRef: RefObject<HTMLElement | null>,
  entriesKey: string,
) {
  const [range, setRange] = useState<VisibleRange | null>(null);

  useEffect(() => {
    const root = scrollerRef.current;
    const items = itemsRef.current;
    if (!root || !items) return;
    const publish = (next: VisibleRange | null) =>
      setRange((current) =>
        current?.start === next?.start && current?.end === next?.end
          ? current
          : next,
      );
    let frame = 0;
    const measure = () => {
      frame = 0;
      const rootRect = root.getBoundingClientRect();
      // A hidden conversation (e.g. the inspector showing another view) has
      // an empty rect; skip the scan so background scrolls stay O(1) here.
      if (rootRect.width === 0 || rootRect.height === 0) {
        publish(null);
        return;
      }
      // Clip the viewport to the screen as well: if an ancestor ends up being
      // the scroller (mobile viewport quirks), the root's rect spans every
      // entry and would mark all of them in view.
      const viewTop = Math.max(rootRect.top, 0);
      const viewBottom = Math.min(rootRect.bottom, window.innerHeight);
      const children = items.children;
      const count = children.length;
      // Seed the scan near the expected first visible entry (scroll fraction
      // x count), then back up to the true boundary, so the walk is bounded
      // by the estimation error instead of the full conversation.
      let first = 0;
      if (count > 0 && root.scrollHeight > 0) {
        const scrollViewTop = root.scrollTop + (viewTop - rootRect.top);
        first = clamp(
          Math.floor((scrollViewTop / root.scrollHeight) * count),
          0,
          count - 1,
        );
        while (
          first > 0 &&
          children[first - 1].getBoundingClientRect().bottom > viewTop
        )
          first--;
      }
      let start = Infinity;
      let end = -Infinity;
      for (let i = first; i < count; i++) {
        const child = children[i] as HTMLElement;
        const rect = child.getBoundingClientRect();
        // Entries stack in DOM order, so once one starts below the viewport
        // every later one does too.
        if (rect.top >= viewBottom) break;
        if (rect.bottom <= viewTop) continue;
        const sequence = Number(child.dataset.sequence);
        if (!Number.isInteger(sequence) || sequence < 1) continue;
        start = Math.min(start, sequence - 1);
        end = Math.max(end, sequence - 1);
      }
      publish(start <= end ? { start, end } : null);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    // Streaming text and expanded blocks resize entries without changing the
    // fixed-height viewport, so watch the entries themselves too.
    const observer = new window.ResizeObserver(schedule);
    observer.observe(root);
    if (items !== root) observer.observe(items);
    for (const child of Array.from(items.children)) observer.observe(child);
    // Scroll events do not bubble; a capture listener on window also covers
    // an ancestor that ends up scrolling instead of the root.
    const onAncestorScroll = (event: Event) => {
      const target = event.target;
      if (
        target === document ||
        (target instanceof Node && target !== root && target.contains(root))
      )
        schedule();
    };
    root.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("scroll", onAncestorScroll, {
      passive: true,
      capture: true,
    });
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      observer.disconnect();
      root.removeEventListener("scroll", schedule);
      window.removeEventListener("scroll", onAncestorScroll, true);
      window.removeEventListener("resize", schedule);
      window.cancelAnimationFrame(frame);
    };
  }, [scrollerRef, itemsRef, entriesKey]);

  return range;
}

// A slider-like overview of a conversation. "auto" shows a side rail that
// lies flat under narrow conversations; the host positions the rail. With
// more entries than fit, the track scrolls along its axis and follows the
// viewport.
export const ConversationMinimap = memo(function ConversationMinimap({
  entries,
  scrollerRef,
  itemsRef,
  orientation = "auto",
  label,
  className = "",
  emptyText = "No text yet",
  onSelect,
  onLayout,
}: {
  entries: ConversationMinimapEntry[];
  scrollerRef: RefObject<HTMLElement | null>;
  itemsRef: RefObject<HTMLElement | null>;
  orientation?: "auto" | "horizontal";
  label: string;
  className?: string;
  // Previews entries without text with this placeholder.
  emptyText?: string;
  // Receives the index of the chosen entry; the host owns the jump.
  onSelect: (index: number) => void;
  // Runs after the map lays out, including orientation switches.
  onLayout?: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [horizontal, setHorizontal] = useState(orientation === "horizontal");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  // From press to release the track must not move under the pointer, so a
  // tap selects the mark that was actually pressed.
  const pressRef = useRef<{
    pointerId: number;
    origin: number;
    scroll: number;
  } | null>(null);
  const pannedRef = useRef(false);
  const count = entries.length;
  const empty = count === 0;
  // Streaming changes entry text on every update; marks and tracking only
  // depend on which entries exist and their roles.
  const structureKey = useMemo(
    () => entries.map((entry) => `${entry.role}:${entry.id}`).join("\n"),
    [entries],
  );
  const visible = useVisibleRange(scrollerRef, itemsRef, structureKey);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    if (orientation === "horizontal") {
      setHorizontal(true);
      return;
    }
    const parent = rootRef.current?.parentElement;
    if (!parent) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      setHorizontal(parent.clientWidth <= RAIL_MAX_HORIZONTAL_WIDTH);
    };
    const observer = new window.ResizeObserver(() => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    });
    observer.observe(parent);
    frame = window.requestAnimationFrame(measure);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [empty, orientation]);

  useLayoutEffect(() => onLayout?.(), [horizontal, onLayout]);

  const currentIndex = visible ? Math.min(visible.start, count - 1) : 0;
  const hoveredIndex = entries.findIndex((entry) => entry.id === hoveredId);
  const previewIndex =
    hoveredIndex >= 0 ? hoveredIndex : keyboardFocus ? currentIndex : -1;
  const preview = entries[previewIndex];

  // Only the side rail follows the hovered mark; the flat strip centers its
  // preview over the map.
  const positionPreview = useCallback(() => {
    const track = trackRef.current;
    const tooltip = previewRef.current;
    if (!track || !tooltip || previewIndex < 0) return;
    if (horizontal) {
      tooltip.style.removeProperty("--preview-position");
      return;
    }
    const geometry = trackGeometry(track, horizontal, count);
    const position =
      ((previewIndex + 0.5) * geometry.stride - geometry.scroll) /
      Math.max(1, geometry.clientLength);
    tooltip.style.setProperty(
      "--preview-position",
      `${clamp(position, 0, 1) * 100}%`,
    );
  }, [count, horizontal, previewIndex]);

  useLayoutEffect(positionPreview, [positionPreview]);
  const positionPreviewRef = useRef(positionPreview);
  positionPreviewRef.current = positionPreview;

  // The thumb stands in for the track's hidden scrollbar while it overflows.
  const syncThumb = useCallback(() => {
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!track || !thumb) return;
    const geometry = trackGeometry(track, horizontal, count);
    const max = geometry.scrollLength - geometry.clientLength;
    if (max <= 1) {
      thumb.style.display = "none";
      return;
    }
    const size = clamp(
      (geometry.clientLength / geometry.scrollLength) * geometry.clientLength,
      Math.min(12, geometry.clientLength),
      geometry.clientLength,
    );
    thumb.style.display = "block";
    thumb.style.setProperty("--thumb-size", `${size}px`);
    thumb.style.setProperty(
      "--thumb-offset",
      `${(geometry.scroll / max) * (geometry.clientLength - size)}px`,
    );
  }, [count, horizontal]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const onScroll = () => {
      syncThumb();
      if (!horizontal) positionPreviewRef.current();
    };
    syncThumb();
    track.addEventListener("scroll", onScroll, { passive: true });
    const observer = new window.ResizeObserver(syncThumb);
    observer.observe(track);
    return () => {
      track.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [horizontal, syncThumb]);

  // Keep the in-view marks inside an overflowing track. Glide only when they
  // actually leave it, so scrolling the conversation does not restart a
  // smooth scroll every frame.
  const followVisible = useCallback(() => {
    const track = trackRef.current;
    const visible = visibleRef.current;
    if (!track || !visible || pressRef.current) return;
    const geometry = trackGeometry(track, horizontal, count);
    const max = geometry.scrollLength - geometry.clientLength;
    if (max <= 1) return;
    const from = visible.start * geometry.stride;
    const to = (visible.end + 1) * geometry.stride;
    const fits = to - from <= geometry.clientLength;
    const end = geometry.scroll + geometry.clientLength;
    if (from >= geometry.scroll && (fits ? to <= end : from < end)) return;
    const target = clamp(
      fits ? (from + to - geometry.clientLength) / 2 : from,
      0,
      max,
    );
    track.scrollTo({
      [horizontal ? "left" : "top"]: target,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [count, horizontal]);

  useEffect(followVisible, [followVisible, visible]);

  // Marks are memoized so scrolling and hovering never re-diff hundreds of
  // spans: in-view state is toggled below, and the hover magnification is
  // computed in CSS from each mark's index and the track's preview index.
  const marks = useMemo(
    () =>
      entries.map((entry, index) => (
        <span
          key={entry.id}
          className={`conversation-minimap-mark is-${entry.role}`}
          data-entry-id={entry.id}
          style={{ "--mark-index": index } as CSSProperties}
          aria-hidden="true"
        />
      )),
    // structureKey covers the ids and roles marks read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [structureKey],
  );

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const start = visible?.start ?? 0;
    const end = visible?.end ?? -1;
    Array.from(track.children).forEach((mark, index) =>
      mark.classList.toggle("is-visible", index >= start && index <= end),
    );
  }, [marks, visible]);

  const indexAt = (clientX: number, clientY: number) => {
    const geometry = trackGeometry(trackRef.current!, horizontal, count);
    const offset =
      (((horizontal ? clientX : clientY) - geometry.rectStart) /
        Math.max(1, geometry.rectLength)) *
        geometry.clientLength +
      geometry.scroll;
    return clamp(Math.floor(offset / geometry.stride), 0, count - 1);
  };

  const select = (index: number) => {
    const entry = entries[index];
    if (!entry) return;
    setHoveredId(entry.id);
    onSelect(index);
  };

  // The track may have fallen behind the conversation during the press.
  const release = () => {
    pressRef.current = null;
    followVisible();
  };

  if (!count) return null;
  const current = entries[currentIndex];

  return (
    <div
      ref={rootRef}
      className={`conversation-minimap${horizontal ? " is-horizontal" : ""}${className ? ` ${className}` : ""}`}
    >
      <div
        className="conversation-minimap-frame"
        style={{ "--entry-count": count } as CSSProperties}
      >
        <div
          ref={trackRef}
          className="conversation-minimap-track"
          role="slider"
          tabIndex={0}
          aria-label={label}
          aria-orientation={horizontal ? "horizontal" : "vertical"}
          aria-valuemin={1}
          aria-valuemax={count}
          aria-valuenow={currentIndex + 1}
          aria-valuetext={`${current.label}: ${previewText(current.text, emptyText)}`}
          style={
            {
              "--preview-index":
                previewIndex < 0 ? NO_PREVIEW_INDEX : previewIndex,
            } as CSSProperties
          }
          onFocus={(event) =>
            setKeyboardFocus(event.currentTarget.matches(":focus-visible"))
          }
          onBlur={() => {
            setKeyboardFocus(false);
            setHoveredId(null);
          }}
          onPointerDown={(event) => {
            // Only the primary pointer's primary button starts a press: a
            // second touch must not overwrite the tracked finger.
            pannedRef.current = false;
            if (event.button !== 0 || !event.isPrimary) return;
            const track = event.currentTarget;
            const geometry = trackGeometry(track, horizontal, count);
            pressRef.current = {
              pointerId: event.pointerId,
              origin: horizontal ? event.clientX : event.clientY,
              scroll: geometry.scroll,
            };
            // A mouse cannot pan a scrollable by dragging, so an overflowing
            // track pans by hand; capture keeps the release on the track.
            // Touch pans natively and gets implicit capture already.
            if (
              event.pointerType !== "touch" &&
              geometry.scrollLength - geometry.clientLength > 1
            )
              track.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (event.pointerType !== "touch")
              setHoveredId(entries[indexAt(event.clientX, event.clientY)].id);
            const press = pressRef.current;
            if (!press || press.pointerId !== event.pointerId) return;
            // A mouse move with no buttons down means the release was lost.
            if (event.pointerType === "mouse" && event.buttons === 0) {
              release();
              return;
            }
            const track = event.currentTarget;
            if (!track.hasPointerCapture?.(event.pointerId)) return;
            const delta =
              (horizontal ? event.clientX : event.clientY) - press.origin;
            if (!pannedRef.current && Math.abs(delta) < PAN_THRESHOLD_PX)
              return;
            pannedRef.current = true;
            if (horizontal) track.scrollLeft = press.scroll - delta;
            else track.scrollTop = press.scroll - delta;
          }}
          onPointerUp={release}
          onPointerCancel={() => {
            pannedRef.current = false;
            release();
          }}
          onPointerLeave={() => setHoveredId(null)}
          onClick={(event) => {
            // The click that ends a pan only releases it.
            if (pannedRef.current) {
              pannedRef.current = false;
              return;
            }
            event.currentTarget.focus({ preventScroll: true });
            setKeyboardFocus(false);
            select(indexAt(event.clientX, event.clientY));
          }}
          onKeyDown={(event) => {
            const start = previewIndex >= 0 ? previewIndex : currentIndex;
            const page = visible ? visible.end - visible.start + 1 : 1;
            // Both arrow pairs step in either orientation, in reading order.
            const index =
              event.key === "ArrowUp" || event.key === "ArrowLeft"
                ? start - 1
                : event.key === "ArrowDown" || event.key === "ArrowRight"
                  ? start + 1
                  : event.key === "PageUp"
                    ? start - page
                    : event.key === "PageDown"
                      ? start + page
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? count - 1
                          : null;
            if (index === null) return;
            event.preventDefault();
            setKeyboardFocus(true);
            select(clamp(index, 0, count - 1));
          }}
        >
          {marks}
        </div>
        <div
          ref={thumbRef}
          className="conversation-minimap-thumb"
          style={{ display: "none" }}
          aria-hidden="true"
        />
        {preview ? (
          <div
            ref={previewRef}
            className="conversation-minimap-preview"
            role="tooltip"
          >
            <strong>
              {preview.label}
              <span>
                {previewIndex + 1} / {count}
              </span>
            </strong>
            <span>{previewText(preview.text, emptyText)}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
});

import "./ZoomablePreview.css";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Maximize, Minus, Plus } from "lucide-react";

export type PreviewDimensions = { width: number; height: number };

export function fitPreviewScale(
  content: PreviewDimensions,
  viewport: PreviewDimensions,
) {
  if (content.width <= 0 || content.height <= 0) return 1;
  return Math.max(
    0.001,
    Math.min(
      1,
      Math.max(1, viewport.width - 32) / content.width,
      Math.max(1, viewport.height - 32) / content.height,
    ),
  );
}

export function ZoomablePreview({
  dimensions,
  label,
  className = "",
  children,
}: {
  dimensions: PreviewDimensions;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<PreviewDimensions>({
    width: 0,
    height: 0,
  });
  const [zoom, setZoom] = useState<number | null>(null);
  const fitted = fitPreviewScale(dimensions, viewport);
  const scale = zoom ?? fitted;
  const centerRef = useRef<{ x: number; y: number } | null>(null);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const changeZoom = (value: number | null) => {
    const element = viewportRef.current;
    if (element)
      centerRef.current = {
        x: (element.scrollLeft + element.clientWidth / 2) / element.scrollWidth,
        y:
          (element.scrollTop + element.clientHeight / 2) / element.scrollHeight,
      };
    setZoom(value === null ? null : Math.min(8, Math.max(0.01, value)));
  };
  const changeZoomRef = useRef(changeZoom);
  changeZoomRef.current = changeZoom;

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () =>
      setViewport({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const element = viewportRef.current;
    const center = centerRef.current;
    if (!element || !center) return;
    centerRef.current = null;
    element.scrollLeft =
      center.x * element.scrollWidth - element.clientWidth / 2;
    element.scrollTop =
      center.y * element.scrollHeight - element.clientHeight / 2;
  }, [scale]);
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      changeZoomRef.current(
        scaleRef.current * (event.deltaY < 0 ? 1.15 : 1 / 1.15),
      );
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div
      className={`visual-preview ${className}`.trim()}
      role="region"
      aria-label={label}
      style={
        {
          "--visual-preview-height": `${Math.min(420, dimensions.height + 32)}px`,
        } as CSSProperties
      }
    >
      <div
        className="visual-preview-controls"
        role="toolbar"
        aria-label={`${label} zoom controls`}
      >
        <button
          type="button"
          onClick={() => changeZoom(scale / 1.25)}
          disabled={scale <= 0.01}
          aria-label="Zoom out"
          title="Zoom out"
        >
          <Minus size={14} />
        </button>
        <output aria-live="polite" aria-label="Zoom level">
          {Math.round(scale * 100)}%
        </output>
        <button
          type="button"
          onClick={() => changeZoom(scale * 1.25)}
          disabled={scale >= 8}
          aria-label="Zoom in"
          title="Zoom in"
        >
          <Plus size={14} />
        </button>
        <button
          type="button"
          onClick={() => changeZoom(null)}
          aria-pressed={zoom === null}
          title="Fit preview"
        >
          <Maximize size={13} /> Fit
        </button>
        <button type="button" onClick={() => changeZoom(1)} title="Actual size">
          100%
        </button>
      </div>
      <div
        className="visual-preview-viewport"
        ref={viewportRef}
        tabIndex={0}
        role="region"
        aria-label={`${label} viewport`}
        title="Scroll to pan. Ctrl/Cmd + wheel to zoom."
      >
        <div className="visual-preview-stage">
          <div
            className="visual-preview-content"
            style={{
              width: dimensions.width * scale,
              height: dimensions.height * scale,
            }}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

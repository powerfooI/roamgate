import {
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  DEFAULT_INSPECTOR_NAVIGATION_RATIO,
  inspectorNavigationRatioAtPosition,
} from "../workspaceResource";
import "./InspectorSplitResizer.css";

function navigationRatioForPointer(
  event: Pick<ReactPointerEvent<HTMLDivElement>, "clientX" | "currentTarget">,
  horizontalPadding: number,
  detailMinSize: number | undefined,
) {
  const resource = event.currentTarget.parentElement;
  if (!resource) return DEFAULT_INSPECTOR_NAVIGATION_RATIO;
  const bounds = resource.getBoundingClientRect();
  return inspectorNavigationRatioAtPosition(
    event.clientX - bounds.left - horizontalPadding / 2,
    bounds.width - horizontalPadding,
    detailMinSize,
  );
}

export function InspectorSplitResizer({
  ratio,
  horizontalPadding = 16,
  label = "Resize file navigation",
  detailMinSize,
  resetRatio = DEFAULT_INSPECTOR_NAVIGATION_RATIO,
  navigationId,
  detailId,
  onChange,
  onCommit,
}: {
  ratio: number;
  horizontalPadding?: number;
  label?: string;
  detailMinSize?: number;
  resetRatio?: number;
  navigationId: string;
  detailId: string;
  onChange: (ratio: number) => void;
  onCommit: (ratio: number) => void;
}) {
  const dragRatioRef = useRef(ratio);
  dragRatioRef.current = ratio;

  const updateFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const next = navigationRatioForPointer(
      event,
      horizontalPadding,
      detailMinSize,
    );
    dragRatioRef.current = next;
    onChange(next);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    event.preventDefault();
    const resource = event.currentTarget.parentElement;
    if (!resource) return;
    const availableWidth =
      resource.getBoundingClientRect().width - horizontalPadding;
    const currentOffset = dragRatioRef.current * availableWidth;
    const next = inspectorNavigationRatioAtPosition(
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? availableWidth
          : currentOffset + (event.key === "ArrowLeft" ? -16 : 16),
      availableWidth,
      detailMinSize,
    );
    dragRatioRef.current = next;
    onChange(next);
    onCommit(next);
  };

  return (
    <div
      className="workspace-inspector-split-resizer"
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-controls={`${navigationId} ${detailId}`}
      aria-valuemin={15}
      aria-valuemax={75}
      aria-valuenow={Math.round(ratio * 100)}
      title="Drag to resize; double-click to reset"
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        updateFromPointer(event);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        updateFromPointer(event);
      }}
      onPointerUp={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        onCommit(dragRatioRef.current);
      }}
      onPointerCancel={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        onCommit(dragRatioRef.current);
      }}
      onDoubleClick={() => {
        dragRatioRef.current = resetRatio;
        onChange(resetRatio);
        onCommit(resetRatio);
      }}
      onKeyDown={handleKeyDown}
    />
  );
}

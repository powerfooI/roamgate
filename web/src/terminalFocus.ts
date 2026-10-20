/**
 * Guards the terminal's frame-driven refocusing. Terminal frames refocus the
 * xterm textarea so keyboard input keeps working, but doing so while an
 * overlay owns focus dismisses it: Radix's DismissableLayer treats focusin
 * outside its content as an outside interaction and closes the popover. The
 * Workspace Inspector likewise owns keyboard focus while browsing resources,
 * as does Ranger while reviewing actions, the pane switcher while its search
 * field is open and the pane drag handle during keyboard moves. Streaming
 * output must not steal their focus.
 */
const TERMINAL_FOCUS_OVERLAY_SELECTOR =
  '[data-radix-popper-content-wrapper], .modal-backdrop, .workspace-tree-panel, .workspace-inspector, .annotation-panel, .assistant-panel, .tabbar-utilities, .mobile-nav, .pane-jump-backdrop, .popup-overlay-backdrop, .pane-drag-handle, [role="dialog"], [role="menu"]';
const RADIX_POPPER_CONTENT_WRAPPER = "[data-radix-popper-content-wrapper]";

type FocusableLike = Pick<Element, "closest">;
type DocumentLike = Pick<Document, "querySelector">;
type SelectionDocumentLike = Pick<Document, "getSelection">;
type PointerTarget = Pick<Document, "addEventListener" | "removeEventListener">;

export function terminalTouchInputAction(
  started: boolean,
  moved: boolean,
  directMode: boolean,
  inputActive: boolean,
  selecting: boolean,
): "focus" | "dismiss" | null {
  if (!started || moved || selecting) return null;
  return directMode ? "focus" : inputActive ? "dismiss" : null;
}

export function terminalPointerShouldBlurInput(
  coarsePointer: boolean,
  editableTarget: boolean,
  targetInsideTerminal: boolean,
): boolean {
  return coarsePointer && !editableTarget && !targetInsideTerminal;
}

export function terminalFocusBlockedByOverlay(
  activeElement: FocusableLike | null,
  doc: DocumentLike,
): boolean {
  // An open Radix popover mounts its content in a portal wrapper. Block even
  // before focus lands inside the content (the open-animation frame), so a
  // terminal frame cannot win that race and dismiss the popover. Closed
  // popovers unmount their content, so a mounted wrapper means "open".
  if (doc.querySelector(RADIX_POPPER_CONTENT_WRAPPER)) return true;
  if (!activeElement) return false;
  return Boolean(activeElement.closest(TERMINAL_FOCUS_OVERLAY_SELECTOR));
}

function selectionNodeInOverlay(node: Node | null | undefined): boolean {
  let element = node?.nodeType === 1 ? (node as Element) : node?.parentElement;
  while (element) {
    if (element.closest(TERMINAL_FOCUS_OVERLAY_SELECTOR)) return true;
    const root = element.getRootNode();
    element = "host" in root ? (root as ShadowRoot).host : null;
  }
  return false;
}

/**
 * Focusing xterm clears the document selection, and non-editable overlay text
 * never holds focus. Output-driven refocusing therefore waits while the user
 * is pressing in an overlay or has text selected there. Intentional focus
 * changes, such as activating a pane, do not consult this.
 */
export function terminalOutputFocusBlockedBySelection(
  doc: SelectionDocumentLike,
  pointerDownInOverlay = overlayPointerDown,
): boolean {
  if (pointerDownInOverlay) return true;
  const selection = doc.getSelection();
  if (!selection) return false;
  if (
    !selection.isCollapsed &&
    [selection.anchorNode, selection.focusNode].some(selectionNodeInOverlay)
  )
    return true;
  // Diff text lives in shadow roots; composed ranges expose its host boundary.
  return (
    selection
      .getComposedRanges?.()
      .some(
        (range) =>
          (range.startContainer !== range.endContainer ||
            range.startOffset !== range.endOffset) &&
          [range.startContainer, range.endContainer].some(
            selectionNodeInOverlay,
          ),
      ) ?? false
  );
}

let overlayPointerDown = false;
let overlayPointerWatchers = 0;
const onOverlayPointerDown = (event: Event) => {
  const target = event.target as Partial<FocusableLike> | null;
  overlayPointerDown = Boolean(
    target?.closest?.(TERMINAL_FOCUS_OVERLAY_SELECTOR),
  );
};
const onOverlayPointerEnd = () => {
  overlayPointerDown = false;
};

/** Tracks presses in overlays once for every mounted terminal. */
export function watchTerminalOverlayPointer(target: PointerTarget) {
  if (overlayPointerWatchers++ === 0) {
    target.addEventListener("pointerdown", onOverlayPointerDown, true);
    target.addEventListener("pointerup", onOverlayPointerEnd, true);
    target.addEventListener("pointercancel", onOverlayPointerEnd, true);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--overlayPointerWatchers > 0) return;
    target.removeEventListener("pointerdown", onOverlayPointerDown, true);
    target.removeEventListener("pointerup", onOverlayPointerEnd, true);
    target.removeEventListener("pointercancel", onOverlayPointerEnd, true);
    overlayPointerDown = false;
  };
}

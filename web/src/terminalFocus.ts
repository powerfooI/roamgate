/**
 * Guards the terminal's frame-driven refocusing. Terminal frames refocus the
 * xterm textarea so keyboard input keeps working, but doing so while an
 * overlay owns focus dismisses it: Radix's DismissableLayer treats focusin
 * outside its content as an outside interaction and closes the popover. The
 * Workspace Inspector likewise owns keyboard focus while browsing resources,
 * as does the pane switcher while its search field is open and the pane drag
 * handle during keyboard moves. Streaming output must not steal their focus.
 */
const TERMINAL_FOCUS_OVERLAY_SELECTOR =
  '[data-radix-popper-content-wrapper], .modal-backdrop, .workspace-tree-panel, .workspace-inspector, .annotation-panel, .tabbar-utilities, .mobile-nav, .pane-jump-backdrop, .popup-overlay-backdrop, .pane-drag-handle, [role="dialog"], [role="menu"]';
const RADIX_POPPER_CONTENT_WRAPPER = "[data-radix-popper-content-wrapper]";

type FocusableLike = Pick<Element, "closest">;
type DocumentLike = Pick<Document, "querySelector">;

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

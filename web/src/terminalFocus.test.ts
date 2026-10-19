import { describe, expect, test } from "bun:test";
import {
  terminalFocusBlockedByOverlay,
  terminalOutputFocusBlockedBySelection,
  terminalPointerShouldBlurInput,
  terminalTouchInputAction,
  watchTerminalOverlayPointer,
} from "./terminalFocus";

function docWithOpenPopper(open: boolean) {
  return {
    querySelector: (selector: string) =>
      open && selector === "[data-radix-popper-content-wrapper]"
        ? ({} as Element)
        : null,
  } as Pick<Document, "querySelector">;
}

function elementMatching(matching: string[] | null) {
  return {
    closest: (selector: string) =>
      matching?.includes(selector) ? ({} as Element) : null,
  } as Pick<Element, "closest">;
}

describe("terminalFocusBlockedByOverlay", () => {
  test("blocks refocusing whenever a Radix popover is mounted", () => {
    const doc = docWithOpenPopper(true);
    expect(terminalFocusBlockedByOverlay(null, doc)).toBe(true);
    // Covers the open-animation frame where focus still sits on the trigger.
    expect(terminalFocusBlockedByOverlay(elementMatching(null), doc)).toBe(
      true,
    );
  });

  test("blocks when a navigation or resource surface owns focus", () => {
    const doc = docWithOpenPopper(false);
    expect(
      terminalFocusBlockedByOverlay(
        elementMatching([
          '[data-radix-popper-content-wrapper], .modal-backdrop, .workspace-tree-panel, .workspace-inspector, .annotation-panel, .assistant-panel, .tabbar-utilities, .mobile-nav, .pane-jump-backdrop, .popup-overlay-backdrop, .pane-drag-handle, [role="dialog"], [role="menu"]',
        ]),
        doc,
      ),
    ).toBe(true);
  });

  test("blocks Ranger focus without blocking a terminal outside the panel", () => {
    const doc = docWithOpenPopper(false);
    const rangerElement = {
      closest: (selector: string) =>
        selector.split(", ").includes(".assistant-panel")
          ? ({} as Element)
          : null,
    };
    expect(terminalFocusBlockedByOverlay(rangerElement, doc)).toBe(true);
    expect(terminalFocusBlockedByOverlay(elementMatching(null), doc)).toBe(
      false,
    );
  });

  test("allows refocusing with no overlay and no focused element", () => {
    expect(terminalFocusBlockedByOverlay(null, docWithOpenPopper(false))).toBe(
      false,
    );
  });

  test("allows refocusing ordinary page elements", () => {
    expect(
      terminalFocusBlockedByOverlay(
        elementMatching(null),
        docWithOpenPopper(false),
      ),
    ).toBe(false);
  });
});

describe("terminal pointer focus", () => {
  test("blurs coarse-pointer taps only outside terminal and editable input", () => {
    expect(terminalPointerShouldBlurInput(true, false, false)).toBe(true);
    expect(terminalPointerShouldBlurInput(true, true, false)).toBe(false);
    expect(terminalPointerShouldBlurInput(true, false, true)).toBe(false);
    expect(terminalPointerShouldBlurInput(false, false, false)).toBe(false);
  });

  test("Direct taps focus input without dismissing an open keyboard", () => {
    expect(terminalTouchInputAction(true, false, true, false, false)).toBe(
      "focus",
    );
    expect(terminalTouchInputAction(true, false, true, true, false)).toBe(
      "focus",
    );
    expect(terminalTouchInputAction(true, false, false, true, false)).toBe(
      "dismiss",
    );
    expect(terminalTouchInputAction(true, false, false, false, false)).toBe(
      null,
    );
    expect(terminalTouchInputAction(true, true, true, false, false)).toBe(null);
    expect(terminalTouchInputAction(false, false, true, false, false)).toBe(
      null,
    );
    expect(terminalTouchInputAction(true, false, true, false, true)).toBe(null);
  });
});

describe("terminalOutputFocusBlockedBySelection", () => {
  const ranger = {
    closest: (selector: string) =>
      selector.split(", ").includes(".assistant-panel")
        ? ({} as Element)
        : null,
  };
  const rangerText = { nodeType: 3, parentElement: ranger };
  const docWithSelection = (isCollapsed: boolean, anchorNode: unknown) => ({
    getSelection: () => ({ isCollapsed, anchorNode }) as Selection,
  });

  test("waits while text selected in an overlay would be cleared", () => {
    expect(
      terminalOutputFocusBlockedBySelection(
        docWithSelection(false, rangerText),
        false,
      ),
    ).toBe(true);
    expect(
      terminalOutputFocusBlockedBySelection(
        docWithSelection(true, rangerText),
        false,
      ),
    ).toBe(false);
    expect(
      terminalOutputFocusBlockedBySelection(
        docWithSelection(false, { nodeType: 1, ...elementMatching(null) }),
        false,
      ),
    ).toBe(false);
  });

  test("waits while a press in an overlay may start a selection", () => {
    const listeners = new Map<string, (event: Event) => void>();
    const target = {
      addEventListener: (type: string, listener: (event: Event) => void) =>
        listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    } as unknown as Pick<Document, "addEventListener" | "removeEventListener">;
    const doc = docWithSelection(true, null);
    const release = watchTerminalOverlayPointer(target);
    const second = watchTerminalOverlayPointer(target);
    try {
      expect(terminalOutputFocusBlockedBySelection(doc)).toBe(false);
      listeners.get("pointerdown")!({ target: ranger } as unknown as Event);
      expect(terminalOutputFocusBlockedBySelection(doc)).toBe(true);
      listeners.get("pointerup")!({} as Event);
      expect(terminalOutputFocusBlockedBySelection(doc)).toBe(false);
      listeners.get("pointerdown")!({
        target: elementMatching(null),
      } as unknown as Event);
      expect(terminalOutputFocusBlockedBySelection(doc)).toBe(false);
      listeners.get("pointerdown")!({ target: ranger } as unknown as Event);
      // Listeners stay until the last terminal releases them.
      second();
      expect(listeners.size).toBe(3);
    } finally {
      release();
    }
    expect(listeners.size).toBe(0);
    expect(terminalOutputFocusBlockedBySelection(doc)).toBe(false);
  });
});

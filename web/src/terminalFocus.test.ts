import { describe, expect, test } from "bun:test";
import {
  terminalFocusBlockedByOverlay,
  terminalPointerShouldBlurInput,
  terminalTouchShouldDismissInput,
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
          '[data-radix-popper-content-wrapper], .modal-backdrop, .workspace-tree-panel, .workspace-inspector, .annotation-panel, .tabbar-utilities, .mobile-nav, [role="dialog"], [role="menu"]',
        ]),
        doc,
      ),
    ).toBe(true);
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

  test("only a completed light tap dismisses active input", () => {
    expect(terminalTouchShouldDismissInput(true, false, true)).toBe(true);
    expect(terminalTouchShouldDismissInput(true, true, true)).toBe(false);
    expect(terminalTouchShouldDismissInput(true, false, false)).toBe(false);
    expect(terminalTouchShouldDismissInput(false, false, true)).toBe(false);
  });
});

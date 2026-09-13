import { defaultShortcutBindings } from "./shortcutBindings";
import { describe, expect, test } from "bun:test";
import { paneShortcutAction as resolveShortcut } from "./paneShortcuts";

const paneShortcutAction = (event: Parameters<typeof resolveShortcut>[0]) =>
  resolveShortcut(event, defaultShortcutBindings("mac"));

function keyEvent(
  overrides: Partial<Parameters<typeof paneShortcutAction>[0]> = {},
): Parameters<typeof paneShortcutAction>[0] {
  return {
    key: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe("pane shortcuts", () => {
  test("maps Cmd+Ctrl+Arrows to directional pane focus", () => {
    expect(
      paneShortcutAction(
        keyEvent({ key: "ArrowLeft", metaKey: true, ctrlKey: true }),
      ),
    ).toEqual({ type: "focus", direction: "left" });
    expect(
      paneShortcutAction(
        keyEvent({ key: "ArrowRight", metaKey: true, ctrlKey: true }),
      ),
    ).toEqual({ type: "focus", direction: "right" });
    expect(
      paneShortcutAction(
        keyEvent({ key: "ArrowUp", metaKey: true, ctrlKey: true }),
      ),
    ).toEqual({ type: "focus", direction: "up" });
    expect(
      paneShortcutAction(
        keyEvent({ key: "ArrowDown", metaKey: true, ctrlKey: true }),
      ),
    ).toEqual({ type: "focus", direction: "down" });
  });

  test("maps Cmd+D and Cmd+Shift+D to pane splits", () => {
    expect(paneShortcutAction(keyEvent({ key: "d", metaKey: true }))).toEqual({
      type: "split",
      direction: "right",
    });
    expect(
      paneShortcutAction(keyEvent({ key: "D", metaKey: true, shiftKey: true })),
    ).toEqual({ type: "split", direction: "down" });
  });

  test("maps Cmd+Shift+Enter to pane zoom", () => {
    expect(
      paneShortcutAction(
        keyEvent({ key: "Enter", metaKey: true, shiftKey: true }),
      ),
    ).toEqual({ type: "zoom" });
    // Cmd+Enter sends the composer draft; plain Enter stays terminal input.
    expect(
      paneShortcutAction(keyEvent({ key: "Enter", metaKey: true })),
    ).toBeNull();
    expect(paneShortcutAction(keyEvent({ key: "Enter" }))).toBeNull();
  });

  test("rejects extra or missing modifiers", () => {
    // Cmd+Option+Arrows belong to tab switching.
    expect(
      paneShortcutAction(
        keyEvent({ key: "ArrowLeft", metaKey: true, altKey: true }),
      ),
    ).toBeNull();
    expect(
      paneShortcutAction(keyEvent({ key: "ArrowLeft", ctrlKey: true })),
    ).toBeNull();
    expect(
      paneShortcutAction(keyEvent({ key: "ArrowLeft", metaKey: true })),
    ).toBeNull();
    expect(
      paneShortcutAction(keyEvent({ key: "d", ctrlKey: true })),
    ).toBeNull();
    expect(
      paneShortcutAction(keyEvent({ key: "d", metaKey: true, ctrlKey: true })),
    ).toBeNull();
    expect(
      paneShortcutAction(keyEvent({ key: "a", metaKey: true, ctrlKey: true })),
    ).toBeNull();
    expect(
      paneShortcutAction(
        keyEvent({ key: "D", metaKey: true, ctrlKey: true, shiftKey: true }),
      ),
    ).toBeNull();
    expect(
      paneShortcutAction(keyEvent({ key: "d", metaKey: true, altKey: true })),
    ).toBeNull();
    expect(
      paneShortcutAction(
        keyEvent({
          key: "ArrowLeft",
          metaKey: true,
          ctrlKey: true,
          shiftKey: true,
        }),
      ),
    ).toBeNull();
  });
});

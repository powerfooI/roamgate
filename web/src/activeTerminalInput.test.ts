import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { activeTerminalInput } from "./activeTerminalInput";

describe("activeTerminalInput", () => {
  test("leaves other inputs alone when no terminal is visible", async () => {
    const browser = new Window();
    try {
      browser.document.body.innerHTML = `<textarea class="xterm-helper-textarea"></textarea><div class="mobile-bottom-bar"><div class="terminal-composer" data-open data-input-mode="composer" data-pane-id="p1"><textarea class="terminal-composer-input"></textarea></div></div>`;
      expect(
        activeTerminalInput(browser.document as unknown as Document),
      ).toBeNull();
    } finally {
      await browser.happyDOM.close();
    }
  });
  test.each(["composer", "direct", "closed", "other-pane"])(
    "routes a portalled %s editor only to its active pane",
    async (state) => {
      const browser = new Window();
      const doc = browser.document;
      try {
        doc.body.innerHTML = `<div class="workspace-terminal-surface">
          <div class="pane-layout-cell"><div class="terminal-shell" data-pane-id="p1"><div class="terminal-view"></div></div></div>
          <div class="pane-layout-cell is-active"><div class="terminal-shell" data-pane-id="p2"><div class="terminal-view"></div></div></div>
        </div><div class="mobile-bottom-bar">
          <div class="terminal-composer" data-pane-id="${state === "other-pane" ? "p1" : "p2"}" data-input-mode="${state === "direct" ? "direct" : "composer"}" ${state === "closed" ? "" : "data-open"}>
            <textarea class="terminal-composer-input"></textarea>
          </div>
        </div>`;
        expect(activeTerminalInput(doc as unknown as Document)).toBe(
          doc.querySelector(
            state === "composer"
              ? ".terminal-composer-input"
              : ".is-active .terminal-view",
          ) as unknown as HTMLElement | null,
        );
      } finally {
        await browser.happyDOM.close();
      }
    },
  );
  test.each(["single", "split"])(
    "finds the selected %s terminal activation target or its composer draft",
    async (layout) => {
      const browser = new Window();
      const doc = browser.document;
      try {
        const terminal = `<div class="terminal-shell">
          <div class="terminal-view" tabindex="-1"><textarea class="xterm-helper-textarea"></textarea></div>
          <textarea class="terminal-composer-input" hidden></textarea>
        </div>`;
        doc.body.innerHTML = `<button>Other control</button><div class="workspace-terminal-surface">${
          layout === "split"
            ? `<div class="pane-layout-cell">${terminal}</div><div class="pane-layout-cell is-active">${terminal}</div>`
            : terminal
        }</div>`;
        const shell = doc.querySelector(
          layout === "split" ? ".is-active .terminal-shell" : ".terminal-shell",
        )!;
        const input = shell.querySelector("div")!;
        const draft = shell.querySelectorAll("textarea")[1]!;
        doc.querySelector("button")!.focus();
        activeTerminalInput(doc as unknown as Document)?.focus();
        expect(doc.activeElement).toBe(input);
        draft.removeAttribute("hidden");
        activeTerminalInput(doc as unknown as Document)?.focus();
        expect(doc.activeElement).toBe(draft);
        draft.setAttribute("hidden", "");
        activeTerminalInput(doc as unknown as Document)?.focus();
        expect(doc.activeElement).toBe(input);
      } finally {
        await browser.happyDOM.close();
      }
    },
  );
});

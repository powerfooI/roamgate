import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

// Hook-spy tests in other files must not replace React in this DOM runtime.
if (process.env.ROAMGATE_COMPOSER_DOM_TEST !== "1") {
  test("composer completed touch activation in an isolated React DOM", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_COMPOSER_DOM_TEST: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
    expect(code).toBe(0);
  }, 15000);
} else {
  test("Insert/Send survive focus and viewport changes without premature or duplicate sends", async () => {
    const browser = new Window({ url: "http://localhost" });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      HTMLButtonElement: browser.HTMLButtonElement,
      HTMLTextAreaElement: browser.HTMLTextAreaElement,
      Element: browser.Element,
      Node: browser.Node,
      localStorage: browser.localStorage,
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    }
    const { createRoot } = await import("react-dom/client");
    const { TerminalComposer } = await import("./TerminalComposer");
    const drafts = await import("../terminalComposer");
    // Load after installing this isolated DOM and its storage globals.
    const { sendTerminalComposerText } = await import(
      "../terminalComposerSend"
    );
    const key = "one-tap-dom";
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const calls: Array<[string, boolean]> = [];
    let finish: (() => void) | undefined;
    let fail = false;
    let mode: "composer" | "direct" = "composer";
    let exerciseTerminalSend = false;
    const rpcCalls: Array<[string, unknown]> = [];
    let accessoriesVisible = true;
    const props = {
      draftKey: key,
      mode,
      onModeChange() {},
      onFocusDirect() {},
      directDisabled: false,
      shortcutRows: [],
      onRunShortcut() {},
      onClose() {},
      onSubmit: async (text: string, enter: boolean) => {
        calls.push([text, enter]);
        if (exerciseTerminalSend) {
          await sendTerminalComposerText(
            {
              call: async (method: string, params: unknown) => {
                rpcCalls.push([method, params]);
              },
            } as Parameters<typeof sendTerminalComposerText>[0],
            "pane-one",
            text,
            enter,
          );
          return;
        }
        if (fail) throw new Error("Disconnected");
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
      onUploadImage: async () => "/image.png",
      onUploadFile: async () => "/file.txt",
      onError() {},
    };
    const render = () =>
      act(() =>
        root.render(
          createElement(TerminalComposer, {
            ...props,
            mode,
            accessoriesVisible,
          }),
        ),
      );
    const seed = async () =>
      act(() => drafts.writeTerminalComposerDraft(key, "hello"));
    const button = (enter: boolean) =>
      container.querySelector<HTMLButtonElement>(
        enter ? ".is-primary" : ".terminal-composer-submit",
      )!;
    const editor = () => container.querySelector("textarea")!;
    let clock = 1000;
    const pointer = (
      target: Element,
      type: string,
      options: {
        x?: number;
        y?: number;
        elapsed?: number;
        pointerType?: string;
        id?: number;
      } = {},
    ) => {
      clock += options.elapsed ?? 10;
      const event = new browser.PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerType: options.pointerType ?? "touch",
        pointerId: options.id ?? 1,
        isPrimary: true,
        clientX: options.x ?? 120,
        clientY: options.y ?? 120,
      });
      Object.defineProperty(event, "timeStamp", { value: clock });
      target.dispatchEvent(event as unknown as Event);
      return event;
    };
    const click = (target: Element, detail = 1) =>
      target.dispatchEvent(
        new browser.MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          detail,
          clientX: detail ? 120 : 0,
          clientY: detail ? 120 : 0,
        }) as unknown as Event,
      );
    const bounds = (target: HTMLButtonElement) => {
      target.getBoundingClientRect = () => ({
        left: 100,
        right: 180,
        top: 100,
        bottom: 140,
        width: 80,
        height: 40,
        x: 100,
        y: 100,
        toJSON() {},
      });
    };
    const settle = async () => {
      await act(async () => {
        finish?.();
        await Promise.resolve();
      });
      finish = undefined;
    };
    try {
      await render();
      for (const enter of [false, true]) {
        await seed();
        const action = button(enter);
        bounds(action);
        await act(() => editor().focus());
        editor().setSelectionRange(1, 3);
        // Missing keyboard geometry must not trigger document-capture blur.
        document.documentElement.classList.remove("keyboard-open");
        let down: ReturnType<typeof pointer> | undefined;
        await act(() => {
          down = pointer(action.querySelector("svg")!, "pointerdown");
        });
        expect(down!.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(editor());
        expect(editor().selectionStart).toBe(1);
        expect(calls.length).toBe(enter ? 1 : 0);
        // Even if the OS blurs/resizes between press and release, the completed
        // release on the original SVG invokes exactly one action, without click.
        await act(() => {
          editor().blur();
          window.dispatchEvent(new browser.Event("resize") as unknown as Event);
          action.getBoundingClientRect = () => ({
            left: 100,
            right: 180,
            top: 300,
            bottom: 340,
            width: 80,
            height: 40,
            x: 100,
            y: 300,
            toJSON() {},
          });
          pointer(action.querySelector("svg")!, "pointerup");
        });
        expect(calls[calls.length - 1]).toEqual(["hello", enter]);
        const count = calls.length;
        await settle();
        await seed();
        await act(() => click(action.querySelector("path") ?? action));
        expect(calls.length).toBe(count); // compatibility click after unlock
        expect(document.activeElement).not.toBe(editor()); // no keyboard reopen
      }
      // Cancellation stays latched, including an out-and-back or long hold.
      for (const gesture of [
        "cancel",
        "drag",
        "outside",
        "hold",
        "contextmenu",
      ]) {
        const action = button(true);
        bounds(action);
        const count = calls.length;
        await act(() => {
          pointer(action, "pointerdown");
          if (gesture === "cancel") pointer(action, "pointercancel");
          if (gesture === "drag") {
            pointer(action, "pointermove", { x: 160 });
            pointer(action, "pointermove");
          }
          if (gesture === "contextmenu")
            action.dispatchEvent(
              new browser.MouseEvent("contextmenu", {
                bubbles: true,
              }) as unknown as Event,
            );
          pointer(action, "pointerup", {
            x: gesture === "outside" ? 181 : 120,
            elapsed: gesture === "hold" ? 600 : 10,
          });
          if (gesture !== "outside") click(action);
        });
        expect(calls.length).toBe(count);
        expect(drafts.readTerminalComposerDraft(key)).toBe("hello");
      }
      // IME, upload and shared submission locks remain authoritative.
      for (const lock of ["ime", "upload", "submission"]) {
        const count = calls.length;
        await act(() => {
          if (lock === "ime")
            editor().dispatchEvent(
              new browser.CompositionEvent("compositionstart", {
                bubbles: true,
              }) as unknown as Event,
            );
          if (lock === "upload") drafts.beginTerminalComposerUpload(key);
          if (lock === "submission")
            drafts.beginTerminalComposerSubmission(key);
        });
        expect(button(true).disabled).toBe(true);
        await act(() => {
          pointer(button(true), "pointerdown");
          pointer(button(true), "pointerup");
          click(button(true));
        });
        expect(calls.length).toBe(count);
        await act(() => {
          if (lock === "ime")
            editor().dispatchEvent(
              new browser.CompositionEvent("compositionend", {
                bubbles: true,
              }) as unknown as Event,
            );
          if (lock === "upload") drafts.finishTerminalComposerUpload(key);
          if (lock === "submission")
            drafts.finishTerminalComposerSubmission(key);
        });
      }
      // A second contact anywhere cancels the original tap permanently.
      bounds(button(true));
      const beforeMulti = calls.length;
      await act(() => {
        pointer(button(true), "pointerdown");
        pointer(document.body, "pointerdown", { id: 2 });
        pointer(button(true), "pointerup");
        click(button(true));
      });
      expect(calls.length).toBe(beforeMulti);
      // An IME lock at down cannot become an unlocked release submission.
      await act(() =>
        editor().dispatchEvent(
          new browser.CompositionEvent("compositionstart", {
            bubbles: true,
          }) as unknown as Event,
        ),
      );
      await act(() => pointer(button(true), "pointerdown"));
      await act(() =>
        editor().dispatchEvent(
          new browser.CompositionEvent("compositionend", {
            bubbles: true,
          }) as unknown as Event,
        ),
      );
      await act(() => {
        pointer(button(true), "pointerup");
        click(button(true));
      });
      expect(calls.length).toBe(beforeMulti);
      // Visiting a secondary surface permanently cancels the pending release,
      // even when Terminal is restored before the finger lifts. The delayed
      // compatibility click must not revive that cancelled Send/Insert either.
      for (const enter of [false, true]) {
        const action = button(enter);
        bounds(action);
        const beforeSurface = calls.length;
        const originalEditor = editor();
        await act(() => pointer(action, "pointerdown"));
        accessoriesVisible = false;
        await render();
        expect(
          container.querySelector<HTMLElement>(".terminal-composer-toolbar")!
            .hidden,
        ).toBe(true);
        expect(editor()).toBe(originalEditor);
        await act(() => click(action, 0));
        expect(calls.length).toBe(beforeSurface);
        accessoriesVisible = true;
        await render();
        await act(() => {
          pointer(action, "pointerup");
          click(action);
        });
        expect(calls.length).toBe(beforeSurface);
        expect(drafts.readTerminalComposerDraft(key)).toBe("hello");
      }
      // A pane/mode transition cannot complete an old press.
      bounds(button(true));
      await act(() => pointer(button(true), "pointerdown"));
      mode = "direct";
      await render();
      const beforeTransition = calls.length;
      await act(() => pointer(button(true), "pointerup"));
      expect(calls.length).toBe(beforeTransition);
      mode = "composer";
      await render();
      // A failed release restores the draft before its delayed compatibility
      // click, but must still not retry an uncertain terminal write.
      fail = true;
      const beforeFailure = calls.length;
      bounds(button(true));
      await act(async () => {
        pointer(button(true), "pointerdown");
        pointer(button(true), "pointerup");
        await Promise.resolve();
      });
      expect(calls.length).toBe(beforeFailure + 1);
      expect(drafts.readTerminalComposerDraft(key)).toBe("hello");
      await act(() => click(button(true)));
      expect(calls.length).toBe(beforeFailure + 1);
      await act(() =>
        button(true).dispatchEvent(
          new browser.PointerEvent("click", {
            bubbles: true,
            cancelable: true,
            pointerType: "touch",
            pointerId: 1,
            detail: 1,
          }) as unknown as Event,
        ),
      );
      expect(calls.length).toBe(beforeFailure + 1);
      await act(() =>
        button(false).dispatchEvent(
          new browser.PointerEvent("click", {
            bubbles: true,
            cancelable: true,
            pointerType: "touch",
            pointerId: 1,
            detail: 1,
          }) as unknown as Event,
        ),
      );
      expect(calls.length).toBe(beforeFailure + 1);
      // A click with no touch identity is not rejected merely for detail=1.
      await act(async () => {
        button(false).dispatchEvent(
          new browser.MouseEvent("click", {
            bubbles: true,
            detail: 1,
          }) as unknown as Event,
        );
        await Promise.resolve();
      });
      expect(calls.length).toBe(beforeFailure + 2);
      // Keyboard/AT click still works following touch, and mouse down starts
      // a fresh native click sequence. Failure retains the draft.
      fail = true;
      await act(async () => {
        click(button(false), 0);
        await Promise.resolve();
      });
      expect(calls[calls.length - 1]).toEqual(["hello", false]);
      expect(drafts.readTerminalComposerDraft(key)).toBe("hello");
      fail = false;
      await act(() => {
        pointer(button(true), "pointerdown", { pointerType: "mouse" });
        click(button(true));
      });
      expect(calls[calls.length - 1]).toEqual(["hello", true]);
      await settle();
      exerciseTerminalSend = true;
      browser.localStorage.setItem("roamgate:terminalSubmitKey", "meta-enter");
      await seed();
      await act(async () => {
        click(button(true), 0);
        await Promise.resolve();
      });
      expect(rpcCalls).toEqual([
        ["pane.send_input", { pane_id: "pane-one", text: "hello", keys: [] }],
        ["pane.send_keys", { pane_id: "pane-one", keys: ["super+enter"] }],
      ]);
    } finally {
      await act(() => root.unmount());
      container.remove();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      await browser.happyDOM.close();
    }
  });
}

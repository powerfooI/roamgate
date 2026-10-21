import { expect, jest, mock, test } from "bun:test";
import * as React from "react";
import {
  activateTerminalComposerDraftScope,
  readTerminalComposerDraft,
  terminalComposerDraftKey,
  terminalComposerUploadCount,
  writeTerminalComposerDraft,
  writeTerminalComposerSelection,
} from "../terminalComposer";
import { AgentHistoryComposer } from "./AgentHistoryComposer";

if (process.env.ROAMGATE_HISTORY_COMPOSER_DOM_TEST !== "1") {
  test("history composer in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_HISTORY_COMPOSER_DOM_TEST: "1" },
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
  }, 15_000);
} else {
  test("sends the shared draft and confirms before typing into a busy agent", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost" });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      Event: browser.Event,
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
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const draftKey = terminalComposerDraftKey("local", 1, "pane-one");
    let fail = false;
    const send = mock<(text: string) => Promise<void>>(async () => {
      if (fail) throw new Error("pane closed");
    });
    const error = mock<(message: string) => void>(() => {});
    const upload = mock<(file: File) => Promise<string>>(
      async (file) => `/tmp/${file.name}`,
    );
    let stateSeq = 0;
    const render = (status: string, sameState = false) =>
      React.act(async () =>
        root.render(
          <AgentHistoryComposer
            draftKey={draftKey}
            agent="codex"
            status={status}
            stateSeq={sameState ? stateSeq : ++stateSeq}
            onSend={send}
            onUploadImage={upload}
            onError={error}
          />,
        ),
      );
    const input = () => container.querySelector("textarea")!;
    const warning = () => container.querySelector('[role="alert"]');
    const key = (name: string, options: KeyboardEventInit = {}) =>
      React.act(async () =>
        input().dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: name,
            bubbles: true,
            cancelable: true,
            ...options,
          }),
        ),
      );
    const fill = (text: string) =>
      React.act(async () => {
        Object.getOwnPropertyDescriptor(
          browser.HTMLTextAreaElement.prototype,
          "value",
        )!.set!.call(input(), text);
        input().dispatchEvent(new window.Event("input", { bubbles: true }));
      });
    let coarsePointer = false;
    const matchMedia = (query: string) => ({
      matches: query === "(pointer: coarse)" && coarsePointer,
    });
    originals.set(
      "matchMedia",
      Object.getOwnPropertyDescriptor(globalThis, "matchMedia"),
    );
    Object.defineProperty(globalThis, "matchMedia", {
      value: matchMedia,
      configurable: true,
      writable: true,
    });
    const sendAnyway = () =>
      React.act(async () =>
        Array.from(container.querySelectorAll("button"))
          .find((button) => button.textContent === "Send anyway")!
          .click(),
      );
    try {
      // A draft started in the terminal composer appears here.
      writeTerminalComposerDraft(draftKey, "from terminal");
      await render("idle");
      expect(input().value).toBe("from terminal");

      // Shift+Enter keeps editing; Enter sends to an idle agent at once.
      await fill("hello");
      await key("Enter", { shiftKey: true });
      expect(send).not.toHaveBeenCalled();
      await key("Enter");
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[0]).toBe("hello");
      expect(readTerminalComposerDraft(draftKey)).toBe("");
      expect(input().value).toBe("");

      // Codex reports "unknown" while it sits at its prompt.
      await render("unknown");
      await fill("status?");
      await key("Enter");
      expect(warning()).toBeNull();
      expect(send).toHaveBeenCalledTimes(2);

      // A working agent needs Send anyway: Enter again only keeps the warning.
      await render("working");
      await fill("next step");
      await key("Enter");
      expect(warning()?.textContent).toContain("codex is still working.");
      await key("Enter");
      await key("Enter");
      expect(send).toHaveBeenCalledTimes(2);
      expect(warning()).not.toBeNull();

      // Editing or Escape dismisses it.
      await fill("next steps");
      expect(warning()).toBeNull();
      await key("Enter");
      await key("Escape");
      expect(warning()).toBeNull();

      // A dismissed warning stays dismissed when the text is restored.
      await key("Enter");
      expect(warning()).not.toBeNull();
      await fill("next steps!");
      await fill("next steps");
      expect(warning()).toBeNull();

      // So does one for a state the agent left and returned to, even when no
      // render saw the state in between.
      await key("Enter");
      expect(warning()).not.toBeNull();
      stateSeq += 1;
      await render("working");
      expect(warning()).toBeNull();
      await render("working", true);
      expect(warning()).toBeNull();
      expect(send).toHaveBeenCalledTimes(2);

      // A state change drops a warning given for the previous state.
      await key("Enter");
      await render("blocked");
      expect(warning()).toBeNull();
      await key("Enter");
      expect(warning()?.textContent).toContain("waiting on a prompt");
      await sendAnyway();
      expect(send).toHaveBeenCalledTimes(3);
      expect(send.mock.calls[2]?.[0]).toBe("next steps");
      expect(warning()).toBeNull();

      // The warning disappears once the agent is back at its prompt.
      await fill("approve");
      await key("Enter");
      expect(warning()).not.toBeNull();
      await render("idle");
      expect(warning()).toBeNull();

      // Touch keyboards cannot type Shift+Enter, so Enter adds a line there.
      coarsePointer = true;
      await render("done");
      expect(input().getAttribute("enterkeyhint")).toBe("enter");
      await key("Enter");
      expect(send).toHaveBeenCalledTimes(3);
      coarsePointer = false;
      await render("idle");

      // A failed send restores the draft and reports the error.
      fail = true;
      await key("Enter");
      expect(send).toHaveBeenCalledTimes(4);
      expect(readTerminalComposerDraft(draftKey)).toBe("approve");
      expect(input().value).toBe("approve");
      expect(error.mock.calls[0]?.[0]).toBe("pane closed");

      // A touch submits on release, before the keyboard can move the button,
      // and its later compatibility click is not a second send.
      fail = false;
      let clock = 1000;
      const touch = (target: HTMLButtonElement, type: string) => {
        clock += 10;
        const event = new browser.PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerType: "touch",
          pointerId: 1,
          isPrimary: true,
          clientX: 20,
          clientY: 20,
        });
        Object.defineProperty(event, "timeStamp", { value: clock });
        target.dispatchEvent(event as unknown as Event);
      };
      const button = (label: string) =>
        Array.from(container.querySelectorAll("button")).find((target) =>
          target.textContent?.includes(label),
        )!;
      // Touch down and release only; WebKit may never deliver the click.
      const release = (label: string) =>
        React.act(async () => {
          const target = button(label);
          target.getBoundingClientRect = () =>
            ({ left: 0, right: 100, top: 0, bottom: 40 }) as DOMRect;
          touch(target, "pointerdown");
          touch(target, "pointerup");
          await Promise.resolve();
        });
      const compatibilityClick = (label: string) =>
        React.act(async () => {
          button(label).dispatchEvent(
            new browser.PointerEvent("click", {
              bubbles: true,
              cancelable: true,
              pointerType: "touch",
              pointerId: 1,
              detail: 1,
            }) as unknown as Event,
          );
        });
      await fill("tapped");
      await release("Send");
      expect(send).toHaveBeenCalledTimes(5);
      expect(send.mock.calls[4]?.[0]).toBe("tapped");
      await compatibilityClick("Send");
      expect(send).toHaveBeenCalledTimes(5);

      await render("working");
      await fill("tapped anyway");
      await release("Send");
      expect(warning()).not.toBeNull();
      // Older WebKit's compatibility click has no pointer identity. Layout can
      // retarget it to the confirmation the release revealed; it must not
      // confirm the send.
      await React.act(async () => {
        button("Send anyway").dispatchEvent(
          new browser.MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            detail: 1,
            clientX: 20,
            clientY: 20,
          }) as unknown as Event,
        );
      });
      expect(send).toHaveBeenCalledTimes(5);
      expect(warning()).not.toBeNull();
      await release("Send anyway");
      expect(send).toHaveBeenCalledTimes(6);
      expect(send.mock.calls[5]?.[0]).toBe("tapped anyway");
      await compatibilityClick("Send");
      expect(send).toHaveBeenCalledTimes(6);

      // Text paste stays native; image paste uploads without sending and uses
      // the completion-time caret even when the user edits during the upload.
      await render("idle");
      const paste = async (files: File[], itemsOnly = false) => {
        const event = new window.Event("paste", {
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(event, "clipboardData", {
          value: {
            files: itemsOnly ? [] : files,
            items: files.map((file) => ({ getAsFile: () => file })),
          },
        });
        await React.act(async () => input().dispatchEvent(event));
        return event;
      };
      const image = new File(["image"], "photo.png", { type: "image/png" });
      expect((await paste([])).defaultPrevented).toBe(false);
      expect(upload).not.toHaveBeenCalled();
      let finishUpload!: (path: string) => void;
      upload.mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            finishUpload = resolve;
          }),
      );
      await fill("look here");
      expect((await paste([image], true)).defaultPrevented).toBe(true);
      expect(upload.mock.calls[0]?.[0]).toBe(image);
      expect(terminalComposerUploadCount(draftKey)).toBe(1);
      expect(button("Uploading...").disabled).toBe(true);
      await key("Enter");
      expect(send).toHaveBeenCalledTimes(6);
      await fill("look here please");
      writeTerminalComposerSelection(draftKey, 5, 9);
      await React.act(async () => finishUpload("/tmp/photo.png"));
      expect(input().value).toBe("look /tmp/photo.png  please");
      expect(input().selectionStart).toBe("look /tmp/photo.png ".length);
      expect(terminalComposerUploadCount(draftKey)).toBe(0);
      await key("Enter");
      expect(send.mock.calls[6]?.[0]).toBe("look /tmp/photo.png  please");

      // Phones also have an image chooser, independent of clipboard support.
      coarsePointer = true;
      await render("idle");
      const picker =
        container.querySelector<HTMLInputElement>('input[type="file"]')!;
      expect(picker.accept).toBe("image/*");
      expect(picker.multiple).toBe(true);
      const pickerClick = mock(() => {});
      picker.addEventListener("click", pickerClick);
      await React.act(async () => {
        container
          .querySelector<HTMLButtonElement>('[aria-label="Add images"]')!
          .click();
      });
      expect(pickerClick).toHaveBeenCalledTimes(1);
      const chooseImages = (files: File[]) =>
        React.act(async () => {
          Object.defineProperty(picker, "files", {
            value: files,
            configurable: true,
          });
          picker.dispatchEvent(new window.Event("change", { bubbles: true }));
        });
      await chooseImages([image]);
      expect(input().value).toBe("/tmp/photo.png  ");
      expect(picker.value).toBe("");
      expect(send).toHaveBeenCalledTimes(7);

      // Partial failure keeps successful paths and unlocks sending.
      await fill("review");
      upload.mockImplementationOnce(async () => "/tmp/first.png");
      upload.mockImplementationOnce(async () => {
        throw new Error("Image too large");
      });
      await paste([image, image]);
      expect(input().value).toBe("review /tmp/first.png  ");
      expect(error.mock.calls[error.mock.calls.length - 1]?.[0]).toBe(
        "Image too large",
      );
      expect(terminalComposerUploadCount(draftKey)).toBe(0);

      // A successful upload or a partial failure must leave IME preedit text
      // and its caret untouched until the final native input event commits it.
      const composition = (type: string) =>
        input().dispatchEvent(
          new browser.CompositionEvent(type, {
            bubbles: true,
          }) as unknown as Event,
        );
      jest.useFakeTimers();
      try {
        for (const partialFailure of [false, true]) {
          await fill("look ");
          upload.mockImplementationOnce(
            () =>
              new Promise<string>((resolve) => {
                finishUpload = resolve;
              }),
          );
          if (partialFailure)
            upload.mockImplementationOnce(async () => {
              throw new Error("Second image failed");
            });
          await paste(partialFailure ? [image, image] : [image]);
          await React.act(async () => {
            composition("compositionstart");
          });
          await fill("look ni");
          const caret = input().selectionStart;
          const errorsBefore = error.mock.calls.length;
          await React.act(async () => finishUpload("/tmp/ime.png"));
          expect(input().value).toBe("look ni");
          expect(input().selectionStart).toBe(caret);
          expect(readTerminalComposerDraft(draftKey)).toBe("look ni");
          expect(terminalComposerUploadCount(draftKey)).toBe(1);
          expect(error.mock.calls.length).toBe(
            errorsBefore + Number(partialFailure),
          );
          await React.act(async () => {
            composition("compositionend");
          });
          // Some browsers deliver the committed input after compositionend.
          await fill("look \u4f60");
          await React.act(async () => {
            jest.advanceTimersByTime(0);
          });
          expect(input().value).toBe("look \u4f60 /tmp/ime.png  ");
          expect(terminalComposerUploadCount(draftKey)).toBe(0);
        }

        // Closing History must release deferred work, including a network
        // response that arrives only after the composing editor unmounts.
        for (const finishBeforeUnmount of [true, false]) {
          await fill("keep ");
          upload.mockImplementationOnce(
            () =>
              new Promise<string>((resolve) => {
                finishUpload = resolve;
              }),
          );
          await paste([image]);
          await React.act(async () => {
            composition("compositionstart");
          });
          if (finishBeforeUnmount)
            await React.act(async () => finishUpload("/tmp/closed.png"));
          await React.act(async () => root.render(null));
          if (!finishBeforeUnmount)
            await React.act(async () => finishUpload("/tmp/closed.png"));
          expect(readTerminalComposerDraft(draftKey)).toBe(
            "keep /tmp/closed.png  ",
          );
          expect(terminalComposerUploadCount(draftKey)).toBe(0);
          await render("idle");
        }
      } finally {
        jest.useRealTimers();
      }

      // An in-flight upload can finish after leaving History. Its path belongs
      // to the original pane, including when the connection is retired.
      upload.mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            finishUpload = resolve;
          }),
      );
      await paste([image]);
      const otherKey = terminalComposerDraftKey("other", 2, "pane-two");
      await React.act(async () => {
        activateTerminalComposerDraftScope("other", 2);
        writeTerminalComposerDraft(otherKey, "new connection draft");
        finishUpload("/tmp/old-pane.png");
      });
      expect(readTerminalComposerDraft(otherKey)).toBe("new connection draft");
      expect(readTerminalComposerDraft(draftKey)).toContain(
        "/tmp/old-pane.png",
      );
      expect(error.mock.calls[error.mock.calls.length - 1]?.[0]).toContain(
        "Connection or pane changed",
      );
      expect(terminalComposerUploadCount(draftKey)).toBe(0);
    } finally {
      await React.act(async () => root.unmount());
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }, 10_000);
}

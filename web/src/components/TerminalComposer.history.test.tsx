import { expect, mock, test } from "bun:test";
import * as React from "react";

if (process.env.ROAMGATE_BOTTOM_HISTORY_COMPOSER_TEST !== "1") {
  test("bottom history composer in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_BOTTOM_HISTORY_COMPOSER_TEST: "1" },
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
  test("bottom composer preserves guarded sends, drafts, IME, and file paste", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/?layout=mobile" });
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
      Event: browser.Event,
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
    const { agentPromptWarning, agentStateKind } = await import(
      "./agentSession"
    );
    const drafts = await import("../terminalComposer");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const draftKey = drafts.terminalComposerDraftKey("local", 1, "mobile-pane");
    const send = mock<(text: string, submit: boolean) => Promise<void>>(
      async () => {},
    );
    const error = mock<(message: string) => void>(() => {});
    const upload = mock(async (file: File) => `/tmp/${file.name}`);
    let status = "working";
    let stateSeq = 1;
    let open = true;
    let accessoriesVisible = true;
    const render = () =>
      React.act(async () =>
        root.render(
          <div className="mobile-bottom-bar">
            <div className="mobile-bottom-input">
              <TerminalComposer
                draftKey={draftKey}
                agent="codex"
                mode="composer"
                open={open}
                accessoriesVisible={accessoriesVisible}
                submitWarning={agentPromptWarning("codex", status)}
                submitWarningKey={JSON.stringify([
                  agentStateKind(status),
                  stateSeq,
                ])}
                onModeChange={() => {}}
                onFocusDirect={() => {}}
                directDisabled={false}
                shortcutRows={[]}
                onRunShortcut={() => {}}
                onClose={() => {
                  open = false;
                }}
                onSubmit={send}
                onUploadImage={upload}
                onUploadFile={upload}
                onError={error}
              />
            </div>
          </div>,
        ),
      );
    const input = () => container.querySelector("textarea")!;
    const sendButton = () =>
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Send draft to the terminal"]',
      )!;
    const key = (key: string, options: KeyboardEventInit = {}) =>
      React.act(async () => {
        input().dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
            ...options,
          }),
        );
      });
    const compose = (type: string) =>
      React.act(async () => {
        input().dispatchEvent(
          new window.CompositionEvent(type, { bubbles: true }),
        );
      });
    const tick = () =>
      React.act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
    try {
      drafts.writeTerminalComposerDraft(draftKey, "original draft");
      await render();
      expect(
        container.querySelector(".mobile-bottom-input .terminal-composer"),
      ).not.toBeNull();
      expect(input().classList.contains("terminal-composer-input")).toBe(true);
      for (const selector of [
        ".terminal-mobile-direct",
        ".terminal-composer-close",
        '[aria-label="Insert draft into the terminal"]',
      ])
        expect(
          container.querySelector<HTMLButtonElement>(selector)!.hidden,
        ).toBe(false);
      expect(
        container.querySelector<HTMLInputElement>('input[type="file"]')!.accept,
      ).toBe("");
      await key("Enter");
      expect(send).not.toHaveBeenCalled();
      await React.act(async () => sendButton().click());
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      expect(send).not.toHaveBeenCalled();
      await React.act(async () =>
        container
          .querySelector<HTMLButtonElement>(".terminal-composer-close")!
          .click(),
      );
      await render();
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(input().value).toBe("original draft");
      expect(send).not.toHaveBeenCalled();
      open = true;
      await render();
      expect(container.querySelector('[role="alert"]')).toBeNull();
      await React.act(async () => sendButton().click());
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      accessoriesVisible = false;
      await render();
      expect(container.querySelector('[role="alert"]')).toBeNull();
      accessoriesVisible = true;
      await render();
      expect(container.querySelector('[role="alert"]')).toBeNull();
      await React.act(async () => sendButton().click());
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      stateSeq++;
      await render();
      expect(container.querySelector('[role="alert"]')).toBeNull();
      await React.act(async () => sendButton().click());
      await React.act(async () =>
        Array.from(container.querySelectorAll("button"))
          .find((button) => button.textContent === "Send anyway")!
          .click(),
      );
      expect(send).toHaveBeenCalledWith("original draft", true);
      expect(drafts.readTerminalComposerDraft(draftKey)).toBe("");
      status = "idle";
      await React.act(async () =>
        drafts.writeTerminalComposerDraft(draftKey, "IME draft"),
      );
      await render();
      await compose("compositionstart");
      await key("Enter", { ctrlKey: true });
      expect(send).toHaveBeenCalledTimes(1);
      await React.act(async () => {
        input().dispatchEvent(
          new window.CompositionEvent("compositionend", { bubbles: true }),
        );
        input().dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: "Enter",
            ctrlKey: true,
            bubbles: true,
          }),
        );
      });
      expect(send).toHaveBeenCalledTimes(1);
      await tick();
      await key("Enter", { ctrlKey: true, repeat: true });
      expect(send).toHaveBeenCalledTimes(1);
      await React.act(async () => root.render(null));
      await render();
      expect(input().value).toBe("IME draft");
      await React.act(async () => sendButton().click());
      expect(send).toHaveBeenLastCalledWith("IME draft", true);
      // Async image paths must wait until native IME input has committed.
      let finishUpload!: (path: string) => void;
      upload.mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            finishUpload = resolve;
          }),
      );
      const picker =
        container.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(picker, "files", {
        configurable: true,
        value: [new File(["image"], "photo.png", { type: "image/png" })],
      });
      await React.act(async () =>
        picker.dispatchEvent(new window.Event("change", { bubbles: true })),
      );
      expect(drafts.terminalComposerUploadCount(draftKey)).toBe(1);
      await compose("compositionstart");
      await React.act(async () => finishUpload("/tmp/photo.png"));
      expect(drafts.readTerminalComposerDraft(draftKey)).toBe("");
      expect(drafts.terminalComposerUploadCount(draftKey)).toBe(1);
      await compose("compositionend");
      await tick();
      expect(drafts.readTerminalComposerDraft(draftKey)).toContain(
        "/tmp/photo.png",
      );
      expect(drafts.terminalComposerUploadCount(draftKey)).toBe(0);
      const pastedImage = new File(["image"], "clipboard.png", {
        type: "image/png",
      });
      const paste = new window.Event("paste", {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(paste, "clipboardData", {
        value: { files: [pastedImage], items: [] },
      });
      await React.act(async () => input().dispatchEvent(paste));
      expect(paste.defaultPrevented).toBe(true);
      expect(upload).toHaveBeenLastCalledWith(pastedImage);
      expect(drafts.readTerminalComposerDraft(draftKey)).toContain(
        "/tmp/clipboard.png",
      );
      const textPaste = new window.Event("paste", {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(textPaste, "clipboardData", {
        value: {
          files: [new File(["text"], "notes.txt", { type: "text/plain" })],
          items: [],
        },
      });
      const uploadsBefore = upload.mock.calls.length;
      await React.act(async () => input().dispatchEvent(textPaste));
      expect(textPaste.defaultPrevented).toBe(true);
      expect(upload).toHaveBeenCalledTimes(uploadsBefore + 1);
      expect(drafts.readTerminalComposerDraft(draftKey)).toContain(
        "/tmp/notes.txt",
      );
      expect(error).not.toHaveBeenCalled();
    } finally {
      await React.act(async () => root.unmount());
      container.remove();
      await browser.happyDOM.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
}

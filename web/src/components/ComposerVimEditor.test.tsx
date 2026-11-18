import { expect, test } from "bun:test";
import * as React from "react";

if (process.env.ROAMGATE_COMPOSER_VIM_DOM_TEST !== "1") {
  test("Vim message box in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_COMPOSER_VIM_DOM_TEST: "1" },
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
  test("a box a send emptied is back in insert mode", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/" });
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      Text: browser.Text,
      Event: browser.Event,
      KeyboardEvent: browser.KeyboardEvent,
      MutationObserver: browser.MutationObserver,
      getSelection: () => browser.getSelection(),
      requestAnimationFrame: (callback: FrameRequestCallback) =>
        setTimeout(() => callback(0), 0),
      cancelAnimationFrame: (id: number) => clearTimeout(id),
      IS_REACT_ACT_ENVIRONMENT: true,
    }))
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    const { ComposerVimEditor } = await import("./ComposerVimEditor");
    const { getCM, Vim } = await import("@replit/codemirror-vim");
    const { EditorView } = await import("@codemirror/view");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let sent = 0;
    const render = (value: string) =>
      React.act(async () =>
        root.render(
          <ComposerVimEditor
            value={value}
            selection={null}
            placeholder="Message"
            label="Message"
            enterSends
            onChange={() => {}}
            onSelect={() => {}}
            onSubmit={() => sent++}
            onPasteImages={() => {}}
            onComposingChange={() => {}}
          />,
        ),
      );
    await render("hello");
    const view = EditorView.findFromDOM(
      container.querySelector(".cm-editor") as HTMLElement,
    )!;
    const cm = getCM(view)!;
    const insert = () => !!cm.state.vim?.insertMode;
    view.contentDOM.dispatchEvent(new Event("focus"));
    expect(insert()).toBe(true);
    Vim.handleKey(cm, "<Esc>", "user");
    expect(insert()).toBe(false);
    // :w from normal mode sends; the draft then comes back empty.
    Vim.handleEx(cm as Parameters<typeof Vim.handleEx>[0], "w");
    expect(sent).toBe(1);
    await render("");
    expect(view.state.doc.toString()).toBe("");
    expect(insert()).toBe(true);
    // Text from elsewhere (an upload, the terminal's box) leaves the mode.
    Vim.handleKey(cm, "<Esc>", "user");
    await render("from the terminal");
    expect(insert()).toBe(false);
    await React.act(async () => root.unmount());
  });

  test("Enter in normal mode never adds a line where Enter does not send", async () => {
    const { ComposerVimEditor } = await import("./ComposerVimEditor");
    const { getCM, Vim } = await import("@replit/codemirror-vim");
    const { EditorView } = await import("@codemirror/view");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let sent = 0;
    await React.act(async () =>
      root.render(
        <ComposerVimEditor
          value={"first\nsecond"}
          selection={null}
          placeholder="Message"
          label="Message"
          enterSends={false}
          onChange={() => {}}
          onSelect={() => {}}
          onSubmit={() => sent++}
          onPasteImages={() => {}}
          onComposingChange={() => {}}
        />,
      ),
    );
    const view = EditorView.findFromDOM(
      container.querySelector(".cm-editor") as HTMLElement,
    )!;
    const cm = getCM(view)!;
    const enter = () =>
      view.contentDOM.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    view.contentDOM.dispatchEvent(new Event("focus"));
    // Insert mode: a line, as a touch screen's Enter adds.
    enter();
    expect(view.state.doc.toString()).toBe("first\nsecond\n");
    Vim.handleKey(cm, "<Esc>", "user");
    // Normal mode: Vim's Enter (to the next line), the text as it was.
    enter();
    expect(view.state.doc.toString()).toBe("first\nsecond\n");
    expect(cm.state.vim?.insertMode).toBeFalsy();
    expect(sent).toBe(0);
    await React.act(async () => root.unmount());
  });
}

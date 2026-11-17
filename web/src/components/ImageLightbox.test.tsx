import { expect, test } from "bun:test";
import * as React from "react";

if (process.env.ROAMGATE_IMAGE_LIGHTBOX_DOM_TEST !== "1") {
  test("image lightbox in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_IMAGE_LIGHTBOX_DOM_TEST: "1" },
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
  test("the close button has the focus once the image shows", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/" });
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      HTMLDialogElement: browser.HTMLDialogElement,
      Element: browser.Element,
      Node: browser.Node,
      Event: browser.Event,
      KeyboardEvent: browser.KeyboardEvent,
      IS_REACT_ACT_ENVIRONMENT: true,
    }))
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    // A browser's showModal() runs the dialog focusing steps: the focus
    // goes to the first control, unless one has the autofocus attribute.
    browser.HTMLDialogElement.prototype.showModal = function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute("open", "");
      const target =
        this.querySelector<HTMLElement>("[autofocus]") ??
        this.querySelector<HTMLElement>("a[href], button");
      target?.focus();
    };
    const { ImageLightbox } = await import("./ImageLightbox");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(async () =>
      root.render(
        <ImageLightbox
          src="blob:http://localhost/one"
          name="screenshot.png"
          onClose={() => {}}
        />,
      ),
    );
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close");
    await React.act(async () => root.unmount());
    await browser.happyDOM.close();
  });
}

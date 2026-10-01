import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";
import * as drafts from "../terminalComposer";
import type { TerminalInputMode } from "./TerminalComposer";

// Use real React commits: hook spies cannot reproduce batched completions or
// the browser moving a hidden controlled textarea's selection on value changes.
if (process.env.ROAMGATE_COMPOSER_UPLOAD_DOM_TEST !== "1") {
  test("composer upload regressions in an isolated runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_COMPOSER_UPLOAD_DOM_TEST: "1" },
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
  await registerDomTests();
}

async function registerDomTests() {
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
    localStorage: browser.localStorage,
    sessionStorage: browser.sessionStorage,
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { TerminalComposer } = await import("./TerminalComposer");
  let root: Root | null = null;
  let container: HTMLDivElement;
  let serial = 0;
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    document.body.replaceChildren();
    await browser.happyDOM.whenAsyncComplete();
  });
  afterAll(async () => {
    await browser.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  function deferred() {
    let resolve!: (path: string) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<string>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  }

  async function mount(text = "left SELECT right", start = 5, end = 11) {
    const connection = `upload-dom-${++serial}`;
    drafts.activateTerminalComposerDraftScope(connection, 1);
    const key = drafts.terminalComposerDraftKey(connection, 1, "pane-a");
    drafts.writeTerminalComposerDraft(key, text);
    drafts.writeTerminalComposerSelection(key, start, end);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const uploads: ReturnType<typeof deferred>[] = [];
    const errors: string[] = [];
    const sent: string[] = [];
    const directInput = document.createElement("button");
    document.body.append(directInput);
    let mode: TerminalInputMode = "composer";
    let activeKey = key;
    const upload = () => {
      const pending = deferred();
      uploads.push(pending);
      return pending.promise;
    };
    const render = () =>
      root!.render(
        createElement(TerminalComposer, {
          draftKey: activeKey,
          mode,
          onModeChange: (next) => {
            mode = next;
            render();
          },
          onFocusDirect: () => directInput.focus(),
          directDisabled: false,
          shortcutRows: [],
          onRunShortcut: () => {},
          onClose: () => {},
          onSubmit: async (value) => {
            sent.push(value);
          },
          onUploadImage: upload,
          onUploadFile: upload,
          onError: (message) => errors.push(message),
        }),
      );
    await act(async () => render());
    const textarea = () => container.querySelector("textarea")!;
    const paste = async () => {
      await act(async () => {
        const event = new browser.Event("paste", {
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(event, "clipboardData", {
          value: {
            items: [
              {
                kind: "file",
                type: "image/png",
                getAsFile: () =>
                  new browser.File(["x"], "a.png", { type: "image/png" }),
              },
            ],
          },
        });
        textarea().dispatchEvent(event as unknown as Event);
      });
    };
    const setMode = async (next: TerminalInputMode) => {
      await act(async () => {
        container
          .querySelector<HTMLInputElement>(`input[value="${next}"]`)!
          .dispatchEvent(
            new browser.MouseEvent("click", {
              bubbles: true,
              cancelable: true,
              detail: 1,
            }) as unknown as MouseEvent,
          );
      });
    };
    const select = async (start: number, end = start) => {
      await act(async () => {
        textarea().focus();
        textarea().setSelectionRange(start, end);
        textarea().dispatchEvent(
          new browser.KeyboardEvent("keyup", {
            key: "ArrowLeft",
            bubbles: true,
          }) as unknown as KeyboardEvent,
        );
      });
    };
    const edit = async (value: string, caret: number) => {
      await act(async () => {
        textarea().focus();
        // Bypass React's value tracker just as native typing does.
        Object.getOwnPropertyDescriptor(
          browser.HTMLTextAreaElement.prototype,
          "value",
        )!.set!.call(textarea(), value);
        textarea().setSelectionRange(caret, caret);
        textarea().dispatchEvent(
          new browser.Event("input", { bubbles: true }) as unknown as Event,
        );
      });
    };
    const remount = async () => {
      await act(async () => root!.unmount());
      root = createRoot(container);
      await act(async () => render());
    };
    const switchDraft = async (next: string) => {
      activeKey = next;
      await act(async () => render());
    };
    return {
      key,
      connection,
      uploads,
      errors,
      sent,
      textarea,
      paste,
      setMode,
      select,
      edit,
      remount,
      switchDraft,
      directInput,
    };
  }

  for (const mode of ["composer", "direct"] as const) {
    for (const batched of [false, true]) {
      test(`${mode}: ${batched ? "batched" : "separate"} uploads retain both paths and the unselected suffix`, async () => {
        const h = await mount("left REALLY_LONG_SELECTED_SPAN right", 5, 30);
        await h.paste();
        await h.paste();
        await h.setMode(mode);
        if (batched) {
          await act(async () => {
            h.uploads[0].resolve("/A.png");
            h.uploads[1].resolve("/B.png");
          });
        } else {
          await act(async () => h.uploads[0].resolve("/A.png"));
          await act(async () => h.uploads[1].resolve("/B.png"));
        }
        expect(drafts.readTerminalComposerDraft(h.key)).toBe(
          "left /A.png /B.png  right",
        );
        expect(drafts.readTerminalComposerSelection(h.key)).toEqual({
          start: 19,
          end: 19,
        });
        expect(drafts.terminalComposerUploadCount(h.key)).toBe(0);
        if (mode === "direct")
          expect(document.activeElement).toBe(h.directInput);
        await h.setMode("composer");
        expect(h.textarea().selectionStart).toBe(19);
        expect(h.sent).toEqual([]);
      });
    }
  }

  test("a stale selection event before React commits cannot roll back an inserted caret", async () => {
    const h = await mount();
    await h.select(5, 11);
    await h.paste();
    await h.paste();
    await act(async () => {
      h.uploads[0].resolve("/A.png");
      await Promise.resolve();
      expect(drafts.readTerminalComposerDraft(h.key)).toBe(
        "left /A.png  right",
      );
      expect(h.textarea().value).toBe("left SELECT right");
      h.textarea().setSelectionRange(0, 0);
      h.textarea().dispatchEvent(
        new browser.KeyboardEvent("keyup", {
          key: "ArrowLeft",
          bubbles: true,
        }) as unknown as KeyboardEvent,
      );
      h.uploads[1].resolve("/B.png");
    });
    expect(drafts.readTerminalComposerDraft(h.key)).toBe(
      "left /A.png /B.png  right",
    );
  });

  test("identical paths completed together still insert twice", async () => {
    const h = await mount();
    await h.paste();
    await h.paste();
    await act(async () => {
      h.uploads[0].resolve("/same.png");
      h.uploads[1].resolve("/same.png");
    });
    expect(drafts.readTerminalComposerDraft(h.key)).toBe(
      "left /same.png /same.png  right",
    );
  });

  test("reverse completion order uses the latest typed draft and moved caret", async () => {
    const h = await mount();
    await h.paste();
    await h.paste();
    await h.edit("new text remains", 3);
    expect(drafts.readTerminalComposerDraft(h.key)).toBe("new text remains");
    await h.select(4, 8);
    expect(drafts.readTerminalComposerSelection(h.key)).toEqual({
      start: 4,
      end: 8,
    });
    await act(async () => {
      h.uploads[1].resolve("/B.png");
      h.uploads[0].resolve("/A.png");
    });
    expect(drafts.readTerminalComposerDraft(h.key)).toBe(
      "new /B.png /A.png  remains",
    );
    expect(h.sent).toEqual([]);
  });

  test("an older mount's uploads follow the remount's live selection", async () => {
    const h = await mount();
    await h.paste();
    await h.paste();
    await h.remount();
    await h.select(0);
    await act(async () => {
      h.uploads[0].resolve("/A.png");
      h.uploads[1].resolve("/B.png");
    });
    expect(drafts.readTerminalComposerDraft(h.key)).toBe(
      "/A.png  /B.png  left SELECT right",
    );
    expect(h.textarea().selectionStart).toBe(16);
  });

  test("switching panes keeps late uploads in their original draft", async () => {
    const h = await mount();
    await h.paste();
    const next = drafts.terminalComposerDraftKey(h.connection, 1, "pane-b");
    drafts.writeTerminalComposerDraft(next, "other pane");
    await h.switchDraft(next);
    await act(async () => h.uploads[0].resolve("/A.png"));
    expect(drafts.readTerminalComposerDraft(h.key)).toBe("left /A.png  right");
    expect(h.textarea().value).toBe("other pane");
    expect(drafts.readTerminalComposerDraft(next)).toBe("other pane");
  });

  for (const retire of ["scope", "pane"] as const) {
    test(`${retire} retirement discards late uploads without restoring a draft`, async () => {
      const h = await mount();
      await h.paste();
      await act(async () => {
        if (retire === "scope")
          drafts.activateTerminalComposerDraftScope(h.connection, 2);
        else drafts.clearTerminalComposerDrafts(h.connection, 1, ["pane-a"]);
      });
      await act(async () => h.uploads[0].resolve("/A.png"));
      expect(drafts.readTerminalComposerDraft(h.key)).toBe("");
      expect(drafts.terminalComposerUploadCount(h.key)).toBe(0);
    });
  }

  test("failed upload leaves selection and draft available to the next completion", async () => {
    const h = await mount();
    await h.paste();
    await h.paste();
    await h.setMode("direct");
    await act(async () => h.uploads[0].reject(new Error("Upload failed")));
    expect(drafts.readTerminalComposerDraft(h.key)).toBe("left SELECT right");
    expect(drafts.terminalComposerUploadCount(h.key)).toBe(1);
    await act(async () => h.uploads[1].resolve("/B.png"));
    expect(drafts.readTerminalComposerDraft(h.key)).toBe("left /B.png  right");
    expect(h.errors).toEqual(["Upload failed"]);
  });
}

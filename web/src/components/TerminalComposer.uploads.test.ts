import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";
import * as drafts from "../terminalComposer";
import { defaultMobileTerminalShortcutRows } from "../mobileTerminalShortcuts";
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
    document.documentElement.classList.remove("keyboard-open");
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

  async function mount(
    text = "left SELECT right",
    start = 5,
    end = 11,
    shortcuts = false,
    agent?: string,
  ) {
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
          agent,
          shortcutRows: shortcuts ? defaultMobileTerminalShortcutRows() : [],
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

  test("dock actions and async completions leave the editor blurred", async () => {
    const h = await mount("left SELECT right", 5, 11, true);
    const dock = container.querySelector<HTMLElement>(".terminal-composer")!;
    await act(async () => dock.focus());
    expect(document.activeElement).toBe(dock);
    await h.setMode("direct");
    expect(document.activeElement).toBe(h.directInput);
    await h.setMode("composer");
    expect(document.activeElement).not.toBe(h.textarea());

    await h.select(5, 11);
    await h.paste();
    const shortcut = container.querySelector<HTMLButtonElement>(
      ".terminal-composer-shortcuts button",
    )!;
    const touch = (target: Element) =>
      target.dispatchEvent(
        new browser.PointerEvent("pointerdown", {
          bubbles: true,
          pointerType: "touch",
        }) as unknown as PointerEvent,
      );
    document.documentElement.classList.add("keyboard-open");
    await act(async () => touch(shortcut));
    expect(document.activeElement).toBe(h.textarea());
    document.documentElement.classList.remove("keyboard-open");
    await act(async () => touch(h.textarea()));
    expect(document.activeElement).toBe(h.textarea());
    await act(async () => touch(h.directInput));
    expect(document.activeElement).not.toBe(h.textarea());
    await h.select(5, 11);
    await act(async () => touch(shortcut));
    expect(document.activeElement).not.toBe(h.textarea());
    await act(async () => {
      dock.focus();
      dock.dispatchEvent(
        new browser.Event("scroll", {
          bubbles: true,
        }) as unknown as Event,
      );
      shortcut.click();
      container
        .querySelector<HTMLButtonElement>(
          ".terminal-composer-shortcuts-toggle",
        )!
        .click();
    });
    expect(document.activeElement).toBe(dock);
    await act(async () => h.uploads[0].resolve("/A.png"));
    expect(document.activeElement).toBe(dock);
    expect(h.textarea().value).toBe("left /A.png  right");
    expect([h.textarea().selectionStart, h.textarea().selectionEnd]).toEqual([
      12, 12,
    ]);

    const send = container.querySelector<HTMLButtonElement>(
      '[aria-label="Send draft to the terminal"]',
    )!;
    await act(async () => {
      send.focus();
      send.click();
    });
    expect(h.sent).toEqual(["left /A.png  right"]);
    expect(document.activeElement).not.toBe(h.textarea());
    await h.select(0);
    expect(document.activeElement).toBe(h.textarea());
  });

  test("commands preserve active editing and otherwise return focus to Commands", async () => {
    const h = await mount("", 0, 0, false, "codex");
    const commands = container.querySelector<HTMLButtonElement>(
      ".terminal-composer-commands-toggle",
    )!;
    await act(async () => commands.click());
    expect(document.activeElement).toBe(
      container.querySelector(".terminal-composer-commands"),
    );
    const chooseFirst = () =>
      container
        .querySelector<HTMLButtonElement>(
          ".terminal-composer-command-list button",
        )!
        .click();
    await act(async () => chooseFirst());
    expect(h.textarea().value).toBe("/model ");
    expect([h.textarea().selectionStart, h.textarea().selectionEnd]).toEqual([
      7, 7,
    ]);
    expect(document.activeElement).toBe(commands);

    await h.edit("/", 1);
    await act(async () => chooseFirst());
    expect(h.textarea().value).toBe("/model ");
    expect(document.activeElement).toBe(h.textarea());
    expect([h.textarea().selectionStart, h.textarea().selectionEnd]).toEqual([
      7, 7,
    ]);
    expect(h.sent).toEqual([]);
  });

  test("other-tab shortcut visibility changes preserve the active draft and caret", async () => {
    const key = "roamgate:terminalComposerShortcutsOpen.v1";
    browser.localStorage.removeItem(key);
    const h = await mount("left SELECT right", 5, 11, true);
    await h.select(5, 11);
    const editor = h.textarea();
    const panel = () =>
      container.querySelector<HTMLElement>(".terminal-composer-shortcuts")!;
    const change = async (value: string | null) => {
      if (value === null) browser.localStorage.removeItem(key);
      else browser.localStorage.setItem(key, value);
      await act(async () => {
        const event = new browser.StorageEvent("storage", {
          key,
          newValue: value ?? undefined,
          storageArea: browser.localStorage,
        });
        Object.defineProperty(event, "newValue", { value });
        browser.dispatchEvent(event);
      });
    };
    expect(panel().hidden).toBe(false);
    await change("false");
    expect(panel().hidden).toBe(true);
    expect(h.textarea()).toBe(editor);
    expect(document.activeElement).toBe(editor);
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([5, 11]);
    expect(drafts.readTerminalComposerDraft(h.key)).toBe("left SELECT right");
    expect(h.sent).toEqual([]);
    await change(null);
    expect(panel().hidden).toBe(false);
  });

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

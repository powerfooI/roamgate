import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { installTerminalCompositionRepair } from "./terminalComposition";

// Bypass TerminalView's public-entry-point mock: exercise Vite's shipped bundle.
// @ts-expect-error xterm only declares its public entry point.
import { Terminal } from "@xterm/xterm/lib/xterm.mjs";

function withTerminal(
  run: (harness: {
    terminal: any;
    core: any;
    helper: any;
    textarea: HTMLTextAreaElement;
    output: string[];
    start(value?: string, selection?: number): void;
    update(value: string, selection?: number): void;
    end(): void;
    key(code: number, key: string): void;
    flush(): void;
    staleCallbacks(): void;
    repair: ReturnType<typeof installTerminalCompositionRepair>;
  }) => void,
  install = true,
) {
  const documentDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  const windowDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "window",
  );
  const originalTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const browser = new Window();
  Object.defineProperty(globalThis, "document", {
    value: browser.document,
    configurable: true,
  });
  Object.defineProperty(globalThis, "window", {
    value: browser,
    configurable: true,
  });
  browser.HTMLCanvasElement.prototype.getContext = (() => ({
    measureText: () => ({ width: 8 }),
  })) as never;
  const terminal = new Terminal();
  let repair = { installed: false, dispose() {} };
  try {
    terminal.open(browser.document.body);
    const core = terminal._core;
    const helper = core._compositionHelper;
    const textarea = terminal.textarea as HTMLTextAreaElement;
    helper.updateCompositionElements = () => {};
    const output: string[] = [];
    terminal.onData((data: string) => output.push(data));
    let id = 0;
    const pending = new Map<number, () => void>();
    const allCallbacks: (() => void)[] = [];
    const schedule = (callback: () => void) => {
      pending.set(++id, callback);
      allCallbacks.push(callback);
      return id;
    };
    globalThis.setTimeout = schedule as never;
    globalThis.clearTimeout = ((timer: number) =>
      pending.delete(timer)) as never;
    browser.setTimeout = schedule as never;
    browser.clearTimeout = globalThis.clearTimeout as never;
    repair = install ? installTerminalCompositionRepair(terminal) : repair;
    if (install) expect(repair.installed).toBe(true);
    const mutate = (value: string, selection = value.length) => {
      textarea.value = value;
      textarea.setSelectionRange(selection, selection);
    };
    run({
      terminal,
      core,
      helper,
      textarea,
      output,
      repair,
      start(value = textarea.value, selection = value.length) {
        mutate(value, selection);
        helper.compositionstart();
      },
      update(value, selection = value.length) {
        mutate(value, selection);
        helper.compositionupdate({ data: value });
      },
      end() {
        helper.compositionend();
      },
      key(code, key) {
        core._keyDown(
          new browser.KeyboardEvent("keydown", {
            keyCode: code,
            key,
            bubbles: true,
            cancelable: true,
          }),
        );
      },
      flush() {
        while (pending.size) {
          const [timer, callback] = pending.entries().next().value!;
          pending.delete(timer);
          callback();
        }
      },
      staleCallbacks() {
        for (const callback of allCallbacks) callback();
      },
    });
  } finally {
    repair.dispose();
    globalThis.setTimeout = originalTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    terminal.dispose();
    void browser.happyDOM.abort();
    if (documentDescriptor)
      Object.defineProperty(globalThis, "document", documentDescriptor);
    else Reflect.deleteProperty(globalThis, "document");
    if (windowDescriptor)
      Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

const text = "\u4e2d\u6587";

describe("pinned xterm composition repair", () => {
  test("proves the shipped core duplicates Space finalization without repair", () => {
    withTerminal((h) => {
      h.start();
      h.update(text);
      h.flush();
      h.key(32, " ");
      h.end();
      h.flush();
      expect(h.output).toEqual([text, text]);
    }, false);
  });

  for (const [code, key] of [
    [32, " "],
    [13, "Enter"],
    [229, "Process"],
  ] as const) {
    test(`commits once through actual core keydown ${key}`, () => {
      withTerminal((h) => {
        h.start();
        h.update(text);
        h.flush();
        h.key(code, key);
        h.end();
        h.flush();
        expect(h.output).toEqual(code === 13 ? [text, "\r"] : [text]);
      });
    });
  }

  test("click confirmation and repeated identical compositions stay independent", () => {
    withTerminal((h) => {
      h.start();
      h.update(text);
      h.end();
      h.flush();
      h.start("", 0);
      h.update(text);
      h.end();
      h.flush();
      expect(h.output).toEqual([text, text]);
    });
  });

  test("accounts only the emitted prefix when final text gains a suffix", () => {
    withTerminal((h) => {
      h.start();
      h.update(text);
      h.flush();
      h.key(32, " ");
      h.update(`${text}!`);
      h.end();
      h.flush();
      expect(h.output).toEqual([text, "!"]);
    });
  });

  test("cancels delayed finalization before an immediate send and late end", () => {
    withTerminal((h) => {
      h.start();
      h.update(text);
      h.flush();
      h.end();
      h.key(32, " ");
      h.end();
      h.flush();
      h.staleCallbacks();
      expect(h.output).toEqual([text]);
    });
  });

  test("two immediate finalizations send only the new suffix", () => {
    withTerminal((h) => {
      h.start();
      h.update(text);
      h.flush();
      h.key(32, " ");
      h.update(`${text}!`);
      h.flush();
      h.end();
      h.key(32, " ");
      h.end();
      h.flush();
      expect(h.output).toEqual([text, "!"]);
    });
  });

  test("settles the old session before a new start and ignores old callbacks", () => {
    withTerminal((h) => {
      h.start();
      h.update(text);
      h.end();
      h.start(text);
      h.update(text + text);
      h.end();
      h.flush();
      h.staleCallbacks();
      expect(h.output).toEqual([text, text]);
    });
  });

  test("preserves a replaced selection and pre-existing suffix", () => {
    withTerminal((h) => {
      h.textarea.value = "abcTAIL";
      h.textarea.setSelectionRange(0, 3);
      h.helper.compositionstart();
      h.update(`${text}TAIL`, text.length);
      h.flush();
      h.key(32, " ");
      h.end();
      h.flush();
      expect(h.output).toEqual([text]);
    });
  });

  test("cancellation with no committed text emits nothing", () => {
    withTerminal((h) => {
      h.start();
      h.update(text);
      h.flush();
      h.textarea.value = "";
      h.end();
      h.flush();
      expect(h.output).toEqual([]);
    });
  });

  test("following physical keypress and identical paste are not filtered", () => {
    withTerminal((h) => {
      h.start();
      h.update(text);
      h.flush();
      h.key(32, " ");
      h.end();
      h.flush();
      h.key(32, " ");
      h.core._keyPress({
        type: "keypress",
        charCode: 32,
        keyCode: 32,
        which: 32,
        preventDefault() {},
        stopPropagation() {},
      });
      h.terminal.paste(text);
      expect(h.output).toEqual([text, " ", text]);
    });
  });

  test("accounts for multiple key229 fallback cycles before late compositionend", () => {
    withTerminal((h) => {
      h.start();
      h.update(text);
      h.flush();
      h.key(32, " ");
      h.key(229, "Process");
      h.textarea.value += "1";
      h.flush();
      h.key(229, "Process");
      h.textarea.value += "2";
      h.flush();
      h.end();
      h.flush();
      expect(h.output).toEqual([text, "1", "2"]);
    });
  });

  test("leaves non-composition fallback deletion and replacement unchanged", () => {
    withTerminal((h) => {
      h.textarea.value = "ab";
      h.key(229, "Process");
      h.textarea.value = "a";
      h.flush();
      h.key(229, "Process");
      h.textarea.value = "b";
      h.flush();
      expect(h.output).toEqual(["\x7f", "b"]);
    });
  });

  test("rebases after fallback deletion before a late compositionend", () => {
    withTerminal((h) => {
      h.start();
      h.update(text);
      h.flush();
      h.key(32, " ");
      h.key(229, "Process");
      h.textarea.value = text.slice(0, 1);
      h.flush();
      h.key(229, "Process");
      h.textarea.value += "12";
      h.flush();
      h.end();
      h.flush();
      expect(h.output).toEqual([text, "\x7f", "12"]);
    });
  });

  for (const removed of [2, 4]) {
    for (const suffix of ["", "TAIL"]) {
      test(`pinned fallback deletes ${removed} characters with one DEL and preserves late replacement (suffix=${suffix})`, () => {
        withTerminal((h) => {
          const committed = "\u4e2d\u6587\u8f93\u5165";
          const remaining = committed.slice(0, -removed);
          const replacement = "\u65b0";
          h.start(suffix, 0);
          h.update(`${committed}${suffix}`, committed.length);
          h.flush();
          h.key(32, " ");
          h.key(229, "Process");
          h.textarea.value = `${remaining}${suffix}`;
          h.flush();
          // Assert the actual pinned helper's protocol, not an injected DEL.
          expect(h.output).toEqual([committed, "\x7f"]);
          // The replacement arrives before compositionend, without a second
          // key229 fallback, so finalization must emit its unconsumed range.
          h.update(`${remaining}${replacement}${suffix}`, remaining.length + 1);
          h.end();
          h.flush();
          expect(h.output).toEqual([committed, "\x7f", replacement]);
        });
      });
    }
  }

  test("deletion rebase excludes the pre-existing composition suffix", () => {
    withTerminal((h) => {
      h.start("TAIL", 0);
      h.update(`${text}TAIL`, text.length);
      h.flush();
      h.key(32, " ");
      h.key(229, "Process");
      h.textarea.value = `${text.slice(0, 1)}TAIL`;
      h.flush();
      h.update(`${text.slice(0, 1)}!TAIL`, 2);
      h.end();
      h.flush();
      expect(h.output).toEqual([text, "\x7f", "!"]);
    });
  });

  test("dispose cancels queued data and restores upstream methods", () => {
    withTerminal((h) => {
      h.start();
      h.update(text);
      h.end();
      h.repair.dispose();
      h.flush();
      h.staleCallbacks();
      expect(h.output).toEqual([]);
    });
  });

  test("missing private shape is a no-op", () => {
    const repair = installTerminalCompositionRepair({ _core: {} });
    expect(repair.installed).toBe(false);
    repair.dispose();
  });
});

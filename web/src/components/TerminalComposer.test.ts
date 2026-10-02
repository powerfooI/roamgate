import { expect, mock, spyOn, test } from "bun:test";
import { Keyboard, SquareTerminal } from "lucide-react";
import * as React from "react";
import * as ReactDOM from "react-dom";
import * as drafts from "../terminalComposer";
import { defaultMobileTerminalShortcutRows } from "../mobileTerminalShortcuts";
import { terminalComposerCommands } from "../terminalComposerCommands";
import { TerminalComposer, type TerminalInputMode } from "./TerminalComposer";

type Element = React.ReactElement<Record<string, unknown>>;
type Host = {
  focus: () => void;
  value: string;
  selectionStart: number;
  selectionEnd: number;
  setSelectionRange: (start: number, end: number) => void;
  style: { height: string };
  scrollHeight: number;
  children: never[];
};

// Exercise the component's actual handlers and rendered ARIA props with the
// repository's hook-spy pattern. Browser focus/IME behavior is checked separately.
test.each(["claude", "grok-build", "agy"])(
  "%s commands own focus, preserve drafts until confirmed, and never send",
  async (agent) => {
    let currentAgent: string | undefined = agent;
    let mode: TerminalInputMode = "composer";
    let directDisabled = false;
    const modeChoices: TerminalInputMode[] = [];
    let draft = "keep this draft";
    let listener: ((text: string) => void) | undefined;
    const onSubmit = mock<(text: string, submit: boolean) => Promise<void>>(
      async () => {},
    );
    const onRunShortcut = mock(() => {});
    const directInput = {};
    const onFocusDirect = mock(() => {
      activeElement = directInput;
    });
    const onError = mock(() => {});
    const shortcutRows = defaultMobileTerminalShortcutRows();
    const nodes = new Map<string, Host>();
    let activeElement: Host | object = {};
    const previousDocument = Object.getOwnPropertyDescriptor(
      globalThis,
      "document",
    );
    const previousStorage = Object.getOwnPropertyDescriptor(
      globalThis,
      "localStorage",
    );
    const shortcutsStorageKey = "roamgate:terminalComposerShortcutsOpen.v1";
    const savedValues = new Map<string, string>();
    let storageWriteFails = false;
    const writeStorage = mock((key: string, value: string) => {
      if (storageWriteFails) throw new Error("Storage unavailable");
      savedValues.set(key, value);
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => savedValues.get(key) ?? null,
        setItem: writeStorage,
      },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        get activeElement() {
          return activeElement;
        },
      },
    });

    const states: unknown[] = [];
    const refs: React.RefObject<unknown>[] = [];
    type Effect = {
      run: React.EffectCallback;
      deps?: React.DependencyList;
      cleanup?: () => void;
    };
    let effects: Effect[] = [];
    let nextEffects: Effect[] = [];
    let stateIndex = 0;
    let refIndex = 0;
    let dirty = false;
    let elements: Element[] = [];
    let boundRefs: React.RefObject<unknown>[] = [];
    const spies = [
      spyOn(React, "useSyncExternalStore").mockImplementation(
        (_subscribe, snapshot) => snapshot(),
      ),
      spyOn(React, "useId").mockReturnValue("commands-test"),
      spyOn(React, "useState").mockImplementation(
        <S>(
          initial?: S | (() => S),
        ): [S, React.Dispatch<React.SetStateAction<S>>] => {
          const index = stateIndex++;
          if (!(index in states))
            states[index] =
              typeof initial === "function" ? (initial as () => S)() : initial;
          // Hook slots hold different state types; each render reuses the same slot.
          return [
            states[index] as S,
            (value) => {
              const next =
                typeof value === "function"
                  ? (value as (previous: S) => S)(states[index] as S)
                  : value;
              if (!Object.is(states[index], next)) {
                states[index] = next;
                dirty = true;
              }
            },
          ];
        },
      ),
      spyOn(React, "useRef").mockImplementation(
        (current) => refs[refIndex++] ?? (refs[refIndex - 1] = { current }),
      ),
      spyOn(React, "useEffect").mockImplementation((run, deps) => {
        nextEffects.push({ run, deps });
      }),
      spyOn(ReactDOM, "flushSync").mockImplementation((callback) => {
        const result = callback?.();
        render();
        return result;
      }),
      // Isolate the shared store from other test files while retaining its
      // write-through subscription contract (covered in terminalComposer.test.ts).
      spyOn(drafts, "readTerminalComposerDraft").mockImplementation(
        () => draft,
      ),
      spyOn(drafts, "writeTerminalComposerDraft").mockImplementation(
        (_key, text) => {
          draft = text;
          listener?.(text);
        },
      ),
      spyOn(drafts, "clearTerminalComposerDraft").mockImplementation(() => {
        draft = "";
        listener?.("");
      }),
      spyOn(drafts, "subscribeTerminalComposerDraft").mockImplementation(
        (_key, callback) => {
          listener = callback;
          return () => {
            listener = undefined;
          };
        },
      ),
      spyOn(drafts, "readTerminalComposerSelection").mockReturnValue(null),
      spyOn(drafts, "writeTerminalComposerSelection").mockImplementation(
        () => {},
      ),
      spyOn(drafts, "beginTerminalComposerSubmission").mockReturnValue(true),
    ];

    function visit(node: React.ReactNode) {
      React.Children.forEach(node, (child) => {
        if (!React.isValidElement<Record<string, unknown>>(child)) return;
        elements.push(child);
        const ref = child.props.ref as React.RefObject<unknown> | undefined;
        if (ref && typeof ref === "object") {
          const key = String(
            child.props.className ??
              child.props["aria-label"] ??
              (typeof child.props.children === "string"
                ? child.props.children
                : child.type),
          );
          let host = nodes.get(key);
          if (!host) {
            host = {
              value: "",
              selectionStart: 0,
              selectionEnd: 0,
              focus() {
                activeElement = nodes.get(key)!;
              },
              setSelectionRange(start, end) {
                this.selectionStart = start;
                this.selectionEnd = end;
              },
              style: { height: "" },
              scrollHeight: 38,
              children: [],
            };
            nodes.set(key, host);
          }
          if (typeof child.props.value === "string")
            host.value = child.props.value;
          ref.current = host;
          boundRefs.push(ref);
        }
        visit(child.props.children as React.ReactNode);
      });
    }

    function render() {
      for (let pass = 0; pass < 10; pass++) {
        dirty = false;
        stateIndex = refIndex = 0;
        nextEffects = [];
        elements = [];
        for (const ref of boundRefs) ref.current = null;
        boundRefs = [];
        visit(
          TerminalComposer({
            draftKey: "command-interaction",
            mode,
            onModeChange(next, remember) {
              if (remember) modeChoices.push(next);
              mode = next;
              dirty = true;
            },
            onFocusDirect,
            directDisabled,
            agent: currentAgent,
            shortcutRows,
            onRunShortcut,
            onClose() {},
            onSubmit,
            onUploadImage: async () => "/tmp/image.png",
            onUploadFile: async () => "/tmp/file.txt",
            onError,
          }),
        );
        const previous = effects;
        effects = nextEffects;
        effects.forEach((effect, index) => {
          const old = previous[index];
          if (
            old &&
            effect.deps &&
            old.deps &&
            effect.deps.length === old.deps.length &&
            effect.deps.every((dep, i) => Object.is(dep, old.deps?.[i]))
          ) {
            effect.cleanup = old.cleanup;
          } else {
            old?.cleanup?.();
            effect.cleanup = effect.run() || undefined;
          }
        });
        if (!dirty) return;
      }
      throw new Error("Composer did not settle");
    }
    function find(prop: string, value: unknown) {
      const element = elements.find(
        (candidate) => candidate.props[prop] === value,
      );
      if (!element) throw new Error(`Missing ${prop}=${String(value)}`);
      return element;
    }
    function invoke(element: Element, handler: string, event: unknown = {}) {
      const callback = element.props[handler] as (event: unknown) => void;
      callback(event);
      render();
    }
    function remount() {
      for (const effect of effects) effect.cleanup?.();
      for (const ref of boundRefs) ref.current = null;
      states.length = refs.length = 0;
      effects = [];
      boundRefs = [];
      nodes.clear();
      activeElement = {};
      render();
    }
    function key(element: Element, key: string, isComposing = false) {
      const event = {
        key,
        nativeEvent: { isComposing },
        preventDefault: mock(() => {}),
        stopPropagation: mock(() => {}),
      };
      invoke(element, "onKeyDown", event);
      return event;
    }
    const commands = () =>
      find("className", "terminal-composer-commands-toggle");
    const editor = () => find("aria-label", "Terminal input draft");
    const shortcutToggle = () =>
      find("className", "terminal-composer-shortcuts-toggle");
    const shortcutPanel = () =>
      find("className", "terminal-composer-shortcuts");
    const picker = () => find("className", "terminal-composer-commands");
    const option = () => find("role", "option");
    try {
      render();
      expect(shortcutPanel().props.hidden).toBe(false);
      expect(writeStorage).not.toHaveBeenCalled();
      expect(commands().props["aria-label"]).toBe("Commands");
      expect((commands().props.children as Element).type).toBe(SquareTerminal);
      const textarea = nodes.get("terminal-composer-input")!;
      // Touch while editing: retain focus, and announce browse navigation too.
      textarea.focus();
      invoke(commands(), "onClick", { detail: 1 });
      expect(activeElement).toBe(textarea);
      expect(
        elements.filter((element) => element.props.role === "option").length,
      ).toBe(terminalComposerCommands(agent).length);
      expect(editor().props["aria-expanded"]).toBe(true);
      expect(editor().props["aria-activedescendant"]).toBe("commands-test-0");
      key(editor(), "ArrowDown");
      expect(editor().props["aria-activedescendant"]).toBe("commands-test-1");
      expect(draft).toBe("keep this draft");
      key(editor(), "Escape");
      expect(activeElement).toBe(textarea);
      expect(editor().props["aria-expanded"]).toBe(false);

      // Tab from the focused textarea enters the confirmation, not the actions.
      invoke(commands(), "onClick", { detail: 1 });
      key(editor(), "Tab");
      expect(activeElement).toBe(nodes.get("Cancel")!);
      expect(find("children", "Cancel").props.tabIndex).toBe(0);
      expect(find("children", "Replace draft").props.tabIndex).toBe(0);
      expect(draft).toBe("keep this draft");
      invoke(find("children", "Cancel"), "onClick");
      expect(activeElement).toBe(nodes.get("terminal-composer-commands")!);
      key(picker(), "Escape");

      // Touch without an editor: focus a non-editable group.
      activeElement = {};
      invoke(commands(), "onClick", { detail: 1 });
      const group = nodes.get("terminal-composer-commands")!;
      expect(activeElement).toBe(group);
      expect(picker().props.role).toBe("group");
      expect(picker().props.tabIndex).toBe(-1);
      expect(
        key(picker(), "ArrowDown", true).preventDefault,
      ).not.toHaveBeenCalled();
      key(picker(), "ArrowDown");
      expect(picker().props["aria-activedescendant"]).toBe("commands-test-1");
      key(picker(), "Tab");
      expect(draft).toBe("keep this draft");
      expect(find("aria-label", "Confirm draft replacement")).toBeDefined();
      expect(activeElement).toBe(nodes.get("Cancel")!);
      expect(editor().props["aria-activedescendant"]).toBeUndefined();
      invoke(find("children", "Cancel"), "onClick");
      expect(draft).toBe("keep this draft");
      expect(activeElement).toBe(group);
      key(picker(), "Escape");
      expect(activeElement).toBe(
        nodes.get("terminal-composer-commands-toggle")!,
      );

      // Keyboard activation owns focus without a search field or footer hint.
      invoke(commands(), "onClick", { detail: 0 });
      expect(activeElement).toBe(group);
      expect(
        elements.some(
          (element) =>
            element.type === "input" &&
            element.props.type !== "file" &&
            element.props.type !== "radio",
        ),
      ).toBe(false);
      expect(
        elements.some(
          (element) =>
            element.props.className === "terminal-composer-command-note",
        ),
      ).toBe(false);
      key(picker(), "ArrowDown");
      expect(draft).toBe("keep this draft");
      key(picker(), "Tab");
      invoke(find("children", "Cancel"), "onClick");
      expect(activeElement).toBe(group);
      expect(draft).toBe("keep this draft");
      key(picker(), "Tab");
      invoke(find("children", "Replace draft"), "onClick");
      const selected = terminalComposerCommands(agent)[1];
      expect(draft).toBe(`${selected.name} `);
      expect(activeElement).toBe(textarea);
      expect(textarea.selectionStart).toBe(selected.name.length + 1);

      // A pending confirmation may not discard a draft changed asynchronously.
      invoke(commands(), "onClick", { detail: 0 });
      invoke(option(), "onClick");
      expect(activeElement).toBe(textarea);
      const staleConfirm = find("children", "Replace draft");
      drafts.writeTerminalComposerDraft(
        "command-interaction",
        "new upload or edit",
      );
      invoke(staleConfirm, "onClick");
      expect(draft).toBe("new upload or edit");

      // Agent detection changes only the picker; composing/editor state survives.
      textarea.focus();
      textarea.setSelectionRange(2, 5);
      invoke(editor(), "onCompositionStart");
      currentAgent = undefined;
      render();
      currentAgent = "pi";
      render();
      expect(activeElement).toBe(textarea);
      expect(textarea.selectionStart).toBe(2);
      expect(textarea.selectionEnd).toBe(5);
      expect(draft).toBe("new upload or edit");
      expect(editor().props["aria-expanded"]).toBe(false);
      expect(commands().props.disabled).toBe(true);
      invoke(editor(), "onCompositionEnd");
      expect(commands().props.disabled).toBe(false);

      // A pending command from the previous agent cannot remain in the menu.
      invoke(commands(), "onClick", { detail: 1 });
      invoke(option(), "onClick");
      expect(find("aria-label", "Confirm draft replacement")).toBeDefined();
      currentAgent = "codex";
      render();
      expect(editor().props["aria-expanded"]).toBe(false);
      expect(
        elements.some(
          (element) => element.props.className === "terminal-composer-commands",
        ),
      ).toBe(false);
      expect(activeElement).toBe(textarea);
      expect(draft).toBe("new upload or edit");
      invoke(commands(), "onClick", { detail: 1 });
      expect(
        elements.filter((element) => element.props.role === "option").length,
      ).toBe(terminalComposerCommands("codex").length);
      expect(onSubmit).not.toHaveBeenCalled();
      expect(onRunShortcut).not.toHaveBeenCalled();

      // Native radio switches keep the draft/caret and own touch input focus.
      const changeMode = (next: TerminalInputMode, detail = 1) =>
        invoke(find("value", next), "onChange", { nativeEvent: { detail } });
      textarea.setSelectionRange(2, 5);
      // Hiding both shortcut rows preserves the draft, caret, and native focus.
      expect(shortcutPanel().props.hidden).toBe(false);
      expect((shortcutToggle().props.children as React.ReactElement).type).toBe(
        Keyboard,
      );
      expect(shortcutToggle().props["aria-controls"]).toBe(
        shortcutPanel().props.id,
      );
      const togglePointer = { preventDefault: mock(() => {}) };
      invoke(shortcutToggle(), "onMouseDown", togglePointer);
      expect(togglePointer.preventDefault).toHaveBeenCalledTimes(1);
      invoke(shortcutToggle(), "onClick");
      expect(shortcutToggle().props["aria-expanded"]).toBe(false);
      expect(shortcutPanel().props.hidden).toBe(true);
      expect(activeElement).toBe(textarea);
      expect(draft).toBe("new upload or edit");
      expect(textarea.selectionStart).toBe(2);
      expect(textarea.selectionEnd).toBe(5);
      expect(onSubmit).not.toHaveBeenCalled();
      expect(onRunShortcut).not.toHaveBeenCalled();
      changeMode("direct");
      expect(modeChoices).toEqual(["direct"]);
      expect(find("value", "direct").props.checked).toBe(true);
      expect(editor().props.hidden).toBe(true);
      expect(activeElement).toBe(directInput);
      expect(draft).toBe("new upload or edit");
      expect(shortcutPanel().props.hidden).toBe(true);
      invoke(shortcutToggle(), "onClick");
      expect(shortcutToggle().props["aria-expanded"]).toBe(true);
      expect(shortcutPanel().props.hidden).toBe(false);
      expect(activeElement).toBe(directInput);
      expect(elements.some((element) => element.props.role === "option")).toBe(
        false,
      );
      expect(
        elements.filter(
          (element) =>
            element.props.className === "terminal-composer-shortcut-row",
        ),
      ).toHaveLength(2);
      expect(
        elements.filter(
          (element) =>
            element.props.className === "terminal-composer-shortcut-spacer",
        ),
      ).toHaveLength(shortcutRows.flat().filter((slot) => !slot).length);
      changeMode("composer");
      expect(activeElement).toBe(textarea);
      expect(textarea.selectionStart).toBe(2);
      expect(textarea.selectionEnd).toBe(5);
      expect(draft).toBe("new upload or edit");
      // Keyboard navigation stays on the radio; native arrows need no custom keys.
      activeElement = {};
      const radioFocus = activeElement;
      changeMode("direct", 0);
      expect(activeElement).toBe(radioFocus);
      expect(
        elements.some(
          (element) =>
            element.props.className === "terminal-composer-direct-focus",
        ),
      ).toBe(false);
      const choicesBeforeCommands = [...modeChoices];
      const dock = find("className", "terminal-composer");
      const dockTarget = {};
      onFocusDirect.mockClear();
      // The explicit Type gesture forwards only focus on the dock itself.
      invoke(dock, "onFocus", { target: {}, currentTarget: dockTarget });
      expect(onFocusDirect).not.toHaveBeenCalled();
      invoke(dock, "onFocus", {
        target: dockTarget,
        currentTarget: dockTarget,
      });
      expect(onFocusDirect).toHaveBeenCalledTimes(1);
      invoke(commands(), "onClick");
      expect(modeChoices).toEqual(choicesBeforeCommands);
      expect(mode).toBe("composer");
      expect(picker()).toBeDefined();
      expect(draft).toBe("new upload or edit");
      key(picker(), "Escape");

      // An IME confirmation cannot switch modes or send terminal Enter.
      textarea.focus();
      invoke(editor(), "onCompositionStart");
      expect(find("value", "direct").props.disabled).toBe(true);
      expect(find("aria-label", "Send Enter").props.disabled).toBe(true);
      changeMode("direct");
      invoke(find("aria-label", "Send Enter"), "onClick");
      expect(mode).toBe("composer");
      expect(modeChoices).toEqual(choicesBeforeCommands);
      expect(onRunShortcut).not.toHaveBeenCalled();
      invoke(editor(), "onCompositionEnd");
      invoke(find("aria-label", "Send Enter"), "onClick");
      expect(onRunShortcut).toHaveBeenCalledTimes(1);
      expect(draft).toBe("new upload or edit");
      directDisabled = true;
      render();
      expect(find("value", "direct").props.disabled).toBe(true);
      changeMode("direct");
      expect(modeChoices).toEqual(choicesBeforeCommands);
      // Neither Composer nor an unavailable Direct mode forwards dock focus.
      onFocusDirect.mockClear();
      invoke(find("className", "terminal-composer"), "onFocus", {
        target: dockTarget,
        currentTarget: dockTarget,
      });
      mode = "direct";
      render();
      invoke(find("className", "terminal-composer"), "onFocus", {
        target: dockTarget,
        currentTarget: dockTarget,
      });
      expect(onFocusDirect).not.toHaveBeenCalled();
      mode = "composer";
      directDisabled = false;
      render();

      // Failure restores the draft while a new Direct session retains focus.
      let rejectSubmission: (error: Error) => void = () => {};
      onSubmit.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectSubmission = reject;
          }),
      );
      invoke(find("aria-label", "Insert draft into the terminal"), "onClick");
      expect(onSubmit).toHaveBeenCalledWith("new upload or edit", false);
      expect(draft).toBe("");
      changeMode("direct");
      rejectSubmission(new Error("Disconnected"));
      await Promise.resolve();
      render();
      expect(draft).toBe("new upload or edit");
      expect(activeElement).toBe(directInput);
      expect(onError).toHaveBeenCalledTimes(1);
      changeMode("composer");
      invoke(find("aria-label", "Send draft to the terminal"), "onClick");
      await Promise.resolve();
      render();
      expect(onSubmit).toHaveBeenLastCalledWith("new upload or edit", true);
      expect(draft).toBe("");

      // Closing/reopening the composer creates new hooks but retains the choice.
      invoke(shortcutToggle(), "onClick");
      expect(savedValues.get(shortcutsStorageKey)).toBe("false");
      const writesAfterHide = writeStorage.mock.calls.length;
      remount();
      expect(shortcutToggle().props["aria-expanded"]).toBe(false);
      expect(shortcutPanel().props.hidden).toBe(true);
      expect(writeStorage).toHaveBeenCalledTimes(writesAfterHide);
      invoke(shortcutToggle(), "onClick");
      expect(savedValues.get(shortcutsStorageKey)).toBe("true");
      remount();
      expect(shortcutToggle().props["aria-expanded"]).toBe(true);
      expect(shortcutPanel().props.hidden).toBe(false);

      // A rejected write keeps the page's selection over the stale stored value.
      storageWriteFails = true;
      invoke(shortcutToggle(), "onClick");
      expect(savedValues.get(shortcutsStorageKey)).toBe("true");
      remount();
      expect(shortcutToggle().props["aria-expanded"]).toBe(false);
      expect(shortcutPanel().props.hidden).toBe(true);
      storageWriteFails = false;
      invoke(shortcutToggle(), "onClick");
      remount();
      expect(shortcutPanel().props.hidden).toBe(false);

      savedValues.set(shortcutsStorageKey, "invalid");
      remount();
      expect(shortcutPanel().props.hidden).toBe(false);
    } finally {
      for (const effect of effects) effect.cleanup?.();
      for (const spy of spies.reverse()) spy.mockRestore();
      if (previousDocument)
        Object.defineProperty(globalThis, "document", previousDocument);
      else Reflect.deleteProperty(globalThis, "document");
      if (previousStorage)
        Object.defineProperty(globalThis, "localStorage", previousStorage);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  },
);

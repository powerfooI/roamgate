import { expect, mock, spyOn, test } from "bun:test";
import { SquareTerminal } from "lucide-react";
import * as React from "react";
import * as ReactDOM from "react-dom";
import * as drafts from "../terminalComposer";
import { terminalComposerCommands } from "../terminalComposerCommands";
import { TerminalComposer } from "./TerminalComposer";

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
  (agent) => {
    let draft = "keep this draft";
    let listener: ((text: string) => void) | undefined;
    const onSubmit = mock(async () => {});
    const onRunShortcut = mock(() => {});
    const nodes = new Map<string, Host>();
    let activeElement: Host | object = {};
    const previousDocument = Object.getOwnPropertyDescriptor(
      globalThis,
      "document",
    );
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        get activeElement() {
          return activeElement;
        },
      },
    });

    const states: unknown[] = [];
    const refs: React.MutableRefObject<unknown>[] = [];
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
    let boundRefs: React.MutableRefObject<unknown>[] = [];
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
        const ref = (
          child as Element & { ref?: React.MutableRefObject<unknown> }
        ).ref;
        if (ref && typeof ref === "object") {
          const key = String(
            child.props.className ?? child.props["aria-label"] ?? child.type,
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
            agent,
            shortcutRows: [],
            onRunShortcut,
            onClose() {},
            onSubmit,
            onUploadImage: async () => "/tmp/image.png",
            onError() {},
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
    const picker = () => find("className", "terminal-composer-commands");
    const option = () => find("role", "option");
    try {
      render();
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
            element.type === "input" && element.props.type !== "file",
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
      const staleConfirm = find("children", "Replace draft");
      drafts.writeTerminalComposerDraft(
        "command-interaction",
        "new upload or edit",
      );
      invoke(staleConfirm, "onClick");
      expect(draft).toBe("new upload or edit");
      expect(onSubmit).not.toHaveBeenCalled();
      expect(onRunShortcut).not.toHaveBeenCalled();
    } finally {
      for (const effect of effects) effect.cleanup?.();
      for (const spy of spies.reverse()) spy.mockRestore();
      if (previousDocument)
        Object.defineProperty(globalThis, "document", previousDocument);
      else Reflect.deleteProperty(globalThis, "document");
    }
  },
);

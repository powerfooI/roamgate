import { expect, mock, test } from "bun:test";
import * as React from "react";
import { groupHistoryChatItems } from "./agentHistoryView";
import type { HistoryEntry } from "./agentHistory";

if (process.env.ROAMGATE_SPEECH_DOM_TEST !== "1") {
  test("speech UI in an isolated browser runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_SPEECH_DOM_TEST: "1" },
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
  }, 20_000);
} else {
  test("chat controls, cancellation, full text, voice updates and browser preferences", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/" });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      DOMParser: browser.DOMParser,
      NodeFilter: browser.NodeFilter,
      localStorage: browser.localStorage,
      Event: browser.Event,
      ResizeObserver: class {
        observe() {}
        disconnect() {}
      },
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    }
    const synthesis = new browser.EventTarget();
    let voices: SpeechSynthesisVoice[] = [];
    const utterances: SpeechSynthesisUtterance[] = [];
    const cancel = mock(() => {});
    Object.assign(synthesis, {
      getVoices: () => voices,
      cancel,
      speak: (utterance: SpeechSynthesisUtterance) => {
        utterances.push(utterance);
      },
    });
    Object.defineProperty(browser, "speechSynthesis", {
      value: synthesis,
      configurable: true,
    });
    Object.defineProperty(browser, "SpeechSynthesisUtterance", {
      value: class {
        constructor(public text: string) {}
      },
      configurable: true,
    });
    browser.localStorage.setItem(
      "roamgate:speechPreferences",
      JSON.stringify({ voiceURI: "saved", rate: 1.2 }),
    );
    const { SpeechSettings } = await import("./SpeechSettings");
    const { AgentHistoryChat } = await import("./AgentHistoryChat");
    const { speechPlayback } = await import("../speechPlayback");
    const { markdownToSpeech } = await import("../markdownToSpeech");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    let root = createRoot(container);
    const text = "A sentence containing useful information. ".repeat(400);
    const message = (
      id: string,
      role: HistoryEntry["role"],
      text: string,
    ): HistoryEntry => ({
      id,
      role,
      text,
      kind: "message",
      sent_at: "2026-01-01T00:00:00Z",
    });
    const items = groupHistoryChatItems([
      message("user", "user", "Question"),
      message("one", "assistant", text),
      message("two", "assistant", "Second response"),
    ]);
    let active = true;
    let scope = "one";
    const render = () =>
      React.act(async () => {
        root.render(
          <>
            <SpeechSettings />
            <AgentHistoryChat
              items={items}
              speechActive={active}
              speechScopeKey={scope}
              listRef={React.createRef()}
              contentRef={React.createRef()}
              onOpen={() => {}}
            />
          </>,
        );
      });
    const button = (label: string) =>
      container.querySelector<HTMLButtonElement>(
        `button[aria-label="${label}"]`,
      )!;
    const click = (label: string) =>
      React.act(async () => button(label).click());
    try {
      await render();
      expect(
        container.querySelectorAll('[aria-label="Speak assistant message"]')
          .length,
      ).toBe(2);
      expect(container.textContent).toContain("View full message");
      const voiceSelect = container.querySelector("select")!;
      expect(voiceSelect.value).toBe("saved");
      expect(voiceSelect.textContent).toContain("Saved voice unavailable");
      voices = [
        {
          voiceURI: "saved",
          name: "Test Voice",
          lang: "en-GB",
          localService: false,
        },
      ] as SpeechSynthesisVoice[];
      await React.act(async () =>
        synthesis.dispatchEvent(new browser.Event("voiceschanged")),
      );
      expect(voiceSelect.textContent).toContain("Test Voice (en-GB) - online");
      await click("Speak assistant message");
      expect(utterances[0]!.rate).toBe(1.2);
      expect(utterances[0]!.voice).toBe(voices[0]!);
      // Drain every chunk and verify text beyond the visual preview was read.
      let index = 0;
      await React.act(async () => {
        while (speechPlayback.getSnapshot().status === "speaking") {
          const utterance = utterances[index++]!;
          utterance.onend?.({} as SpeechSynthesisEvent);
        }
      });
      expect(
        utterances
          .map((utterance) => utterance.text)
          .join(" ")
          .replace(/\s+/g, " "),
      ).toBe(markdownToSpeech(text).replace(/\s+/g, " "));
      expect(container.textContent).toContain("Speech completed");
      await click("Speak assistant message");
      await click("Stop speaking message");
      expect(container.textContent).toContain("Speech stopped");
      await click("Speak assistant message");
      // The remaining Speak button belongs to the second assistant message.
      await click("Speak assistant message");
      expect(speechPlayback.getSnapshot().messageId).toBe("two");
      const last = utterances[utterances.length - 1]!;
      await React.act(async () =>
        last.onerror?.({} as SpeechSynthesisErrorEvent),
      );
      expect(container.textContent).toContain("Speech playback failed");
      await click("Speak assistant message");
      active = false;
      await render();
      expect(speechPlayback.getSnapshot().status).toBe("stopped");
      active = true;
      await render();
      await click("Speak assistant message");
      scope = "another-session";
      await render();
      expect(speechPlayback.getSnapshot().status).toBe("stopped");
      await click("Speak assistant message");
      await React.act(async () => root.unmount());
      expect(speechPlayback.getSnapshot().status).toBe("stopped");
      expect(cancel.mock.calls.length).toBeGreaterThan(3);
      root = createRoot(container);
      await render();
      const rate = container.querySelector<HTMLInputElement>(
        'input[type="range"]',
      )!;
      await React.act(async () => {
        browser.localStorage.setItem(
          "roamgate:speechPreferences",
          JSON.stringify({ voiceURI: "", rate: 1.7 }),
        );
        browser.dispatchEvent(
          new browser.StorageEvent("storage", {
            key: "roamgate:speechPreferences",
            storageArea: browser.localStorage,
          }),
        );
      });
      expect(rate.value).toBe("1.7");
      await React.act(async () => {
        const current = container.querySelector("select")!;
        current.value = "saved";
        current.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(
        JSON.parse(browser.localStorage.getItem("roamgate:speechPreferences")!)
          .voiceURI,
      ).toBe("saved");
      // Storage failures must not discard preferences when all views unmount.
      const { updateSpeechPreferences } = await import("../speechPreferences");
      const setItem = browser.localStorage.setItem;
      browser.localStorage.setItem = () => {
        throw new Error("Storage unavailable");
      };
      try {
        await React.act(async () => updateSpeechPreferences({ rate: 1.5 }));
        await React.act(async () => root.unmount());
        root = createRoot(container);
        await render();
        expect(
          container.querySelector<HTMLInputElement>('input[type="range"]')!
            .value,
        ).toBe("1.5");
        expect(container.querySelector("select")!.value).toBe("saved");
      } finally {
        browser.localStorage.setItem = setItem;
      }
      await React.act(async () => root.unmount());
      Object.defineProperty(browser, "speechSynthesis", { value: undefined });
      root = createRoot(container);
      await render();
      expect(button("Speak assistant message").disabled).toBe(true);
      expect(container.textContent).toContain("Speech is not supported");
    } finally {
      await React.act(async () => root.unmount());
      speechPlayback.stop();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      await browser.happyDOM.close();
    }
  });
}

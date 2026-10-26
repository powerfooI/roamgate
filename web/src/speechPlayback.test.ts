import { expect, mock, test } from "bun:test";
import { SpeechPlayback, type SpeechRuntime } from "./speechPlayback";

function setup() {
  const utterances: SpeechSynthesisUtterance[] = [];
  const voices = [
    { voiceURI: "test", lang: "en-GB" },
  ] as SpeechSynthesisVoice[];
  const runtime: SpeechRuntime = {
    synthesis: {
      speak: mock(() => {}),
      cancel: mock(() => {}),
      getVoices: () => voices,
    },
    utterance(text) {
      const value = {
        text,
        onend: null,
        onerror: null,
      } as unknown as SpeechSynthesisUtterance;
      utterances.push(value);
      return value;
    },
  };
  const controller = new SpeechPlayback(() => runtime);
  return { controller, runtime, utterances };
}
const preferences = { voiceURI: "", rate: 1 };
const end = (utterance: SpeechSynthesisUtterance) =>
  utterance.onend?.({} as SpeechSynthesisEvent);
const error = (utterance: SpeechSynthesisUtterance) =>
  utterance.onerror?.({} as SpeechSynthesisErrorEvent);

test("starts synchronously, plays bounded chunks sequentially and completes", () => {
  const { controller, runtime, utterances } = setup();
  const listener = mock(() => {});
  const unsubscribe = controller.subscribe(listener);
  controller.start(Symbol(), "one", "Sentence. ".repeat(100), preferences);
  expect(runtime.synthesis.speak).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot().status).toBe("speaking");
  let index = 0;
  while (controller.getSnapshot().status === "speaking") {
    expect(utterances[index]!.text.length).toBeLessThanOrEqual(240);
    end(utterances[index++]!);
  }
  expect(index).toBeGreaterThan(1);
  expect(controller.getSnapshot().status).toBe("completed");
  expect(listener).toHaveBeenCalledTimes(2);
  unsubscribe();
});

test("stop cancels immediately and stale callbacks cannot restart the queue", () => {
  const { controller, runtime, utterances } = setup();
  const owner = Symbol();
  controller.start(owner, "one", "Sentence. ".repeat(100), preferences);
  const staleEnd = utterances[0]!.onend!;
  const staleError = utterances[0]!.onerror!;
  controller.stop(owner);
  staleEnd.call(utterances[0]!, {} as SpeechSynthesisEvent);
  staleError.call(utterances[0]!, {} as SpeechSynthesisErrorEvent);
  expect(controller.getSnapshot().status).toBe("stopped");
  expect(runtime.synthesis.cancel).toHaveBeenCalledTimes(1);
  expect(utterances).toHaveLength(1);
});

test("switching owners invalidates pending chunks without allowing old cleanup to cancel new speech", () => {
  const { controller, utterances } = setup();
  const old = Symbol(),
    current = Symbol();
  controller.start(old, "one", "Sentence. ".repeat(100), preferences);
  const stale = utterances[0]!.onend!;
  controller.start(current, "two", "New message", preferences);
  controller.stop(old);
  stale.call(utterances[0]!, {} as SpeechSynthesisEvent);
  expect(controller.getSnapshot().messageId).toBe("two");
  expect(controller.getSnapshot().status).toBe("speaking");
  expect(utterances).toHaveLength(2);
  end(utterances[1]!);
  expect(controller.getSnapshot().status).toBe("completed");
});

test("duplicate completion events do not skip chunks", () => {
  const { controller, utterances } = setup();
  controller.start(Symbol(), "one", "Sentence. ".repeat(100), preferences);
  const callback = utterances[0]!.onend!;
  callback.call(utterances[0]!, {} as SpeechSynthesisEvent);
  callback.call(utterances[0]!, {} as SpeechSynthesisEvent);
  expect(utterances).toHaveLength(2);
});

test("voice, rate and missing-voice fallback are applied to every utterance", () => {
  const { controller, utterances } = setup();
  controller.start(Symbol(), "one", "Sentence. ".repeat(100), {
    voiceURI: "test",
    rate: 1.4,
  });
  expect(utterances[0]!.voice!.voiceURI).toBe("test");
  expect(utterances[0]!.lang).toBe("en-GB");
  end(utterances[0]!);
  expect(utterances[1]!.rate).toBe(1.4);
  controller.start(Symbol(), "two", "Text", { voiceURI: "missing", rate: 1 });
  expect(utterances[utterances.length - 1]!.voice).toBeUndefined();
});

test("synthesis errors and thrown calls terminate playback and allow retry", () => {
  const { controller, runtime, utterances } = setup();
  const owner = Symbol();
  controller.start(owner, "one", "Sentence. ".repeat(100), preferences);
  error(utterances[0]!);
  expect(controller.getSnapshot().status).toBe("failed");
  end(utterances[0]!);
  expect(utterances).toHaveLength(1);
  controller.start(owner, "one", "Retry", preferences);
  expect(controller.getSnapshot().status).toBe("speaking");
  runtime.synthesis.speak = () => {
    throw new Error("Unavailable");
  };
  controller.start(owner, "one", "Retry", preferences);
  expect(controller.getSnapshot().status).toBe("failed");
});

test("unavailable APIs and empty text fail understandably", () => {
  const controller = new SpeechPlayback(() => null);
  controller.start(Symbol(), "one", "text", preferences);
  expect(controller.getSnapshot().error).toContain("not supported");
  const { controller: available } = setup();
  available.start(Symbol(), "one", "", preferences);
  expect(available.getSnapshot().error).toContain("no readable text");
});

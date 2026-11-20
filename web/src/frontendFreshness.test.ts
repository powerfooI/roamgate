import { afterEach, expect, test, jest } from "bun:test";
import { Window as BrowserWindow, Event as BrowserEvent } from "happy-dom";
import {
  checkFrontendFreshness,
  editableText,
  entryScript,
  frontendFreshnessState,
  IDLE_RELOAD_MS,
  NOTICE_AFTER_MS,
  POLL_MS,
  reloadForNewerBuild,
  reloadHold,
  type ReloadSituation,
  startFrontendFreshness,
  TYPING_QUIET_MS,
} from "./frontendFreshness";

test("the entry script is the hashed index chunk", () => {
  expect(
    entryScript(
      '<script type="module" crossorigin src="/assets/index-WHsScV4q.js"></script>',
    ),
  ).toBe("/assets/index-WHsScV4q.js");
  expect(entryScript("http://host:8787/assets/index-a_b-C.js")).toBe(
    "/assets/index-a_b-C.js",
  );
  // Vite's development page has none.
  expect(entryScript('<script type="module" src="/src/main.tsx">')).toBeNull();
});

import {
  activateTerminalComposerDraftScope,
  beginTerminalComposerUpload,
  finishTerminalComposerUpload,
  terminalComposerDraftKey,
} from "./terminalComposer";

const globalsUsed = [
  "document",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
] as const;
const saved = globalsUsed.map((key) =>
  Object.getOwnPropertyDescriptor(globalThis, key),
);
let stops: Array<() => void> = [];

afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
  globalsUsed.forEach((key, index) => {
    const descriptor = saved[index];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  });
});

function page(entry: string | null, options: { now?: () => number } = {}) {
  const browser = new BrowserWindow({ url: "http://localhost:8787/" });
  for (const key of globalsUsed)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === "document" ? browser.document : browser[key],
    });
  if (entry) {
    const script = browser.document.createElement("script");
    script.type = "module";
    script.setAttribute("src", entry);
    browser.document.head.appendChild(script);
  }
  const box = browser.document.createElement("textarea");
  browser.document.body.appendChild(box);
  let served = entry ?? "";
  let connected = () => {};
  let reloads = 0;
  stops.push(
    startFrontendFreshness({
      onConnected: (callback) => {
        connected = callback;
        return () => {};
      },
      fetchIndex: async () =>
        `<script type="module" crossorigin src="${served}"></script>`,
      reload: () => {
        reloads += 1;
      },
      ...options,
    }),
  );
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    box,
    serve(next: string) {
      served = next;
    },
    async reconnect() {
      connected();
      await settle();
      await settle();
    },
    reloads: () => reloads,
    settle,
  };
}

test("a reconnect to a server with another build reloads the page", async () => {
  const tab = page("/assets/index-old.js");
  await tab.reconnect();
  expect(tab.reloads()).toBe(0);

  tab.serve("/assets/index-new.js");
  await tab.reconnect();
  expect(tab.reloads()).toBe(1);
});

test("unsent text delays the reload after blur until cleared", async () => {
  const tab = page("/assets/index-old.js");
  tab.box.value = "half a sentence";
  tab.box.dispatchEvent(new BrowserEvent("input", { bubbles: true }));
  tab.box.focus();
  tab.serve("/assets/index-new.js");
  await tab.reconnect();
  expect(tab.reloads()).toBe(0);

  tab.box.blur();
  await tab.settle();
  expect(tab.reloads()).toBe(0);
  tab.box.value = "";
  tab.box.dispatchEvent(new BrowserEvent("input", { bubbles: true }));
  await tab.settle();
  expect(tab.reloads()).toBe(1);
});

test("a development page without a hashed entry never reloads", async () => {
  const tab = page(null);
  tab.serve("/assets/index-new.js");
  await tab.reconnect();
  expect(tab.reloads()).toBe(0);
});

test("an unfocused API key survives a stale build until its dialog closes", async () => {
  const tab = page("/assets/index-old.js");
  const dialog = document.createElement("section");
  dialog.setAttribute("role", "dialog");
  const key = document.createElement("input");
  key.type = "password";
  key.value = "unsaved-key";
  dialog.append(key);
  document.body.append(dialog);
  fire(key, "input");
  tab.serve("/assets/index-new.js");
  await tab.reconnect();
  key.focus();
  key.blur();
  await tab.settle();
  expect(tab.reloads()).toBe(0);
  dialog.remove();
  jest.useFakeTimers();
  try {
    tab.box.dispatchEvent(new BrowserEvent("input", { bubbles: true }));
    jest.advanceTimersByTime(1);
    expect(tab.reloads()).toBe(1);
  } finally {
    jest.useRealTimers();
  }
});

test("pending uploads delay a reload even with an empty composer", async () => {
  const tab = page("/assets/index-old.js");
  activateTerminalComposerDraftScope("freshness", 1);
  const key = terminalComposerDraftKey("freshness", 1, "pane");
  expect(beginTerminalComposerUpload(key)).toBe(true);
  jest.useFakeTimers();
  try {
    tab.serve("/assets/index-new.js");
    // reconnect settles with zero-delay timers, so drive those explicitly.
    const reconnect = tab.reconnect();
    await Promise.resolve();
    jest.advanceTimersByTime(1);
    await Promise.resolve();
    jest.advanceTimersByTime(1);
    await reconnect;
    expect(tab.reloads()).toBe(0);
    finishTerminalComposerUpload(key);
    jest.advanceTimersByTime(1000);
    expect(tab.reloads()).toBe(1);
  } finally {
    finishTerminalComposerUpload(key);
    jest.useRealTimers();
  }
});

test("cleanup prevents an in-flight check from reloading", async () => {
  page("/assets/index-old.js");
  for (const stop of stops.splice(0)) stop();
  let connect = () => {};
  let resolve!: (html: string) => void;
  let reloads = 0;
  const stop = startFrontendFreshness({
    onConnected: (callback) => {
      connect = callback;
      return () => {};
    },
    fetchIndex: () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
    reload: () => {
      reloads++;
    },
  });
  connect();
  stop();
  resolve('<script src="/assets/index-new.js"></script>');
  await Promise.resolve();
  expect(reloads).toBe(0);
});

/** A DOM event on an element of the page's (happy-dom's) document. */
function fire(target: EventTarget, type: string) {
  target.dispatchEvent(
    new BrowserEvent(type, { bubbles: true }) as unknown as Event,
  );
}

async function flushAll() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

test("what holds a reload back, and until when", () => {
  const free: ReloadSituation = {
    sending: false,
    unsaved: false,
    typing: false,
    dialog: false,
  };
  expect(reloadHold(free)).toBeNull();
  expect(reloadHold({ ...free, sending: true })?.until).toBe("wait");
  expect(reloadHold({ ...free, typing: true })?.until).toBe("wait");
  expect(reloadHold({ ...free, dialog: true })?.until).toBe("idle");
  expect(reloadHold({ ...free, unsaved: true, dialog: true })?.until).toBe(
    "ask",
  );
  // Sending comes first: it ends by itself, whatever else waits.
  expect(reloadHold({ ...free, sending: true, unsaved: true })?.reason).toBe(
    "the composer to finish sending",
  );
});

/** CodeMirror's empty editor: its placeholder is not text. */
function codeMirror(text: string) {
  const content = document.createElement("div");
  content.className = "cm-content";
  content.setAttribute("contenteditable", "true");
  const line = document.createElement("div");
  line.className = "cm-line";
  if (text) line.textContent = text;
  else {
    const placeholder = document.createElement("span");
    placeholder.className = "cm-placeholder";
    placeholder.setAttribute("contenteditable", "false");
    placeholder.setAttribute("aria-hidden", "true");
    placeholder.textContent = "Message claude...";
    line.append(placeholder, document.createElement("br"));
  }
  content.append(line);
  return content;
}

test("an editor's placeholder is not text", () => {
  page("/assets/index-old.js");
  expect(editableText(codeMirror(""))).toBe("");
  expect(editableText(codeMirror("hello"))).toBe("hello");
});

test("an empty chat box shown with its placeholder does not hold the reload", async () => {
  const tab = page("/assets/index-old.js");
  const box = codeMirror("");
  document.body.append(box);
  // Clicked and typed in, then emptied: still only its placeholder.
  fire(box, "input");
  tab.serve("/assets/index-new.js");
  await tab.reconnect();
  expect(tab.reloads()).toBe(1);
});

test("a composer's draft is kept by the browser and does not hold the reload", async () => {
  const tab = page("/assets/index-old.js");
  const composer = document.createElement("div");
  composer.setAttribute("data-draft-saved", "true");
  const box = codeMirror("[Image #1] what is this?");
  composer.append(box);
  document.body.append(composer);
  fire(box, "input");
  tab.serve("/assets/index-new.js");
  await tab.reconnect();
  expect(tab.reloads()).toBe(1);
});

test("a page filled-in field does not hold the reload, a typed one does", async () => {
  const tab = page("/assets/index-old.js");
  // Set by the page (a setting's current value): nothing to lose.
  tab.box.value = "8000";
  tab.serve("/assets/index-new.js");
  await tab.reconnect();
  expect(tab.reloads()).toBe(1);
});

test("typing holds the reload until a pause", async () => {
  let clock = 1_000_000;
  const tab = page("/assets/index-old.js", { now: () => clock });
  jest.useFakeTimers();
  try {
    fire(document.body, "keydown");
    tab.serve("/assets/index-new.js");
    void tab.reconnect();
    await flushAll();
    expect(tab.reloads()).toBe(0);
    clock += TYPING_QUIET_MS;
    jest.advanceTimersByTime(1000);
    expect(tab.reloads()).toBe(1);
  } finally {
    jest.useRealTimers();
  }
});

test("an open dialog is closed by the reload once the page is left alone", async () => {
  let clock = 1_000_000;
  const tab = page("/assets/index-old.js", { now: () => clock });
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  document.body.append(dialog);
  jest.useFakeTimers();
  try {
    tab.serve("/assets/index-new.js");
    void tab.reconnect();
    await flushAll();
    expect(tab.reloads()).toBe(0);
    // Said at once: this waits for the user.
    expect(frontendFreshnessState()).toEqual({
      stale: true,
      notice: "the dialog to close",
    });
    clock += IDLE_RELOAD_MS / 2;
    fire(document.body, "pointerdown");
    clock += IDLE_RELOAD_MS / 2;
    jest.advanceTimersByTime(1000);
    expect(tab.reloads()).toBe(0);
    clock += IDLE_RELOAD_MS / 2;
    jest.advanceTimersByTime(1000);
    expect(tab.reloads()).toBe(1);
  } finally {
    jest.useRealTimers();
  }
});

test("typed text never reloads by itself, but the notice's button does", async () => {
  let clock = 1_000_000;
  const tab = page("/assets/index-old.js", { now: () => clock });
  tab.box.value = "a comment not sent";
  tab.box.dispatchEvent(new BrowserEvent("input", { bubbles: true }));
  jest.useFakeTimers();
  try {
    tab.serve("/assets/index-new.js");
    void tab.reconnect();
    await flushAll();
    expect(frontendFreshnessState()).toEqual({
      stale: true,
      notice: "unsaved text to be sent or cleared",
    });
    clock += 10 * IDLE_RELOAD_MS;
    jest.advanceTimersByTime(5000);
    expect(tab.reloads()).toBe(0);
    reloadForNewerBuild();
    expect(tab.reloads()).toBe(1);
  } finally {
    jest.useRealTimers();
  }
});

test("a short wait shows no notice, a long one does", async () => {
  let clock = 1_000_000;
  const tab = page("/assets/index-old.js", { now: () => clock });
  activateTerminalComposerDraftScope("freshness", 1);
  const key = terminalComposerDraftKey("freshness", 1, "notice-pane");
  expect(beginTerminalComposerUpload(key)).toBe(true);
  jest.useFakeTimers();
  try {
    tab.serve("/assets/index-new.js");
    void tab.reconnect();
    await flushAll();
    expect(frontendFreshnessState()).toEqual({ stale: true, notice: null });
    clock += NOTICE_AFTER_MS;
    jest.advanceTimersByTime(1000);
    expect(frontendFreshnessState().notice).toBe(
      "the composer to finish sending",
    );
    finishTerminalComposerUpload(key);
    jest.advanceTimersByTime(1000);
    expect(tab.reloads()).toBe(1);
  } finally {
    finishTerminalComposerUpload(key);
    jest.useRealTimers();
  }
});

test("the page checks by itself now and then, and when something fails", async () => {
  jest.useFakeTimers();
  try {
    const tab = page("/assets/index-old.js");
    tab.serve("/assets/index-new.js");
    jest.advanceTimersByTime(POLL_MS);
    await flushAll();
    expect(tab.reloads()).toBe(1);
  } finally {
    jest.useRealTimers();
  }
  for (const stop of stops.splice(0)) stop();
  const tab = page("/assets/index-old.js");
  tab.serve("/assets/index-new.js");
  checkFrontendFreshness();
  await flushAll();
  expect(tab.reloads()).toBe(1);
});

import { afterEach, expect, test } from "bun:test";
import { Window as BrowserWindow } from "happy-dom";
import { entryScript, startFrontendFreshness } from "./frontendFreshness";

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

function page(entry: string | null) {
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

test("unsent text delays the reload until its field is left", async () => {
  const tab = page("/assets/index-old.js");
  tab.box.value = "half a sentence";
  tab.box.focus();
  tab.serve("/assets/index-new.js");
  await tab.reconnect();
  expect(tab.reloads()).toBe(0);

  tab.box.blur();
  await tab.settle();
  expect(tab.reloads()).toBe(1);
});

test("a development page without a hashed entry never reloads", async () => {
  const tab = page(null);
  tab.serve("/assets/index-new.js");
  await tab.reconnect();
  expect(tab.reloads()).toBe(0);
});

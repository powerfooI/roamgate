import { expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const bootstrap = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(
  (match) => match[1]?.includes("storedTheme"),
)?.[1];
if (!bootstrap) throw new Error("First-paint appearance bootstrap is missing");

function firstPaint(values: Record<string, string>, systemLight = false) {
  const element = {
    dataset: { theme: "" },
    style: { colorScheme: "", zoom: "" },
  };
  const writeStorage = mock(() => undefined);
  runInNewContext(bootstrap as string, {
    document: { documentElement: element },
    window: { matchMedia: () => ({ matches: systemLight }) },
    localStorage: {
      getItem: (key: string) => values[key] ?? null,
      setItem: writeStorage,
      removeItem: writeStorage,
      clear: writeStorage,
    },
  });
  expect(writeStorage).not.toHaveBeenCalled();
  return element;
}

test("index first paint uses defaults when no appearance preferences exist", () => {
  expect(firstPaint({})).toEqual({
    dataset: { theme: "dark" },
    style: { colorScheme: "dark", zoom: "" },
  });
});

test("index first paint reads legacy appearance preferences without changing them", () => {
  const values = { theme: "light", uiScale: "125" };
  expect(firstPaint(values)).toEqual({
    dataset: { theme: "light" },
    style: { colorScheme: "light", zoom: "1.25" },
  });
});

test("index first paint uses Roamgate appearance preferences on fresh installs", () => {
  expect(
    firstPaint({ "roamgate:theme": "light", "roamgate:uiScale": "120" }),
  ).toEqual({
    dataset: { theme: "light" },
    style: { colorScheme: "light", zoom: "1.2" },
  });
});

test("index first paint prefers new appearance values over differing legacy values", () => {
  expect(
    firstPaint({
      theme: "light",
      "roamgate:theme": "dark",
      uiScale: "125",
      "roamgate:uiScale": "90",
    }),
  ).toEqual({
    dataset: { theme: "dark" },
    style: { colorScheme: "dark", zoom: "0.9" },
  });
});

test("index first paint does not fall back from explicitly empty new values", () => {
  expect(
    firstPaint({
      theme: "light",
      "roamgate:theme": "",
      uiScale: "125",
      "roamgate:uiScale": "",
    }),
  ).toEqual({
    dataset: { theme: "dark" },
    style: { colorScheme: "dark", zoom: "0.8" },
  });
});

test("index first paint resolves the new system theme and default scale", () => {
  expect(
    firstPaint(
      {
        theme: "dark",
        "roamgate:theme": "system",
        uiScale: "125",
        "roamgate:uiScale": "100",
      },
      true,
    ),
  ).toEqual({
    dataset: { theme: "light" },
    style: { colorScheme: "light", zoom: "" },
  });
});

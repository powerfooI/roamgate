import { expect, test } from "bun:test";
import {
  JIRA_DOCK_STORAGE_KEY,
  clampJiraDockSize,
  jiraDockSize,
  readJiraDock,
  withJiraDockSize,
  writeJiraDock,
} from "./jiraDock";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = { ...initial };
  return {
    values,
    getItem: (key: string) => values[key] ?? null,
    setItem: (key: string, value: string) => {
      values[key] = value;
    },
  };
}

test("defaults to a right dock (AC29)", () => {
  const value = readJiraDock(memoryStorage());
  expect(value.dock).toBe("right");
  expect(jiraDockSize(value)).toBe(value.rightSize);
});

test("the dock and a size per dock survive a reload (AC29)", () => {
  const storage = memoryStorage();
  const right = withJiraDockSize(readJiraDock(storage), 610);
  const bottom = withJiraDockSize({ ...right, dock: "bottom" }, 280);
  writeJiraDock(storage, bottom);
  const reread = readJiraDock(storage);
  expect(reread).toEqual({ dock: "bottom", rightSize: 610, bottomSize: 280 });
  expect(jiraDockSize({ ...reread, dock: "right" })).toBe(610);
});

test("corrupt or invalid preferences fall back to defaults", () => {
  expect(readJiraDock(memoryStorage({ [JIRA_DOCK_STORAGE_KEY]: "{" })).dock).toBe(
    "right",
  );
  const value = readJiraDock(
    memoryStorage({
      [JIRA_DOCK_STORAGE_KEY]: JSON.stringify({ dock: "left", rightSize: -4 }),
    }),
  );
  expect(value.dock).toBe("right");
  expect(value.rightSize).toBeGreaterThan(0);
});

test("resizing keeps the panel and the terminal above their minimums", () => {
  expect(clampJiraDockSize("right", 100, 1600, 900)).toBe(360);
  expect(clampJiraDockSize("right", 5000, 1600, 900)).toBe(1600 - 480 - 7);
  expect(clampJiraDockSize("bottom", 50, 1600, 900)).toBe(220);
  expect(clampJiraDockSize("bottom", 5000, 1600, 900)).toBe(900 - 240 - 7);
});

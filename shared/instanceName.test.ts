import { expect, test } from "bun:test";
import {
  instanceDisplayName,
  MAX_TITLE_SUFFIX_LENGTH,
  normalizeTitleSuffix,
} from "./instanceName";

test("names default cleanly and normalize a short instance suffix", () => {
  expect(instanceDisplayName(normalizeTitleSuffix(" \t\n"))).toBe("Roamgate");
  expect(instanceDisplayName(normalizeTitleSuffix(" Home \n Office "))).toBe(
    "Roamgate \u00b7 Home Office",
  );
  expect(normalizeTitleSuffix("\u5bb6\u91cc \ud83c\udfe0")).toBe(
    "\u5bb6\u91cc \ud83c\udfe0",
  );
  expect(normalizeTitleSuffix('<Work> "A" & B')).toBe('<Work> "A" & B');
});

test("validates types, invisible controls and Unicode character length", () => {
  for (const value of [null, undefined, 7, {}, []])
    expect(() => normalizeTitleSuffix(value)).toThrow("must be text");
  for (const value of [
    "Home\u0000",
    "Home\u007f",
    "Home\u0080",
    "Home\u202e",
    "Home\u2066",
  ]) {
    expect(() => normalizeTitleSuffix(value)).toThrow("control characters");
  }
  expect(
    normalizeTitleSuffix("\ud83c\udfe0".repeat(MAX_TITLE_SUFFIX_LENGTH)),
  ).toBe("\ud83c\udfe0".repeat(MAX_TITLE_SUFFIX_LENGTH));
  expect(() =>
    normalizeTitleSuffix("\ud83c\udfe0".repeat(MAX_TITLE_SUFFIX_LENGTH + 1)),
  ).toThrow("32 characters");
});

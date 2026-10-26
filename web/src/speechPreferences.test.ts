import { expect, test } from "bun:test";
import { parseSpeechPreferences } from "./speechPreferences";

test("speech preferences default safely and validate persisted values", () => {
  for (const value of [
    null,
    "",
    "not JSON",
    "null",
    "[]",
    "{}",
    '{"voiceURI":3,"rate":"fast"}',
  ]) {
    expect(parseSpeechPreferences(value)).toEqual({ voiceURI: "", rate: 1 });
  }
  expect(parseSpeechPreferences('{"voiceURI":"test","rate":1.3}')).toEqual({
    voiceURI: "test",
    rate: 1.3,
  });
  expect(parseSpeechPreferences('{"rate":99}').rate).toBe(2);
  expect(parseSpeechPreferences('{"rate":-1}').rate).toBe(0.5);
  expect(parseSpeechPreferences('{"rate":1e999}').rate).toBe(1);
});

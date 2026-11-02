import { expect, test } from "bun:test";
import { attachedImages, parseSessionImages } from "./session-images";

const message = (...data: string[]) => ({
  type: "user",
  message: {
    role: "user",
    content: [
      { type: "text", text: data.map((_, n) => `[Image #${n + 1}]`).join(" ") },
      ...data.map((value) => ({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: value },
      })),
    ],
  },
});
const hashes = (record: ReturnType<typeof message>) =>
  attachedImages(record.message.content).map((image) => image.hash);

test("an image's size is decoded from its base64", () => {
  expect(attachedImages(message("aGk=").message.content)).toEqual([
    { media_type: "image/png", bytes: 2, hash: expect.any(String) },
  ]);
  // Not base64: left out.
  expect(attachedImages(message("<svg>").message.content)).toEqual([]);
  for (const malformed of ["a", "a=", "aa=", "aaaa="])
    expect(attachedImages(message(malformed).message.content)).toEqual([]);
});

test("a session keeps the data of its most recent messages' images, whole messages within its cap", () => {
  const big = (letter: string) => letter.repeat(5 * 1024 * 1024);
  const oldest = message(big("A"));
  const middle = message(big("B"), big("C"));
  const newest = message(big("D"));
  const images = parseSessionImages([oldest, middle, newest]);
  expect(Object.keys(images).sort()).toEqual(
    [...hashes(middle), ...hashes(newest)].sort(),
  );
  expect(images[hashes(newest)[0]!]).toEqual({
    media_type: "image/png",
    data: big("D"),
  });
  // An image the next message carries again is kept once.
  const again = parseSessionImages([newest, message(big("D"))]);
  expect(Object.keys(again)).toEqual(hashes(newest));
});

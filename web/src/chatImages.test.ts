import { describe, expect, test } from "bun:test";
import { attachedImagePieces, messageImagePieces } from "./chatImages";

const PNG =
  "/var/folders/9w/T/roamgate-uploads-501/upload-PkYw2p/img-1793284936305-iiuqcn.png";

describe("messageImagePieces", () => {
  test("separates an uploaded image from the words around it", () => {
    expect(
      messageImagePieces(`${PNG}  I can't access the 2 comments on top`),
    ).toEqual([
      { image: PNG },
      { text: "I can't access the 2 comments on top" },
    ]);
    expect(messageImagePieces(`Look: ${PNG}\nand ${PNG}`)).toEqual([
      { text: "Look:" },
      { image: PNG },
      { text: "and" },
      { image: PNG },
    ]);
  });

  test("takes Windows paths", () => {
    const path =
      "C:\\Users\\me\\AppData\\Local\\Temp\\roamgate-uploads-me\\upload-x\\a.JPG";
    expect(messageImagePieces(path)).toEqual([{ image: path }]);
  });

  test("leaves other paths and files as text", () => {
    for (const text of [
      "/tmp/shot.png is broken",
      "/tmp/roamgate-uploads-501/upload-x/notes.pdf",
      `${PNG}.bak`,
    ])
      expect(messageImagePieces(text)).toEqual([{ text }]);
  });

  test("takes a path between quotes, brackets or before punctuation", () => {
    for (const [before, after] of [
      ["see ", ", then"],
      ["(", ")"],
      ["`", "`"],
      ['"', '".'],
      ["", "."],
    ])
      expect(messageImagePieces(`${before}${PNG}${after}`)).toContainEqual({
        image: PNG,
      });
  });

  test("takes only whole paths", () => {
    for (const text of [
      "C:\\Users\\John Smith\\AppData\\Local\\Temp\\roamgate-uploads-me\\upload-x\\a.png",
      `foo${PNG}`,
    ])
      expect(messageImagePieces(text)).toEqual([{ text }]);
  });
});

describe("attachedImagePieces", () => {
  test("puts the images a Claude message carried where it shows [Image #N]", () => {
    expect(
      attachedImagePieces("[Image #3] why is this red? [Image #4]", [
        "blob:a",
        "blob:b",
      ]),
    ).toEqual([
      { image: "Image #3", url: "blob:a" },
      { text: "why is this red?" },
      { image: "Image #4", url: "blob:b" },
    ]);
  });

  test("keeps a mark with no image as text, and shows an image with no mark", () => {
    expect(
      attachedImagePieces("[Image #1] and [Image #2]", ["blob:a"]),
    ).toEqual([
      { image: "Image #1", url: "blob:a" },
      { text: "and [Image #2]" },
    ]);
    expect(attachedImagePieces("look", ["blob:a"])).toEqual([
      { text: "look" },
      { image: "Image #1", url: "blob:a" },
    ]);
  });
});

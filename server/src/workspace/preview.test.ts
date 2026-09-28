import { describe, expect, test } from "bun:test";
import { PREVIEW_IMAGE_MAX_BYTES, PREVIEW_MAX_BYTES } from "./file-constants";
import {
  decodePreviewBuffer,
  imageMimeForPath,
  inlinePreviewMimeForPath,
  previewLimitForPath,
  trimIncompleteUtf8Tail,
} from "./preview";

describe("workspace preview helpers", () => {
  test("detects supported image MIME types", () => {
    expect(imageMimeForPath("image.PNG")).toBe("image/png");
    expect(imageMimeForPath("photo.jpeg")).toBe("image/jpeg");
    expect(imageMimeForPath("archive.tar")).toBeNull();
  });

  test("detects MIME types allowed for inline previews", () => {
    expect(inlinePreviewMimeForPath("docs/guide.PDF")).toBe("application/pdf");
    expect(inlinePreviewMimeForPath("images/demo.webp")).toBe("image/webp");
    expect(inlinePreviewMimeForPath("page.html")).toBeNull();
    expect(inlinePreviewMimeForPath("vector.svg")).toBe("image/svg+xml");
    expect(inlinePreviewMimeForPath("voice/take.WAV")).toBe("audio/wav");
    expect(inlinePreviewMimeForPath("song.mp3")).toBe("audio/mpeg");
    expect(inlinePreviewMimeForPath("clip.m4a")).toBe("audio/mp4");
    expect(inlinePreviewMimeForPath("video.mp4")).toBeNull();
  });

  test("chooses larger limits only for previewable images", () => {
    expect(previewLimitForPath("photo.png", PREVIEW_IMAGE_MAX_BYTES)).toBe(
      PREVIEW_IMAGE_MAX_BYTES,
    );
    expect(previewLimitForPath("photo.png", PREVIEW_IMAGE_MAX_BYTES + 1)).toBe(
      PREVIEW_MAX_BYTES,
    );
    expect(previewLimitForPath("notes.txt", 10)).toBe(PREVIEW_MAX_BYTES);
  });

  test("decodes text previews and flags binary data", () => {
    expect(
      decodePreviewBuffer(Buffer.from("hello"), false, "README.md"),
    ).toEqual({
      text: "hello",
      binary: false,
    });
    expect(
      decodePreviewBuffer(Buffer.from([0, 1, 2]), false, "data.bin"),
    ).toEqual({
      text: null,
      binary: true,
      mime_type: undefined,
    });
  });

  test("returns data URLs for complete image previews", () => {
    const preview = decodePreviewBuffer(
      Buffer.from("png-data"),
      false,
      "a.png",
    );
    expect(preview.binary).toBe(true);
    expect(preview.mime_type).toBe("image/png");
    expect(preview.image_data_url).toBe("data:image/png;base64,cG5nLWRhdGE=");
  });

  test("previews SVG and additional browser image formats as image data", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10"/></svg>';
    const preview = decodePreviewBuffer(Buffer.from(svg), false, "vector.SVG");
    expect(preview).toMatchObject({
      binary: true,
      text: null,
      mime_type: "image/svg+xml",
    });
    expect(preview.image_data_url).toBe(
      `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
    );
    expect(imageMimeForPath("animation.apng")).toBe("image/apng");
    expect(imageMimeForPath("photo.jfif")).toBe("image/jpeg");
    expect(imageMimeForPath("photo.jpe")).toBe("image/jpeg");
    expect(previewLimitForPath("vector.svg", 1024)).toBe(
      PREVIEW_IMAGE_MAX_BYTES,
    );
    expect(
      decodePreviewBuffer(Buffer.from(svg), true, "vector.svg").image_data_url,
    ).toBeUndefined();
  });

  test("trims incomplete UTF-8 tails for truncated text", () => {
    const buffer = Buffer.from("hello 😀");
    const trimmed = trimIncompleteUtf8Tail(
      buffer.subarray(0, buffer.length - 1),
    );
    expect(trimmed.toString("utf8")).toBe("hello ");

    const preview = decodePreviewBuffer(
      buffer.subarray(0, buffer.length - 1),
      true,
      "README.md",
    );
    expect(preview).toEqual({ text: "hello ", binary: false });
  });
});

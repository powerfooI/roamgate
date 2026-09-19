import { imageMimeForPath } from "../../../shared/filePreview";
import { PREVIEW_IMAGE_MAX_BYTES, PREVIEW_MAX_BYTES } from "./file-constants";

export { imageMimeForPath } from "../../../shared/filePreview";

export function trimIncompleteUtf8Tail(buffer: Buffer) {
  if (!buffer.length) return buffer;
  let leadIndex = buffer.length - 1;
  while (leadIndex >= 0 && (buffer[leadIndex] & 0xc0) === 0x80) {
    leadIndex -= 1;
  }
  if (leadIndex < 0) return Buffer.alloc(0);
  const lead = buffer[leadIndex];
  let expected = 1;
  if (lead >= 0xc2 && lead <= 0xdf) {
    expected = 2;
  } else if (lead >= 0xe0 && lead <= 0xef) {
    expected = 3;
  } else if (lead >= 0xf0 && lead <= 0xf4) {
    expected = 4;
  }
  return buffer.length - leadIndex < expected
    ? buffer.subarray(0, leadIndex)
    : buffer;
}

export function inlinePreviewMimeForPath(path: string) {
  if (path.toLowerCase().endsWith(".pdf")) return "application/pdf";
  return imageMimeForPath(path);
}

export function previewLimitForPath(path: string, size: number) {
  return imageMimeForPath(path) && size <= PREVIEW_IMAGE_MAX_BYTES
    ? PREVIEW_IMAGE_MAX_BYTES
    : PREVIEW_MAX_BYTES;
}

export function decodePreviewBuffer(
  buffer: Buffer,
  truncated = false,
  path = "",
) {
  const imageMime = imageMimeForPath(path);
  if (imageMime && !truncated) {
    return {
      text: null,
      binary: true,
      mime_type: imageMime,
      image_data_url: `data:${imageMime};base64,${buffer.toString("base64")}`,
    };
  }
  if (buffer.includes(0)) {
    return { text: null, binary: true, mime_type: imageMime ?? undefined };
  }
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(buffer),
      binary: false,
    };
  } catch {
    if (truncated) {
      const trimmed = trimIncompleteUtf8Tail(buffer);
      if (trimmed.length !== buffer.length) {
        try {
          return {
            text: new TextDecoder("utf-8", { fatal: true }).decode(trimmed),
            binary: false,
          };
        } catch {
          // Fall through to binary detection when invalid bytes appear before the cut point.
        }
      }
    }
    return { text: null, binary: true, mime_type: imageMime ?? undefined };
  }
}

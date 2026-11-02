import { createHash } from "node:crypto";
import { isRecord } from "./session-utils";

/**
 * An image a user message carried: Claude Code keeps an image pasted into
 * its prompt in the message, as [Image #N] in its text. History entries
 * carry its type, size and hash; agent_history.entry adds its data.
 */
export type HistoryImage = {
  media_type: string;
  /** Decoded size. */
  bytes: number;
  /** A content hash: where its data is kept, and tells it apart. */
  hash: string;
  /** Base64, from agent_history.entry only. */
  data?: string;
};
type ImageData = { media_type: string; data: string };

/** Image types a browser shows, as Claude Code records them. */
const IMAGE_TYPE = /^image\/(?:png|jpeg|gif|webp)$/;
/** Base64 characters: a larger image is left out. */
const MAX_IMAGE_CHARS = 16 * 1024 * 1024;
/** Base64 characters a session keeps, for its most recent messages. */
const MAX_SESSION_IMAGE_CHARS = 16 * 1024 * 1024;

function imageData(parts: readonly unknown[]): ImageData[] {
  const images: ImageData[] = [];
  for (const part of parts) {
    if (!isRecord(part) || part.type !== "image" || !isRecord(part.source))
      continue;
    const { type, media_type, data } = part.source;
    if (
      type === "base64" &&
      typeof media_type === "string" &&
      IMAGE_TYPE.test(media_type) &&
      typeof data === "string" &&
      data.length > 0 &&
      data.length % 4 !== 1 &&
      (!data.endsWith("=") || data.length % 4 === 0) &&
      data.length <= MAX_IMAGE_CHARS &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(data)
    )
      images.push({ media_type, data });
  }
  return images;
}

function imageHash(data: string) {
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

/** The images a user message carries, in their order, without their data. */
export function attachedImages(parts: readonly unknown[]): HistoryImage[] {
  return imageData(parts).map(({ media_type, data }) => ({
    media_type,
    bytes:
      Math.floor((data.length * 3) / 4) - (/=*$/.exec(data)?.[0].length ?? 0),
    hash: imageHash(data),
  }));
}

/**
 * The data of the images Claude Code user messages carried, by hash: whole
 * messages, the most recent first, up to MAX_SESSION_IMAGE_CHARS. An older
 * message's images show as its [Image #N] text.
 */
export function parseSessionImages(
  records: readonly Record<string, unknown>[],
): Record<string, ImageData> {
  const images: Record<string, ImageData> = {};
  let chars = 0;
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index]!;
    const message = record.message;
    if (
      record.type !== "user" ||
      record.isMeta === true ||
      !isRecord(message) ||
      !Array.isArray(message.content)
    )
      continue;
    const found = imageData(message.content);
    const size = found.reduce((sum, image) => sum + image.data.length, 0);
    if (size === 0) continue;
    if (chars + size > MAX_SESSION_IMAGE_CHARS) break;
    chars += size;
    for (const image of found) images[imageHash(image.data)] = image;
  }
  return images;
}

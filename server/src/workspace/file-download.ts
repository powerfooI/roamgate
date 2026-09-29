import {
  AUDIO_INLINE_PREVIEW_MAX_BYTES,
  audioMimeForPath,
} from "../../../shared/filePreview";

export type FileDownloadOptions = {
  inline?: boolean;
  range?: string;
  ifRange?: string;
};

export class FileDownloadError extends Error {
  constructor(
    message: string,
    readonly status: 413 | 416,
    readonly size?: number,
  ) {
    super(message);
  }
}

export function fileDownloadRange(
  path: string,
  size: number,
  options: FileDownloadOptions,
) {
  if (
    options.inline &&
    audioMimeForPath(path) &&
    size > AUDIO_INLINE_PREVIEW_MAX_BYTES
  ) {
    throw new FileDownloadError(
      "Audio is too large to preview. Use Download.",
      413,
    );
  }
  // This endpoint has no validators with which to satisfy If-Range.
  if (options.ifRange !== undefined) return undefined;
  // Unsupported units, malformed headers and multipart ranges use the full response.
  const match = /^bytes=(\d*)-(\d*)$/i.exec(options.range?.trim() ?? "");
  if (!match || (!match[1] && !match[2])) return undefined;
  const total = BigInt(size);
  const start = match[1]
    ? BigInt(match[1])
    : total > BigInt(match[2])
      ? total - BigInt(match[2])
      : 0n;
  const end = match[1] && match[2] ? BigInt(match[2]) : total - 1n;
  if (start >= total || end < start || (!match[1] && BigInt(match[2]) === 0n)) {
    throw new FileDownloadError(
      "Requested range is not satisfiable",
      416,
      size,
    );
  }
  return { start: Number(start), end: Number(end < total ? end : total - 1n) };
}

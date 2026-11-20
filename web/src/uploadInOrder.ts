/**
 * Uploads from a message box: several at once, a few at a time, so a batch
 * of photos picked on a phone goes up in parallel without flooding a slow
 * link. The results keep the order the files were picked in, and a failed
 * file never drops the others.
 */

/** How many files upload at once. */
export const UPLOAD_CONCURRENCY = 3;

export type UploadResult =
  | { file: File; path: string }
  | { file: File; error: unknown };

export type UploadProgress = { done: number; total: number };

export async function uploadInOrder(
  files: readonly File[],
  upload: (file: File) => Promise<string>,
  {
    concurrency = UPLOAD_CONCURRENCY,
    onSettled,
  }: {
    concurrency?: number;
    /** After each file, uploaded or failed, with its index in `files`. */
    onSettled?: (
      progress: UploadProgress,
      result: UploadResult,
      index: number,
    ) => void;
  } = {},
): Promise<UploadResult[]> {
  const results: UploadResult[] = new Array(files.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < files.length) {
      const index = next++;
      const file = files[index]!;
      let result: UploadResult;
      try {
        result = { file, path: await upload(file) };
      } catch (error) {
        result = { file, error };
      }
      results[index] = result;
      done++;
      onSettled?.({ done, total: files.length }, result, index);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(concurrency, files.length)) },
      worker,
    ),
  );
  return results;
}

export function uploadedPaths(results: readonly UploadResult[]): string[] {
  return results.flatMap((result) => ("path" in result ? [result.path] : []));
}

/**
 * What to say when some files did not upload: which ones, and why, as one
 * line for the composer's error. Null when every file uploaded.
 */
export function uploadFailureMessage(
  results: readonly UploadResult[],
  fallback = "Upload failed",
): string | null {
  const failed = results.filter(
    (result): result is { file: File; error: unknown } => "error" in result,
  );
  if (failed.length === 0) return null;
  const reason = (error: unknown) =>
    error instanceof Error && error.message ? error.message : fallback;
  const name = (file: File) => file.name || "a file";
  if (failed.length === 1)
    return `${name(failed[0]!.file)} did not upload: ${reason(failed[0]!.error)}`;
  const reasons = [...new Set(failed.map((result) => reason(result.error)))];
  return `${failed.length} of ${results.length} files did not upload (${failed
    .map((result) => name(result.file))
    .join(", ")}): ${reasons.join("; ")}`;
}

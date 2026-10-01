import type { GitDiffEntry, GitDiffFile } from "../types";
import { LARGE_DIFF_PATCH_BYTES } from "../../../shared/gitDiffLimits";

export { LARGE_DIFF_PATCH_BYTES } from "../../../shared/gitDiffLimits";

export const LARGE_DIFF_CHANGED_LINES = 1000;
export const LARGE_DIFF_FILE_BYTES = 256 * 1024;

export type DiffAutoCollapseInfo = {
  reason: "generated" | "large" | "truncated";
  label: string;
};

export function diffChangedLineCount(entry: GitDiffEntry) {
  return (entry.additions ?? 0) + (entry.deletions ?? 0);
}

export function diffAutoCollapseInfo(
  entry: GitDiffEntry,
  file?: GitDiffFile | null,
): DiffAutoCollapseInfo | null {
  if (entry.generated) {
    return { reason: "generated", label: "generated file" };
  }
  if (file?.truncated) {
    return { reason: "truncated", label: "large diff" };
  }
  const changedLines = diffChangedLineCount(entry);
  if (changedLines >= LARGE_DIFF_CHANGED_LINES) {
    return {
      reason: "large",
      label: `${changedLines.toLocaleString("en-US")} changed lines`,
    };
  }
  if ((entry.file_size ?? 0) >= LARGE_DIFF_FILE_BYTES) {
    return { reason: "large", label: "large file" };
  }
  if (file?.deferred || (file?.patch_size ?? 0) >= LARGE_DIFF_PATCH_BYTES) {
    return { reason: "large", label: "large diff" };
  }
  return null;
}

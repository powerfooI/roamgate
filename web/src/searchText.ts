/** Folds case and separator punctuation so queries match displayed labels. */
export function normalizeSearchText(value: string) {
  return value
    .toLowerCase()
    .replace(/[-_:/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

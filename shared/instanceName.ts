export const MAX_TITLE_SUFFIX_LENGTH = 32;

export type InstanceSettings = { title_suffix: string };

export function normalizeTitleSuffix(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Title suffix must be text");
  }
  const suffix = value.trim().replace(/\s+/gu, " ");
  if ([...suffix].length > MAX_TITLE_SUFFIX_LENGTH) {
    throw new Error(
      `Title suffix must be ${MAX_TITLE_SUFFIX_LENGTH} characters or fewer`,
    );
  }
  // Keep labels single-line plain text without invisible control characters.
  if (
    [...suffix].some((character) => {
      const point = character.codePointAt(0)!;
      return (
        point < 32 ||
        (point >= 127 && point <= 159) ||
        (point >= 0x202a && point <= 0x202e) ||
        (point >= 0x2066 && point <= 0x2069)
      );
    })
  ) {
    throw new Error("Title suffix must not contain control characters");
  }
  return suffix;
}

export function instanceDisplayName(suffix: string): string {
  return suffix ? `Roamgate \u00b7 ${suffix}` : "Roamgate";
}

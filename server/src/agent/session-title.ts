/**
 * What a Claude session is about: the name the user gave it (`/rename`),
 * else the title Claude Code wrote for it, the latest of each as both can
 * change. Null when the transcript holds neither.
 */
export function parseSessionTitle(records: unknown[]): string | null {
  let custom: string | null = null;
  let generated: string | null = null;
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const { type, customTitle, aiTitle } = record as {
      type?: unknown;
      customTitle?: unknown;
      aiTitle?: unknown;
    };
    if (type === "custom-title" && typeof customTitle === "string")
      custom = customTitle.trim() || null;
    else if (type === "ai-title" && typeof aiTitle === "string")
      generated = aiTitle.trim() || null;
  }
  return custom ?? generated;
}

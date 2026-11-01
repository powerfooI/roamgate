/** A command the user can type in a Claude session: `/name`. */
export type AgentCommand = { name: string; description: string };

/**
 * The skills and custom commands a Claude session offers, from the listings
 * Claude Code records in its transcript (the first one whole, later ones
 * adding to it). Built-in commands are not recorded there.
 */
export function parseSessionCommands(records: unknown[]): AgentCommand[] {
  const commands = new Map<string, string>();
  for (const record of records) {
    const attachment = (record as { attachment?: unknown } | null)?.attachment;
    if (!attachment || typeof attachment !== "object") continue;
    const listing = attachment as {
      type?: unknown;
      names?: unknown;
      content?: unknown;
    };
    if (listing.type !== "skill_listing" || !Array.isArray(listing.names))
      continue;
    const content = typeof listing.content === "string" ? listing.content : "";
    const lines = content.split("\n");
    for (const name of listing.names) {
      if (typeof name !== "string" || !/^[\w:.-]{1,100}$/.test(name)) continue;
      // "- name: what it does", or "- name (alias): what it does".
      const line = lines.find(
        (each) =>
          each.startsWith(`- ${name}:`) || each.startsWith(`- ${name} (`),
      );
      const description =
        line?.slice(line.indexOf(":", 2 + name.length) + 1).trim() ?? "";
      commands.set(name, description.slice(0, 300));
    }
  }
  return [...commands]
    .map(([name, description]) => ({ name, description }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

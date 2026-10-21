export type AgentIntegration = {
  target: string;
  label: string;
  command: string;
  available: boolean;
  state: "not_installed" | "current" | "outdated";
  installed_version?: number;
  available_version?: number;
};

export function parseAgentIntegrations(result: unknown): AgentIntegration[] {
  const items = (result as { integrations?: unknown } | null)?.integrations;
  const targets = new Set<string>();
  if (
    !Array.isArray(items) ||
    !items.every((item) => {
      if (
        !item ||
        typeof item.target !== "string" ||
        !item.target.trim() ||
        targets.has(item.target) ||
        typeof item.label !== "string" ||
        !item.label.trim() ||
        typeof item.command !== "string" ||
        typeof item.available !== "boolean" ||
        !["not_installed", "current", "outdated"].includes(item.state) ||
        [item.installed_version, item.available_version].some(
          (version) =>
            version !== undefined &&
            (!Number.isSafeInteger(version) || version < 0),
        )
      )
        return false;
      targets.add(item.target);
      return true;
    })
  )
    throw new Error("Invalid integration list received from Herdr.");
  return items;
}

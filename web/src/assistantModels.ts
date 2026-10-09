import type {
  AssistantChatSelection,
  AssistantConfig,
  AssistantSnapshot,
  AssistantThinkingLevel,
} from "../../shared/assistant";

export const thinkingLabels: Record<AssistantThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
};

export function assistantChatSelection(
  snapshot: AssistantSnapshot,
): AssistantChatSelection {
  const { provider, model, credential_source, thinking_level } =
    snapshot.config;
  return {
    instance_id: snapshot.instance_id,
    provider,
    model,
    credential_source,
    ...(thinking_level ? { thinking_level } : {}),
  };
}

export function sameAssistantSelection(
  a: AssistantSnapshot,
  b: AssistantSnapshot,
) {
  return (
    JSON.stringify(assistantChatSelection(a)) ===
    JSON.stringify(assistantChatSelection(b))
  );
}

export function thinkingForModel(
  config: AssistantConfig,
  model: AssistantSnapshot["models"][number] | undefined,
): AssistantThinkingLevel | undefined {
  return config.thinking_level &&
    model?.thinking_levels?.includes(config.thinking_level)
    ? config.thinking_level
    : undefined;
}

export function thinkingOptions(
  model: AssistantSnapshot["models"][number] | undefined,
  config?: AssistantConfig,
) {
  const levels = model?.thinking_levels ?? [];
  return model?.default_thinking_level &&
    (levels.length > 1 ||
      (config?.thinking_level && !levels.includes(config.thinking_level)))
    ? [
        {
          value: "default",
          label: `Default (${thinkingLabels[model.default_thinking_level]})`,
        },
        ...levels.map((value) => ({ value, label: thinkingLabels[value] })),
      ]
    : [];
}

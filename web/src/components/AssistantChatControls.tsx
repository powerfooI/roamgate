import type { AssistantSnapshot } from "../../../shared/assistant";
import {
  assistantChatSelection,
  thinkingForModel,
  thinkingLabels,
  thinkingOptions,
} from "../assistantModels";
import { ThemedSelect } from "./ThemedSelect";
import "./AssistantChatControls.css";

export function AssistantChatControls({
  snapshot,
  disabled,
  mobile,
  onChange,
  onSelectedClose,
}: {
  snapshot: AssistantSnapshot;
  disabled: boolean;
  mobile: boolean;
  onChange: (params: Record<string, unknown>) => void;
  onSelectedClose: () => void;
}) {
  const config = snapshot.config;
  const modelKey = (provider: string, id: string) =>
    JSON.stringify([provider, id]);
  const models = snapshot.models.filter((model) =>
    snapshot.providers.some(
      (provider) => provider.id === model.provider && provider.configured,
    ),
  );
  const current = models.find(
    (model) => model.provider === config.provider && model.id === config.model,
  );
  const options = models.map((model) => ({
    value: modelKey(model.provider, model.id),
    label: model.label,
    detail:
      snapshot.providers.find((provider) => provider.id === model.provider)
        ?.label ?? model.provider,
    keywords: [model.id, model.provider],
  }));
  const efforts = thinkingOptions(current, config);
  const staleEffort =
    !!config.thinking_level &&
    !!current?.thinking_levels &&
    !current.thinking_levels.includes(config.thinking_level);
  const effective = config.thinking_level ?? current?.default_thinking_level;
  const supported = snapshot.chat_selection === true;
  const unavailable = !supported
    ? "Update Roamgate to use quick model settings"
    : !models.length
      ? "Connect a provider in Ranger settings"
      : "Choose a model";
  return (
    <div className="assistant-chat-controls" aria-label="Ranger model settings">
      <ThemedSelect
        value={modelKey(config.provider, config.model)}
        options={options}
        aria-label="Chat model"
        title={
          current
            ? `${current.label} (${current.provider}). Changes apply to the next message.`
            : unavailable
        }
        placeholder={
          current?.label ??
          (config.model ? `${config.model} (unavailable)` : unavailable)
        }
        disabled={disabled || !supported || !models.length}
        className="assistant-chat-model"
        contentClassName={`assistant-chat-select ${mobile ? "is-mobile" : ""}`}
        side="top"
        searchPlaceholder="Search models"
        onSelectedClose={onSelectedClose}
        onChange={(value) => {
          const model = models.find(
            (model) => modelKey(model.provider, model.id) === value,
          );
          if (!model || value === modelKey(config.provider, config.model))
            return;
          onChange({
            provider: model.provider,
            model: model.id,
            thinking_level: thinkingForModel(config, model) ?? null,
            expected: assistantChatSelection(snapshot),
          });
        }}
      />
      <ThemedSelect
        value={config.thinking_level ?? "default"}
        options={efforts}
        aria-label="Thinking effort"
        title={
          efforts.length
            ? "Thinking effort for the next message"
            : current
              ? "This model has no adjustable thinking effort"
              : unavailable
        }
        placeholder={
          staleEffort
            ? `Unavailable (${thinkingLabels[config.thinking_level!]})`
            : effective
              ? `Thinking: ${thinkingLabels[effective]}`
              : "Thinking unavailable"
        }
        disabled={disabled || !supported || !efforts.length}
        className="assistant-chat-effort"
        contentClassName={`assistant-chat-select ${mobile ? "is-mobile" : ""}`}
        side="top"
        onSelectedClose={onSelectedClose}
        onChange={(value) => {
          if (value === (config.thinking_level ?? "default")) return;
          onChange({
            provider: config.provider,
            model: config.model,
            thinking_level: value === "default" ? null : value,
            expected: assistantChatSelection(snapshot),
          });
        }}
      />
      {snapshot.running ? (
        <span className="assistant-chat-next" role="status">
          Next message
        </span>
      ) : null}
    </div>
  );
}

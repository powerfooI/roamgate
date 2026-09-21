import type { AtifMetrics, TokenUsage } from "./session-types";
import { isRecord, numberValue, stringValue } from "./session-utils";

export function tokenUsageFrom(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null;
  const piInput = numberValue(value.input);
  const piCacheWrite = numberValue(value.cacheWrite);
  const kimiInput =
    numberValue(value.inputOther) ?? numberValue(value.input_other);
  const kimiCacheCreation =
    numberValue(value.inputCacheCreation) ??
    numberValue(value.input_cache_creation);
  const kimiCachedInput =
    numberValue(value.inputCacheRead) ?? numberValue(value.input_cache_read);
  const kimiOutput = numberValue(value.output);
  const usage: TokenUsage = {
    input_tokens:
      numberValue(value.input_tokens) ??
      numberValue(value.inputTokens) ??
      numberValue(value.prompt_tokens) ??
      numberValue(value.promptTokens) ??
      (piInput !== undefined || piCacheWrite !== undefined
        ? (piInput ?? 0) + (piCacheWrite ?? 0)
        : undefined) ??
      (kimiInput !== undefined || kimiCacheCreation !== undefined
        ? (kimiInput ?? 0) + (kimiCacheCreation ?? 0)
        : undefined),
    cached_input_tokens:
      numberValue(value.cached_input_tokens) ??
      numberValue(value.cache_read_input_tokens) ??
      numberValue(value.cacheReadInputTokens) ??
      numberValue(value.cacheRead) ??
      kimiCachedInput,
    output_tokens:
      numberValue(value.output_tokens) ??
      numberValue(value.outputTokens) ??
      numberValue(value.completion_tokens) ??
      numberValue(value.completionTokens) ??
      kimiOutput,
    reasoning_output_tokens:
      numberValue(value.reasoning_output_tokens) ??
      numberValue(value.reasoningOutputTokens) ??
      numberValue(value.reasoning),
    total_tokens:
      numberValue(value.total_tokens) ??
      numberValue(value.totalTokens) ??
      numberValue(value.tokens),
  };
  return Object.values(usage).some((item) => item !== undefined) ? usage : null;
}

function addTokenCount(a?: number, b?: number) {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}

function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: addTokenCount(a.input_tokens, b.input_tokens),
    cached_input_tokens: addTokenCount(
      a.cached_input_tokens,
      b.cached_input_tokens,
    ),
    output_tokens: addTokenCount(a.output_tokens, b.output_tokens),
    reasoning_output_tokens: addTokenCount(
      a.reasoning_output_tokens,
      b.reasoning_output_tokens,
    ),
    ...(a.prompt_tokens !== undefined || b.prompt_tokens !== undefined
      ? {
          prompt_tokens:
            a.prompt_tokens === null || b.prompt_tokens === null
              ? null
              : (a.prompt_tokens ?? 0) + (b.prompt_tokens ?? 0),
        }
      : {}),
    total_tokens:
      a.total_tokens === null || b.total_tokens === null
        ? null
        : addTokenCount(a.total_tokens, b.total_tokens),
  };
}

export function tokenUsageToMetrics(
  usage: TokenUsage | null,
): AtifMetrics | undefined {
  if (!usage) return undefined;
  const metrics: AtifMetrics = {};
  const prompt =
    usage.prompt_tokens === undefined
      ? usage.input_tokens
      : usage.prompt_tokens;
  if (typeof prompt === "number") metrics.prompt_tokens = prompt;
  if (usage.output_tokens !== undefined) {
    metrics.completion_tokens = usage.output_tokens;
  }
  if (usage.cached_input_tokens !== undefined) {
    metrics.cached_tokens = usage.cached_input_tokens;
  }
  const extra: Record<string, unknown> = {};
  if (usage.reasoning_output_tokens !== undefined) {
    extra.reasoning_output_tokens = usage.reasoning_output_tokens;
  }
  if (typeof usage.total_tokens === "number")
    extra.total_tokens = usage.total_tokens;
  if (usage.prompt_tokens !== undefined && usage.input_tokens !== undefined)
    extra.raw_input_tokens = usage.input_tokens;
  if (Object.keys(extra).length > 0) metrics.extra = extra;
  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

export function tokenUsageForRecord(
  record: Record<string, unknown>,
  museProvider = "",
): {
  usage: TokenUsage | null;
  cumulative: boolean;
} {
  if (
    record.type === "event_msg" &&
    isRecord(record.payload) &&
    record.payload.type === "token_count" &&
    isRecord(record.payload.info)
  ) {
    return {
      usage: tokenUsageFrom(record.payload.info.total_token_usage),
      cumulative: true,
    };
  }
  if (record.payload_type === "runtime.session") {
    const payload = isRecord(record.payload) ? record.payload : {};
    const event = isRecord(payload.event) ? payload.event : {};
    if (
      payload.kind !== "run" ||
      event.kind !== "model_completed" ||
      !isRecord(event.usage)
    )
      return { usage: null, cumulative: false };
    const usage = tokenUsageFrom({
      ...event.usage,
      cached_input_tokens:
        event.usage.cached_tokens ?? event.usage.cache_read_tokens,
      reasoning_output_tokens: event.usage.reasoning_tokens,
    });
    if (usage) {
      // Muse 1.3 MSP view/page: Anthropic cache is additive; Meta/OpenAI/echo
      // include it in input. Unknown cached conventions remain explicitly unknown.
      const cached = usage.cached_input_tokens ?? 0;
      const known = ["meta", "openai", "echo", "anthropic"].includes(
        museProvider,
      );
      const ambiguous =
        !known &&
        (cached > 0 || (numberValue(event.usage.cache_write_tokens) ?? 0) > 0);
      usage.prompt_tokens =
        ambiguous || usage.input_tokens === undefined
          ? null
          : usage.input_tokens + (museProvider === "anthropic" ? cached : 0);
      usage.total_tokens =
        usage.prompt_tokens === null || usage.output_tokens === undefined
          ? null
          : usage.prompt_tokens + usage.output_tokens;
    }
    return { usage, cumulative: false };
  }
  const candidates = [
    record.usage,
    isRecord(record.message) ? record.message.usage : undefined,
    isRecord(record.payload) ? record.payload.usage : undefined,
  ];
  for (const candidate of candidates) {
    const usage = tokenUsageFrom(candidate);
    if (usage) return { usage, cumulative: false };
  }
  return { usage: null, cumulative: false };
}

// Provider routing belongs to a run, not the session's startup metadata: a
// resumed session may switch providers. Keep the reader shared by stats/ATIF.
export function createTokenUsageReader() {
  const museProviders = new Map<string, string>();
  return (record: Record<string, unknown>) => {
    const payload = isRecord(record.payload) ? record.payload : {};
    if (
      record.payload_type === "run.model.configured" &&
      isRecord(payload.record)
    ) {
      const stream = payload.record.run_stream;
      if (isRecord(stream) && stream.kind === "run")
        museProviders.set(
          stringValue(stream.id),
          stringValue(payload.record.provider_id),
        );
    }
    return tokenUsageForRecord(
      record,
      museProviders.get(stringValue(payload.run_id)),
    );
  };
}

export function summarizeTokenUsage(records: Record<string, unknown>[]) {
  const readUsage = createTokenUsageReader();
  let cumulative: TokenUsage | null = null;
  let summed: TokenUsage = {};
  for (const record of records) {
    const next = readUsage(record);
    if (!next.usage) continue;
    if (next.cumulative) {
      cumulative = next.usage;
    } else {
      summed = addTokenUsage(summed, next.usage);
    }
  }
  return (
    cumulative ??
    (Object.values(summed).some((value) => value !== undefined) ? summed : null)
  );
}

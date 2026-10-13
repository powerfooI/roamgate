import type {
  AssistantMessageEvent,
  Model,
  Provider,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const LEGACY_AZURE_PROVIDER = "azure-openai-responses";

function azureContext(context: TranscriptContext): TranscriptContext {
  return {
    ...context,
    messages: context.messages.map((message) =>
      message.role === "assistant" &&
      message.provider === LEGACY_AZURE_PROVIDER &&
      message.api === "azure-openai-responses"
        ? { ...message, provider: "azure" }
        : message,
    ),
  };
}

async function* legacyEvents(source: AsyncIterable<AssistantMessageEvent>) {
  for await (const event of source) {
    if (event.type === "done")
      yield {
        ...event,
        message: { ...event.message, provider: LEGACY_AZURE_PROVIDER },
      };
    else if (event.type === "error")
      yield {
        ...event,
        error: { ...event.error, provider: LEGACY_AZURE_PROVIDER },
      };
    else
      yield {
        ...event,
        partial: { ...event.partial, provider: LEGACY_AZURE_PROVIDER },
      };
  }
}

export async function registerLegacyAzureProvider(runtime: ModelRuntime) {
  const [{ azureProvider }, { lazyStream }] = await Promise.all([
    import("@earendil-works/pi-ai/providers/azure"),
    import("@earendil-works/pi-ai/api/lazy"),
  ]);
  const azure = azureProvider();
  const getModels = () =>
    azure
      .getModels()
      .filter(
        (model): model is Model<"azure-openai-responses"> =>
          model.api === "azure-openai-responses",
      )
      .map((model) => ({ ...model, provider: LEGACY_AZURE_PROVIDER }));
  const legacy: Provider<"azure-openai-responses"> = {
    id: LEGACY_AZURE_PROVIDER,
    name: "Azure OpenAI (legacy ID)",
    auth: azure.auth,
    getModels,
    getAllModels: getModels,
    // The current Azure transport recognizes its new provider ID when replaying
    // Responses tool item IDs and reasoning. Adapt only at the transport boundary;
    // credentials, model overrides, durable references, and results keep the old ID.
    stream: (model, context, options) =>
      lazyStream(model, async () =>
        legacyEvents(
          azure.stream(
            { ...model, provider: "azure" },
            azureContext(context),
            options,
          ),
        ),
      ),
    streamSimple: (model, context, options) =>
      lazyStream(model, async () =>
        legacyEvents(
          azure.streamSimple(
            { ...model, provider: "azure" },
            azureContext(context),
            options,
          ),
        ),
      ),
  };
  // Pi 1.1's public registration API always starts an availability refresh, which
  // can execute !command keys. This unpublished runtime must stay credential-blind
  // until a requested login or model request. Suppress only that synchronous call.
  const refresh = Object.getOwnPropertyDescriptor(runtime, "refresh");
  Object.defineProperty(runtime, "refresh", {
    configurable: true,
    value: async () => ({ aborted: false, errors: new Map() }),
  });
  try {
    runtime.registerNativeProvider(legacy);
  } finally {
    if (refresh) Object.defineProperty(runtime, "refresh", refresh);
    else Reflect.deleteProperty(runtime, "refresh");
  }
}

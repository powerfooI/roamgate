import type { AssistantConfig } from "../../../shared/assistant";
import { isRecord } from "../agent/session-utils";
import {
  CLAUDE_CODE_PROVIDER,
  type ClaudeCodeDriver,
  createClaudeCodeDriver,
  isClaudeCodePointer,
} from "./claude-driver";
import { createRangerMcp, type RangerMcp } from "./claude-mcp";
import { type AssistantDriver, createPiDriver } from "./pi-driver";

let sharedMcp: RangerMcp | undefined;

function isPiPointer(entries: readonly unknown[]) {
  return (
    entries.length === 1 &&
    isRecord(entries[0]) &&
    entries[0].type === "ranger-durable"
  );
}

/**
 * Ranger's model driver: Claude Code for its own provider, Pi for every
 * other. A chat that changes driver starts afresh: neither can read the
 * other's saved context.
 */
export function createRangerDriver(
  directory: string,
  credentialDirectory = directory,
  drivers: { pi?: AssistantDriver; claude?: ClaudeCodeDriver } = {},
): AssistantDriver {
  const pi =
    drivers.pi ?? createPiDriver(directory, undefined, credentialDirectory);
  const claude =
    drivers.claude ??
    createClaudeCodeDriver({
      directory,
      mcp: (sharedMcp ??= createRangerMcp()),
    });
  const isClaude = (config: Pick<AssistantConfig, "provider">) =>
    config.provider === CLAUDE_CODE_PROVIDER;
  let running: "pi" | "claude" | undefined;
  return {
    async catalog(source) {
      const own = claude.catalog();
      let other: Awaited<ReturnType<AssistantDriver["catalog"]>>;
      try {
        other = await pi.catalog(source);
      } catch (error) {
        // Pi's models failing to load must not hide Claude Code.
        if (!own.providers.some((provider) => provider.configured)) throw error;
        other = { providers: [], models: [] };
      }
      return {
        providers: [...own.providers, ...other.providers],
        models: [...own.models, ...other.models],
      };
    },
    async configureModel(input, save) {
      if (input.provider === CLAUDE_CODE_PROVIDER)
        throw new Error("Use a distinct custom provider identifier");
      if (!pi.configureModel) throw new Error("Invalid model connection");
      await pi.configureModel(input, save);
    },
    readToolDetails: pi.readToolDetails
      ? (entries, messages, sourceDirectory) =>
          isPiPointer(entries)
            ? pi.readToolDetails!(entries, messages, sourceDirectory)
            : Promise.resolve(structuredClone(messages))
      : undefined,
    async login(provider, method, interaction) {
      if (provider === CLAUDE_CODE_PROVIDER)
        throw new Error("Claude Code signs in with `claude` on this machine");
      await pi.login(provider, method, interaction);
    },
    async run(input) {
      const kind = isClaude(input.config) ? "claude" : "pi";
      const entries =
        kind === "claude"
          ? isClaudeCodePointer(input.entries)
            ? input.entries
            : []
          : isPiPointer(input.entries)
            ? input.entries
            : [];
      running = kind;
      try {
        return kind === "claude"
          ? await claude.run({ ...input, entries })
          : await pi.run({ ...input, entries });
      } finally {
        if (running === kind) running = undefined;
      }
    },
    async steer(input) {
      // Claude Code takes no input into a running turn: the caller queues
      // it as a follow-up.
      if (running !== "pi" || !pi.steer)
        throw new Error("Ranger is not running");
      await pi.steer(input);
    },
    async stop() {
      await Promise.all([pi.stop(), claude.stop()]);
    },
    async dispose() {
      await Promise.all([pi.dispose(), claude.dispose()]);
    },
  };
}

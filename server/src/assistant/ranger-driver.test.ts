import { describe, expect, test } from "bun:test";
import type { AssistantConfig } from "../../../shared/assistant";
import { CLAUDE_CODE_PROVIDER, type ClaudeCodeDriver } from "./claude-driver";
import type { AssistantDriver } from "./pi-driver";
import { createRangerDriver } from "./ranger-driver";

type RunInput = Parameters<AssistantDriver["run"]>[0];

function fakes(
  options: {
    piCatalog?: () => Promise<unknown>;
    claudeConfigured?: boolean;
  } = {},
) {
  const runs: [string, unknown[]][] = [];
  const steered: string[] = [];
  const pi = {
    catalog:
      options.piCatalog ??
      (async () => ({
        providers: [
          { id: "igalia", label: "Igalia", methods: [], configured: true },
        ],
        models: [
          {
            provider: "igalia",
            id: "ember-1",
            label: "ember-1",
            thinking_levels: [],
          },
        ],
      })),
    configureModel: async () => {},
    login: async () => {},
    run: async (input: RunInput) => {
      runs.push(["pi", input.entries]);
      return [{ type: "ranger-durable", id: "d" }];
    },
    steer: async ({ text }: { text: string }) => {
      steered.push(text);
    },
    stop: async () => {},
    dispose: async () => {},
  } as unknown as AssistantDriver;
  const claude = {
    catalog: () => ({
      providers: [
        {
          id: CLAUDE_CODE_PROVIDER,
          label: "Claude Code",
          methods: [],
          configured: options.claudeConfigured ?? true,
        },
      ],
      models: [],
    }),
    run: async (input: RunInput) => {
      runs.push(["claude", input.entries]);
      return [{ type: "ranger-claude", session: "s" }];
    },
    stop: async () => {},
    dispose: async () => {},
  } as unknown as ClaudeCodeDriver;
  return {
    driver: createRangerDriver("/tmp/x", "/tmp/x", { pi, claude }),
    runs,
    steered,
  };
}

const input = (provider: string, entries: unknown[]) =>
  ({
    config: {
      provider,
      model: "m",
      credential_source: "pi",
      allowed_workspaces: [],
    } as AssistantConfig,
    entries,
    text: "Hi",
    signal: new AbortController().signal,
    read: async () => ({ text: "" }),
    delta: () => {},
    message: () => {},
    tool: () => {},
    error: () => {},
  }) as RunInput;

const claudePointer = {
  type: "ranger-claude",
  session: "0b0e8a52-7a4b-4c55-9d3e-2f4a8a1c9d10",
};
const piPointer = {
  type: "ranger-durable",
  id: "0b0e8a52-7a4b-4c55-9d3e-2f4a8a1c9d10",
};

describe("Ranger's driver", () => {
  test("offers Claude Code next to Pi's providers", async () => {
    const { driver } = fakes();
    const catalog = await driver.catalog("pi");
    expect(catalog.providers.map((provider) => provider.id)).toEqual([
      CLAUDE_CODE_PROVIDER,
      "igalia",
    ]);
  });

  test("Pi failing to load does not hide Claude Code, unless it is missing too", async () => {
    const failing = () =>
      Promise.reject(new Error("Invalid model configuration"));
    expect(
      (await fakes({ piCatalog: failing }).driver.catalog("pi")).providers.map(
        (provider) => provider.id,
      ),
    ).toEqual([CLAUDE_CODE_PROVIDER]);
    await expect(
      fakes({ piCatalog: failing, claudeConfigured: false }).driver.catalog(
        "pi",
      ),
    ).rejects.toThrow("Invalid model configuration");
  });

  test("each turn goes to its provider's driver, with only its own context", async () => {
    const { driver, runs } = fakes();
    await driver.run(input(CLAUDE_CODE_PROVIDER, [claudePointer]));
    await driver.run(input(CLAUDE_CODE_PROVIDER, [piPointer]));
    await driver.run(input("igalia", [piPointer]));
    await driver.run(input("igalia", [claudePointer]));
    expect(runs).toEqual([
      ["claude", [claudePointer]],
      ["claude", []],
      ["pi", [piPointer]],
      ["pi", []],
    ]);
  });

  test("only a running Pi turn takes steering; a Claude turn queues it", async () => {
    const gate = () => {
      let open: () => void = () => {};
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { opened, open };
    };
    const piGate = gate();
    const claudeGate = gate();
    const steered: string[] = [];
    const driver = createRangerDriver("/tmp/x", "/tmp/x", {
      pi: {
        run: async () => {
          await piGate.opened;
          return [];
        },
        steer: async ({ text }: { text: string }) => {
          steered.push(text);
        },
      } as unknown as AssistantDriver,
      claude: {
        run: async () => {
          await claudeGate.opened;
          return [];
        },
      } as unknown as ClaudeCodeDriver,
    });
    const steer = (text: string) => driver.steer!({ text, requestId: text });
    await expect(steer("idle")).rejects.toThrow("Ranger is not running");
    const piTurn = driver.run(input("igalia", []));
    await steer("to pi");
    piGate.open();
    await piTurn;
    const claudeTurn = driver.run(input(CLAUDE_CODE_PROVIDER, []));
    await expect(steer("to claude")).rejects.toThrow("Ranger is not running");
    claudeGate.open();
    await claudeTurn;
    expect(steered).toEqual(["to pi"]);
  });

  test("Claude Code has no model connection or sign-in of its own", async () => {
    const { driver } = fakes();
    await expect(
      driver.configureModel!(
        {
          provider: CLAUDE_CODE_PROVIDER,
          model: "opus",
          base_url: "https://x",
          api: "anthropic-messages",
          credential_source: "pi",
        },
        () => {},
      ),
    ).rejects.toThrow();
    await expect(
      driver.login(
        CLAUDE_CODE_PROVIDER,
        "oauth",
        {} as Parameters<AssistantDriver["login"]>[2],
      ),
    ).rejects.toThrow("Claude Code signs in");
  });
});

import { expect, test } from "bun:test";
import {
  parseAgentIntegrations,
  type AgentIntegration,
} from "./AgentIntegrationsSettings";

const integration: AgentIntegration = {
  target: "antigravity_cli",
  label: "Antigravity CLI",
  command: "agy",
  available: true,
  state: "not_installed",
};

test("integration list preserves server targets and supports new agents", () => {
  const integrations: AgentIntegration[] = [
    integration,
    {
      ...integration,
      target: "future_agent",
      state: "current",
      available: false,
    },
    {
      ...integration,
      target: "pi",
      state: "outdated",
      installed_version: 7,
      available_version: 9,
    },
  ];
  expect(parseAgentIntegrations({ integrations })).toEqual(integrations);
  expect(parseAgentIntegrations({ integrations: [] })).toEqual([]);
});

test("integration versions stay unknown unless independently reported by the server", () => {
  const entries = parseAgentIntegrations({
    integrations: [
      { ...integration, target: "missing", state: "outdated" },
      {
        ...integration,
        target: "installed_only",
        state: "current",
        installed_version: 99,
      },
      {
        ...integration,
        target: "available_only",
        state: "outdated",
        available_version: 9,
      },
      {
        ...integration,
        target: "independent",
        state: "current",
        installed_version: 99,
        available_version: 9,
      },
    ],
  });
  expect(entries[0]).not.toHaveProperty("installed_version");
  expect(entries[0]).not.toHaveProperty("available_version");
  expect(entries[1].installed_version).toBe(99);
  expect(entries[1]).not.toHaveProperty("available_version");
  expect(entries[2]).not.toHaveProperty("installed_version");
  expect(entries[2].available_version).toBe(9);
  expect(entries[3].installed_version).toBe(99);
  expect(entries[3].available_version).toBe(9);
});

test("integration list rejects malformed state instead of enabling mutations", () => {
  for (const result of [
    null,
    {},
    { integrations: {} },
    { integrations: [null] },
    { integrations: [integration, integration] },
    ...[
      { target: "" },
      { label: null },
      { command: 1 },
      { available: "true" },
      { state: "unknown" },
      { installed_version: "7" },
      { installed_version: -1 },
      { available_version: 1.5 },
      { available_version: Number.MAX_SAFE_INTEGER + 1 },
    ].map((override) => ({ integrations: [{ ...integration, ...override }] })),
  ])
    expect(() => parseAgentIntegrations(result)).toThrow(
      "Invalid integration list",
    );
});

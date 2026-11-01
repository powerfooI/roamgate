import { describe, expect, test } from "bun:test";
import { AgentAutoRenameSettings } from "./AgentAutoRenameSettings";

describe("AgentAutoRenameSettings", () => {
  test("is exported as a React component function", () => {
    expect(typeof AgentAutoRenameSettings).toBe("function");
  });
});

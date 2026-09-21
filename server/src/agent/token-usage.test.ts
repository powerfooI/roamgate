import { describe, expect, test } from "bun:test";
import {
  summarizeTokenUsage,
  tokenUsageFrom,
  tokenUsageToMetrics,
} from "./token-usage";

describe("agent session token usage", () => {
  test("normalizes OpenAI-style token usage", () => {
    expect(
      tokenUsageFrom({
        prompt_tokens: 10,
        completion_tokens: 5,
        cached_input_tokens: 3,
        reasoning_output_tokens: 2,
        total_tokens: 17,
      }),
    ).toEqual({
      input_tokens: 10,
      cached_input_tokens: 3,
      output_tokens: 5,
      reasoning_output_tokens: 2,
      total_tokens: 17,
    });
  });

  test("normalizes Kimi-style token usage", () => {
    expect(
      tokenUsageFrom({
        inputOther: 10,
        inputCacheCreation: 4,
        inputCacheRead: 6,
        output: 8,
      }),
    ).toEqual({
      input_tokens: 14,
      cached_input_tokens: 6,
      output_tokens: 8,
      reasoning_output_tokens: undefined,
      total_tokens: undefined,
    });
  });

  test("normalizes Pi-style token usage", () => {
    expect(
      tokenUsageFrom({
        input: 10,
        output: 8,
        cacheRead: 6,
        cacheWrite: 4,
        reasoning: 3,
        totalTokens: 28,
      }),
    ).toEqual({
      input_tokens: 14,
      cached_input_tokens: 6,
      output_tokens: 8,
      reasoning_output_tokens: 3,
      total_tokens: 28,
    });
  });

  test("prefers cumulative token count records over summed usage", () => {
    const summary = summarizeTokenUsage([
      { usage: { input_tokens: 1, output_tokens: 1 } },
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 100,
              output_tokens: 20,
              cached_input_tokens: 30,
            },
          },
        },
      },
    ]);

    expect(summary).toEqual({
      input_tokens: 100,
      cached_input_tokens: 30,
      output_tokens: 20,
      reasoning_output_tokens: undefined,
      total_tokens: undefined,
    });
  });

  test("preserves reported zeros while distinguishing absent counters", () => {
    const zero = {
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 0,
    };
    expect(summarizeTokenUsage([{ usage: zero }, { usage: zero }])).toEqual(
      zero,
    );
    expect(
      summarizeTokenUsage([{ usage: { output_tokens: 0 } }]),
    ).toMatchObject({
      output_tokens: 0,
      input_tokens: undefined,
      total_tokens: undefined,
    });
    expect(
      summarizeTokenUsage([
        { usage: zero },
        { usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } },
      ]),
    ).toMatchObject({
      ...zero,
      input_tokens: 2,
      output_tokens: 1,
      total_tokens: 3,
    });
    expect(summarizeTokenUsage([{ usage: {} }])).toBeNull();
  });

  test("maps token usage into ATIF metrics", () => {
    expect(
      tokenUsageToMetrics({
        input_tokens: 10,
        cached_input_tokens: 2,
        output_tokens: 3,
        reasoning_output_tokens: 4,
        total_tokens: 15,
      }),
    ).toEqual({
      prompt_tokens: 10,
      cached_tokens: 2,
      completion_tokens: 3,
      extra: { reasoning_output_tokens: 4, total_tokens: 15 },
    });
  });
});

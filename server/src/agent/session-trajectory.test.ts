import { describe, expect, test } from "bun:test";
import type { SessionFile } from "./session-types";
import { projectAgentTrajectory } from "./session-trajectory";

const sessionFile: SessionFile = {
  path: "/tmp/session.jsonl",
  mtimeMs: Date.parse("2026-07-07T00:00:00.000Z"),
  size: 100,
};

describe("agent session trajectory projection", () => {
  test("projects Codex sessions without duplicating user messages", () => {
    const trajectory = projectAgentTrajectory("codex", sessionFile, [
      {
        type: "event_msg",
        timestamp: "2026-07-07T00:00:00.000Z",
        payload: { type: "user_message", message: "duplicate" },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-07T00:00:00.500Z",
        payload: { type: "agent_message", message: "duplicate response" },
      },
      {
        type: "response_item",
        timestamp: "2026-07-07T00:00:01.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      },
      {
        type: "response_item",
        timestamp: "2026-07-07T00:00:02.000Z",
        payload: {
          type: "function_call",
          call_id: "call-1",
          name: "read_file",
          arguments: '{"path":"README.md"}',
        },
      },
      {
        type: "response_item",
        timestamp: "2026-07-07T00:00:03.000Z",
        payload: {
          type: "function_call_output",
          call_id: "call-1",
          output: "done",
        },
      },
      {
        type: "response_item",
        timestamp: "2026-07-07T00:00:03.500Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Done" }],
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-07T00:00:04.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 10,
              output_tokens: 2,
              cached_input_tokens: 3,
            },
          },
        },
      },
    ]);

    expect(trajectory.extra?.projection).toBe("roamgate-lightweight");
    expect(trajectory.agent.name).toBe("codex");
    expect(trajectory.session_id).toBe("session");
    expect(trajectory.steps.map((step) => step.message)).toEqual([
      "hello",
      "Tool call: read_file",
      "done",
      "Done",
      "Token usage",
    ]);
    expect(trajectory.steps[1]?.tool_calls?.[0]).toMatchObject({
      tool_call_id: "call-1",
      function_name: "read_file",
      arguments: { path: "README.md" },
    });
    expect(trajectory.steps[2]?.observation?.results[0]).toMatchObject({
      source_call_id: "call-1",
      content: "done",
    });
    expect(trajectory.final_metrics).toMatchObject({
      total_prompt_tokens: 10,
      total_completion_tokens: 2,
      total_cached_tokens: 3,
      total_steps: 5,
    });
  });

  test("projects assistant messages from older Codex event-only sessions", () => {
    const trajectory = projectAgentTrajectory("codex", sessionFile, [
      {
        type: "event_msg",
        timestamp: "2026-07-07T00:00:01.000Z",
        payload: { type: "user_message", message: "hello" },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-07T00:00:02.000Z",
        payload: { type: "agent_message", message: "Hi there" },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-07T00:00:03.000Z",
        payload: { type: "agent_reasoning", text: "internal" },
      },
    ]);

    expect(trajectory.steps.map((step) => step.message)).toEqual([
      "hello",
      "Hi there",
    ]);
  });

  test("projects Kimi loop events without standalone token messages", () => {
    const trajectory = projectAgentTrajectory("kimi", sessionFile, [
      {
        type: "metadata",
        created_at: Date.parse("2026-07-07T00:00:00.000Z"),
      },
      {
        type: "context.append_message",
        message: { role: "user", content: "hi" },
      },
      {
        type: "context.append_message",
        message: { role: "assistant", content: "duplicate assistant output" },
      },
      {
        type: "context.append_loop_event",
        time: Date.parse("2026-07-07T00:00:01.000Z"),
        event: {
          type: "content.part",
          turnId: "turn-1",
          step: 1,
          part: { type: "think", think: "Check the repository" },
        },
      },
      {
        type: "context.append_loop_event",
        time: Date.parse("2026-07-07T00:00:02.000Z"),
        event: {
          type: "content.part",
          turnId: "turn-1",
          step: 1,
          part: { type: "text", text: "Done" },
        },
      },
      {
        type: "context.append_loop_event",
        time: Date.parse("2026-07-07T00:00:03.000Z"),
        event: {
          type: "step.end",
          turnId: "turn-1",
          step: 1,
          usage: {
            inputOther: 4,
            inputCacheCreation: 1,
            inputCacheRead: 2,
            output: 3,
          },
        },
      },
      {
        type: "usage.record",
        usage: {
          inputOther: 4,
          inputCacheCreation: 1,
          inputCacheRead: 2,
          output: 3,
        },
      },
    ]);

    expect(trajectory.agent.name).toBe("kimi-code");
    expect(trajectory.steps.map((step) => step.message)).toEqual([
      "hi",
      "Reasoning",
      "Done",
    ]);
    expect(trajectory.steps[1]?.reasoning_content).toBe("Check the repository");
    expect(trajectory.steps[2]?.metrics).toMatchObject({
      prompt_tokens: 5,
      completion_tokens: 3,
      cached_tokens: 2,
    });
    expect(trajectory.final_metrics).toMatchObject({
      total_prompt_tokens: 5,
      total_completion_tokens: 3,
      total_cached_tokens: 2,
      total_steps: 3,
    });
  });

  test("projects Pi messages, tools, reasoning, and token usage into ATIF", () => {
    const trajectory = projectAgentTrajectory("pi", sessionFile, [
      {
        type: "session",
        version: 3,
        id: "pi-session-1",
        timestamp: "2026-07-07T00:00:00.000Z",
        cwd: "/tmp/project",
      },
      {
        type: "model_change",
        id: "model-1",
        timestamp: "2026-07-07T00:00:00.100Z",
        provider: "anthropic",
        modelId: "claude-sonnet-4",
      },
      {
        type: "message",
        id: "user-1",
        timestamp: "2026-07-07T00:00:01.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "inspect the repo" }],
        },
      },
      {
        type: "message",
        id: "retry-1",
        timestamp: "2026-07-07T00:00:01.500Z",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
          },
        },
      },
      {
        type: "message",
        id: "assistant-1",
        timestamp: "2026-07-07T00:00:02.000Z",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-4",
          stopReason: "toolUse",
          usage: {
            input: 10,
            output: 8,
            cacheRead: 6,
            cacheWrite: 4,
            reasoning: 3,
            totalTokens: 28,
          },
          content: [
            { type: "thinking", thinking: "Find the relevant file" },
            {
              type: "toolCall",
              id: "call-1",
              name: "read",
              arguments: { path: "README.md" },
            },
          ],
        },
      },
      {
        type: "message",
        id: "result-1",
        timestamp: "2026-07-07T00:00:03.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          isError: false,
          content: [{ type: "text", text: "# Project" }],
        },
      },
      {
        type: "message",
        id: "assistant-2",
        timestamp: "2026-07-07T00:00:04.000Z",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-4",
          stopReason: "stop",
          usage: {
            input: 2,
            output: 1,
            cacheRead: 3,
            cacheWrite: 0,
            totalTokens: 6,
          },
          content: [{ type: "text", text: "Done" }],
        },
      },
      {
        type: "message",
        id: "assistant-error",
        timestamp: "2026-07-07T00:00:05.000Z",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-4",
          stopReason: "error",
          errorMessage: "429 rate limit exceeded",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
          },
          content: [],
        },
      },
    ]);

    expect(trajectory.session_id).toBe("pi-session-1");
    expect(trajectory.trajectory_id).toBe("pi-session-1");
    expect(trajectory.agent).toEqual({
      name: "pi",
      version: "unknown",
      model_name: "claude-sonnet-4",
    });
    expect(trajectory.steps.map((step) => step.message)).toEqual([
      "inspect the repo",
      "Tool call: read",
      "# Project",
      "Done",
      "Error: 429 rate limit exceeded",
    ]);
    expect(trajectory.steps[1]).toMatchObject({
      reasoning_content: "Find the relevant file",
      metrics: {
        prompt_tokens: 20,
        cached_tokens: 6,
        completion_tokens: 8,
        extra: { reasoning_output_tokens: 3, total_tokens: 28 },
      },
    });
    expect(trajectory.steps[1]?.tool_calls?.[0]).toMatchObject({
      tool_call_id: "call-1",
      function_name: "read",
      arguments: { path: "README.md" },
    });
    expect(trajectory.steps[2]?.observation?.results[0]).toMatchObject({
      source_call_id: "call-1",
      content: "# Project",
      extra: { tool_name: "read" },
    });
    expect(trajectory.final_metrics).toMatchObject({
      total_prompt_tokens: 25,
      total_cached_tokens: 9,
      total_completion_tokens: 9,
      total_steps: 5,
    });
    expect(trajectory.steps[4]?.extra).toMatchObject({
      stop_reason: "error",
      error_message: "429 rate limit exceeded",
    });
  });

  test("projects Grok Build chat history into ATIF", () => {
    const grokFile: SessionFile = {
      ...sessionFile,
      path: "/tmp/chat_history.jsonl",
      sessionId: "grok-session-1",
      createdAtMs: Date.parse("2026-07-07T00:00:00.000Z"),
      modelName: "grok-4.5",
    };
    const trajectory = projectAgentTrajectory("grok", grokFile, [
      {
        type: "user",
        content: [
          {
            type: "text",
            text: "<user_info>ignored</user_info>\n<user_query>hello</user_query>",
          },
        ],
      },
      {
        type: "user",
        synthetic_reason: "system_reminder",
        content: [{ type: "text", text: "duplicate context" }],
      },
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Inspect files" }],
        status: "completed",
      },
      {
        type: "assistant",
        content: "I will inspect it.",
        tool_calls: [
          {
            id: "call-1",
            name: "read_file",
            arguments: '{"target_file":"README.md"}',
          },
        ],
      },
      {
        type: "tool_result",
        tool_call_id: "call-1",
        content: "# Project",
      },
      { type: "assistant", content: "Done" },
    ]);

    expect(trajectory.session_id).toBe("grok-session-1");
    expect(trajectory.trajectory_id).toBe("grok-session-1");
    expect(trajectory.agent).toMatchObject({
      name: "grok-build",
      model_name: "grok-4.5",
    });
    expect(trajectory.steps.map((step) => step.message)).toEqual([
      "hello",
      "Reasoning",
      "I will inspect it.",
      "# Project",
      "Done",
    ]);
    expect(trajectory.steps[1]?.reasoning_content).toBe("Inspect files");
    expect(trajectory.steps[2]?.tool_calls?.[0]).toMatchObject({
      tool_call_id: "call-1",
      function_name: "read_file",
      arguments: { target_file: "README.md" },
    });
    expect(trajectory.steps[3]?.observation?.results[0]).toMatchObject({
      source_call_id: "call-1",
      content: "# Project",
    });
  });

  test("projects Antigravity sessions into normalized ATIF trajectory", () => {
    const trajectory = projectAgentTrajectory(
      "agy",
      {
        path: "/tmp/conversations/test-uuid.db",
        mtimeMs: Date.parse("2026-07-07T00:00:00.000Z"),
        sessionId: "test-uuid",
        modelName: "gemini-3.8-flash",
      },
      [
        {
          type: "user",
          timestamp: "2026-07-07T00:00:00.000Z",
          content: "Hello Antigravity",
        },
        {
          type: "reasoning",
          timestamp: "2026-07-07T00:00:01.000Z",
          summary: "Thinking about the prompt",
        },
        {
          type: "assistant",
          timestamp: "2026-07-07T00:00:02.000Z",
          content: "I will check the file",
          reasoning: "Checking workspace",
          tool_calls: [
            {
              id: "call_1",
              name: "view_file",
              arguments: { AbsolutePath: "/dev/pult/README.md" },
            },
          ],
          usage: {
            input_tokens: 120,
            output_tokens: 45,
            cached_input_tokens: 30,
          },
        },
        {
          type: "tool_result",
          timestamp: "2026-07-07T00:00:03.000Z",
          tool_call_id: "call_1",
          tool_name: "view_file",
          content: "# Pult",
        },
        {
          type: "assistant",
          timestamp: "2026-07-07T00:00:04.000Z",
          content: "Done checking!",
          usage: {
            input_tokens: 150,
            output_tokens: 25,
          },
        },
      ],
    );

    expect(trajectory.session_id).toBe("test-uuid");
    expect(trajectory.agent).toMatchObject({
      name: "antigravity-cli",
      version: "antigravity-cli",
      model_name: "gemini-3.8-flash",
    });
    expect(trajectory.steps.map((step) => step.message)).toEqual([
      "Hello Antigravity",
      "Reasoning",
      "I will check the file",
      "# Pult",
      "Done checking!",
    ]);
    expect(trajectory.steps[1]?.reasoning_content).toBe(
      "Thinking about the prompt",
    );
    expect(trajectory.steps[2]?.tool_calls?.[0]).toMatchObject({
      tool_call_id: "call_1",
      function_name: "view_file",
      arguments: { AbsolutePath: "/dev/pult/README.md" },
    });
    expect(trajectory.steps[3]?.observation?.results[0]).toMatchObject({
      source_call_id: "call_1",
      content: "# Pult",
    });
    expect(trajectory.final_metrics).toMatchObject({
      total_prompt_tokens: 270,
      total_completion_tokens: 70,
      total_cached_tokens: 30,
      total_steps: 5,
    });
  });
});

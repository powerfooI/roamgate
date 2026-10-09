import { afterEach, expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssistantMention,
  AssistantMentionTarget,
  AssistantTaskNotification,
  AssistantWorkspace,
} from "../../../shared/assistant";
import type { AssistantContext } from "./context";
import type { AssistantDriver } from "./pi-driver";
import { createAssistantService } from "./service";

const services: ReturnType<typeof createAssistantService>[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  jest.useRealTimers();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test.each([false, true])(
  "confirmed task binds the selected session after reconnect and blocks replacement notifications (replaced: %s)",
  async (replaced) => {
    const workspace: AssistantWorkspace = {
      connection_id: "local",
      workspace_id: "workspace",
      connection_label: "Local",
      label: "Workspace",
      runtime_generation: 7,
    };
    const target: Extract<AssistantMentionTarget, { kind: "agent" }> = {
      kind: "agent",
      connection_id: workspace.connection_id,
      workspace_id: workspace.workspace_id,
      connection_label: workspace.connection_label,
      workspace_label: workspace.label,
      runtime_generation: workspace.runtime_generation,
      label: "Codex",
      pane_id: "pane",
      terminal_id: "terminal",
      agent: "codex",
      agent_identity: "c".repeat(64),
    };
    const marker: AssistantMention = { ...target, start: 8, end: 14 };
    const scope = [{ connection_id: "local", workspace_id: "workspace" }];
    let generation = workspace.runtime_generation;
    let identity = target.agent_identity;
    const context: AssistantContext = {
      catalog: async () => ({
        workspaces: [{ ...workspace, runtime_generation: generation }],
        errors: [],
      }),
      captureScope: async () => [
        { ...workspace, runtime_generation: generation },
      ],
      recoveryScope: async () => [
        {
          ...scope[0]!,
          endpoint_fingerprint: "a".repeat(64),
          workspace_identity: "b".repeat(64),
          herdr_boot_id: "same-server",
        },
      ],
      restoreScope: async (targets) => {
        if (
          targets.some(
            (ref) =>
              ref.workspace_identity !== "b".repeat(64) ||
              ref.herdr_boot_id !== "same-server",
          )
        )
          throw new Error("Original workspace changed");
        return [{ ...workspace, runtime_generation: generation }];
      },
      bindMentions: async (captured, targets) => {
        if (
          targets.some(
            (ref) =>
              ref.kind !== "agent" ||
              ref.agent_identity !== identity ||
              ref.runtime_generation !== captured[0]!.runtime_generation,
          )
        )
          throw new Error("Mentioned agent session changed");
        return structuredClone(targets);
      },
      read: async () => ({ text: "Verified", sources: [] }),
    };
    const catalog = {
      providers: [
        {
          id: "test",
          label: "Test",
          methods: ["api_key" as const],
          configured: true,
        },
      ],
      models: [{ provider: "test", id: "model", label: "Model" }],
    };
    const base = {
      catalog: async () => structuredClone(catalog),
      login: async () => {},
      stop: async () => {},
    };
    const rootFinished = Promise.withResolvers<void>();
    const childStarted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const childFinished = Promise.withResolvers<void>();
    let childPrompt = "";
    let notificationError: unknown;
    let receipt: unknown;
    const child: AssistantDriver = {
      ...base,
      dispose: async () => release.resolve(),
      run: async (input) => {
        childPrompt = input.text;
        childStarted.resolve();
        await release.promise;
        try {
          receipt = JSON.parse(
            (
              await input.notify!({
                event_key: "selected-agent:finished",
                kind: "completed",
                title: "Agent completed",
                body: "The selected session finished successfully.",
              })
            ).text,
          );
        } catch (error) {
          notificationError = error;
        } finally {
          childFinished.resolve();
        }
        return [];
      },
    };
    const driver: AssistantDriver = {
      ...base,
      dispose: async () => {},
      run: async (input) => {
        await input.task!("create", {
          title: "Monitor selected Agent",
          prompt: "Notify when the selected Agent finishes",
          scope,
          schedule: { type: "interval", minutes: 1 },
          notification_mode: "agent",
        });
        return [];
      },
    };
    const directory = mkdtempSync(join(tmpdir(), "ranger-mention-task-"));
    directories.push(directory);
    const notifications: AssistantTaskNotification[] = [];
    let admitted = false;
    const service = createAssistantService({
      directory,
      context,
      driver,
      createDriver: () => child,
      notify: (notification) => notifications.push(notification),
      publish: (snapshot) => {
        if (snapshot.running) admitted = true;
        else if (admitted) rootFinished.resolve();
      },
    });
    services.push(service);
    await service.handle("configure", {
      provider: "test",
      model: "model",
      credential_source: "assistant",
      allowed_workspaces: scope,
    });
    await service.handle("send", {
      request_id: "monitor-agent",
      text: "Monitor @Codex",
      mentions: [marker],
    });
    await rootFinished.promise;
    const proposal = service.peek().messages.at(-1)!.task_proposals![0]!;
    expect(proposal.mentions).toEqual([target]);
    await service.handle("task.confirm_proposal", { proposal_id: proposal.id });
    generation = 8;
    jest.useFakeTimers();
    await service.resume();
    const task = service.peek().tasks![0]!;
    await service.handle("task.run_now", { task_id: task.id });
    jest.advanceTimersByTime(0);
    await childStarted.promise;
    expect(childPrompt).toContain(
      JSON.stringify({ ...target, runtime_generation: 8 }),
    );
    if (replaced) identity = "d".repeat(64);
    release.resolve();
    await childFinished.promise;
    if (replaced) {
      expect(notificationError).toBeInstanceOf(Error);
      expect(receipt).toBeUndefined();
      expect(notifications).toEqual([]);
    } else {
      expect(notificationError).toBeUndefined();
      expect(receipt).toEqual({ accepted: true, delivery: "best_effort" });
      expect(notifications).toHaveLength(1);
      expect(notifications[0]!.title).toBe("Agent completed");
    }
  },
);

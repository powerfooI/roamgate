import { expect, test } from "bun:test";
import { DEFAULT_JIRA_PRESETS, type JiraIssue } from "../../../shared/jira";
import { canCreateTask, presetPrompt, syncBackHint } from "./NewTaskDialog";

const issue = {
  key: "SDS-1679",
  summary: "Back button does not redirect",
} as JiraIssue;

test("Create task needs a title, a prompt, and for Start now a workspace and agent (AC60)", () => {
  const form = { title: "T", prompt: "P", start: "queue" as const, workspaceId: "", agent: "" };
  expect(canCreateTask(form)).toBe(true);
  expect(canCreateTask({ ...form, title: " " })).toBe(false);
  expect(canCreateTask({ ...form, prompt: "" })).toBe(false);
  expect(canCreateTask({ ...form, start: "now" })).toBe(false);
  expect(canCreateTask({ ...form, start: "now", workspaceId: "w1", agent: "claude" })).toBe(true);
});

test("a preset renders its template against the issue; Custom keeps the prompt (AC53)", () => {
  expect(presetPrompt(DEFAULT_JIRA_PRESETS[0], issue)).toStartWith(
    "Implement SDS-1679: Back button does not redirect.",
  );
  expect(presetPrompt(undefined, issue)).toBeNull();
});

test("sync-back hint names the configured status (AC55)", () => {
  expect(syncBackHint("In Review")).toBe(
    "Comment on the issue and move it to In Review when the task completes",
  );
});

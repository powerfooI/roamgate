import { expect, test } from "bun:test";
import type { AssistantMentionTarget } from "../../shared/assistant";
import {
  adjustAssistantMentions,
  assistantMentionKey,
  assistantMentionQuery,
  insertAssistantMention,
} from "./assistantMentions";

const workspace: AssistantMentionTarget = {
  kind: "workspace",
  connection_id: "local",
  workspace_id: "project",
  runtime_generation: 1,
  connection_label: "Mac",
  workspace_label: "Project",
  label: "Project",
};

test("mention queries recognize caret boundaries including Chinese without capturing email and URL text", () => {
  for (const text of [
    "@",
    "Read @Pro",
    "( @Pro",
    "\u770b\u770b@Pro",
    "\u770b\u770b\uff0c@Pro",
  ])
    expect(assistantMentionQuery(text, text.length)?.query).toBe(
      text.slice(text.lastIndexOf("@") + 1),
    );
  for (const text of [
    "user@example.com",
    "https://host/@Project",
    "name@Project",
    "@Project next",
    "@@Project",
  ])
    expect(assistantMentionQuery(text, text.length)).toBeNull();
  expect(assistantMentionQuery("@Project", 2, 5)).toBeNull();
});

test("reference offsets follow edits around the token and unlink when its exact text changes", () => {
  const draft = insertAssistantMention("Read @Pr please", [], workspace, 5, 8);
  expect(draft.text).toBe("Read @Project  please");
  const shifted = adjustAssistantMentions(
    draft.text,
    "\ud83d\ude80 " + draft.text,
    draft.mentions,
  );
  expect(shifted[0]?.start).toBe(8);
  expect(shifted[0]?.end).toBe(16);
  expect(
    adjustAssistantMentions(draft.text, draft.text + "!", draft.mentions),
  ).toEqual(draft.mentions);
  expect(
    adjustAssistantMentions(
      draft.text,
      draft.text.replace("Project", "Other"),
      draft.mentions,
    ),
  ).toEqual([]);
  expect(
    adjustAssistantMentions(
      draft.text,
      draft.text.replace("@Project", ""),
      draft.mentions,
    ),
  ).toEqual([]);
  expect(adjustAssistantMentions("", "@Project", [])).toEqual([]);
});

test("insertion preserves distinct duplicate labels and replaces only the active query", () => {
  const first = insertAssistantMention("", [], workspace, 0, 0);
  const remote = {
    ...workspace,
    connection_id: "remote",
    connection_label: "Server",
  };
  const next = insertAssistantMention(
    first.text + "versus @",
    first.mentions,
    remote,
    first.text.length + 7,
    first.text.length + 8,
  );
  expect(next.text).toBe("@Project versus @Project ");
  expect(next.mentions).toHaveLength(2);
  expect(assistantMentionKey(next.mentions[0]!)).not.toBe(
    assistantMentionKey(next.mentions[1]!),
  );
  expect(
    next.mentions.map((mention) => next.text.slice(mention.start, mention.end)),
  ).toEqual(["@Project", "@Project"]);
});

test("native edit ranges preserve the correct identity when equal tokens are deleted or replaced", () => {
  const text = "@Project @Project";
  const first = { ...workspace, start: 0, end: 8 };
  const second = { ...workspace, connection_id: "remote", start: 9, end: 17 };
  const references = [first, second];
  expect(
    adjustAssistantMentions(text, "@Project", references, { start: 0, end: 9 }),
  ).toEqual([{ ...second, start: 0, end: 8 }]);
  expect(
    adjustAssistantMentions(text, "@Project", references, {
      start: 8,
      end: 17,
    }),
  ).toEqual([first]);
  expect(
    adjustAssistantMentions(text, "@Project", references, {
      start: 0,
      end: 0,
      inputType: "deleteWordForward",
    }),
  ).toEqual([{ ...second, start: 0, end: 8 }]);
  expect(
    adjustAssistantMentions("@Project", "@Project", [first], {
      start: 0,
      end: 8,
      inputType: "insertFromPaste",
    }),
  ).toEqual([]);
  const replaced = insertAssistantMention(
    text,
    references,
    { ...workspace, connection_id: "third" },
    0,
    8,
  );
  expect(replaced.mentions[0]?.connection_id).toBe("third");
  expect(replaced.mentions).toHaveLength(2);
});

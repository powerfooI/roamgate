import type {
  AssistantMention,
  AssistantMentionTarget,
} from "../../shared/assistant";

export function assistantMentionKey(target: AssistantMentionTarget) {
  return JSON.stringify([
    target.kind,
    target.connection_id,
    target.workspace_id,
    target.runtime_generation,
    ...(target.kind === "agent"
      ? [target.pane_id, target.terminal_id, target.agent_identity]
      : []),
  ]);
}

export function assistantMentionQuery(
  text: string,
  start: number,
  end = start,
) {
  if (start !== end) return null;
  const before = text.slice(0, start);
  const at = before.lastIndexOf("@");
  if (
    at < 0 ||
    (at > 0 &&
      /[\p{L}\p{N}_./:\\@-]/u.test(before[at - 1]!) &&
      !/\p{Script=Han}/u.test(before[at - 1]!)) ||
    /[\s@]/.test(before.slice(at + 1))
  )
    return null;
  return { start: at, end, query: before.slice(at + 1) };
}

export function adjustAssistantMentions(
  previous: string,
  text: string,
  mentions: AssistantMention[],
  edit?: { start: number; end: number; inputType?: string },
) {
  if (previous === text && !edit) return mentions;
  let start = 0;
  while (
    start < previous.length &&
    start < text.length &&
    previous[start] === text[start]
  )
    start++;
  let oldEnd = previous.length;
  let newEnd = text.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    previous[oldEnd - 1] === text[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }
  if (edit) {
    let editStart = edit.start;
    let editEnd = edit.end;
    const removed = previous.length - text.length;
    if (editStart === editEnd && removed > 0) {
      if (edit.inputType?.endsWith("Backward")) editStart -= removed;
      else if (edit.inputType?.endsWith("Forward")) editEnd += removed;
    }
    const inserted = text.length - previous.length + editEnd - editStart;
    if (
      editStart >= 0 &&
      editEnd <= previous.length &&
      inserted >= 0 &&
      previous.slice(0, editStart) === text.slice(0, editStart) &&
      previous.slice(editEnd) === text.slice(editStart + inserted)
    ) {
      start = editStart;
      oldEnd = editEnd;
      newEnd = start + inserted;
    }
  }
  return mentions.flatMap((mention) => {
    const next =
      mention.end <= start
        ? mention
        : mention.start >= oldEnd
          ? {
              ...mention,
              start: mention.start + newEnd - oldEnd,
              end: mention.end + newEnd - oldEnd,
            }
          : null;
    return next && text.slice(next.start, next.end) === `@${next.label}`
      ? [next]
      : [];
  });
}

export function insertAssistantMention(
  text: string,
  mentions: AssistantMention[],
  target: AssistantMentionTarget,
  start: number,
  end: number,
) {
  const token = `@${target.label}`;
  const next = text.slice(0, start) + token + " " + text.slice(end);
  return {
    text: next,
    mentions: [
      ...adjustAssistantMentions(text, next, mentions, { start, end }),
      { ...target, start, end: start + token.length },
    ].sort((a, b) => a.start - b.start),
    caret: start + token.length + 1,
  };
}

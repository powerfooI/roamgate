/**
 * Images attached in the agent chat's message box. The shared draft keeps
 * their uploaded paths, which is what the agent gets; the box shows each as
 * `[Image #N]`, as Claude Code does, with a thumbnail above it.
 */
export type ComposerAttachment = { path: string; name: string; url?: string };

const known = new Map<string, ComposerAttachment>();
/**
 * The most images remembered, most recent last: an older one's thumbnail is
 * released, and its path shows as typed again.
 */
export const REMEMBERED_ATTACHMENTS = 50;

function forget(path: string) {
  const old = known.get(path);
  known.delete(path);
  if (old?.url) {
    try {
      URL.revokeObjectURL(old.url);
    } catch {
      // Nothing to release.
    }
  }
}

export function rememberComposerAttachment(path: string, file: File) {
  let url: string | undefined;
  try {
    url = URL.createObjectURL(file);
  } catch {
    url = undefined;
  }
  forget(path);
  known.set(path, { path, name: file.name || "image", url });
  while (known.size > REMEMBERED_ATTACHMENTS)
    forget(known.keys().next().value!);
}

const PLACEHOLDER = /\[Image #(\d+)\]/g;

export type AttachmentDisplay = {
  /** The draft as the box shows it. */
  text: string;
  attachments: ComposerAttachment[];
  /** The draft for what the box now shows. */
  toDraft: (shown: string) => string;
  /** A position in the box, as a position in the draft. */
  draftOffset: (shown: string, offset: number) => number;
  /** A position in the draft, as a position in the box. */
  shownOffset: (offset: number) => number;
};

/** The attachments a draft holds, in order, and the draft as shown. */
export function attachmentDisplay(draft: string): AttachmentDisplay {
  const found: { at: number; attachment: ComposerAttachment }[] = [];
  for (const attachment of known.values()) {
    let at = draft.indexOf(attachment.path);
    while (at >= 0) {
      found.push({ at, attachment });
      at = draft.indexOf(attachment.path, at + attachment.path.length);
    }
  }
  found.sort((a, b) => a.at - b.at);
  const attachments: ComposerAttachment[] = [];
  // Each replaced path: where it is in the draft, and its placeholder.
  const spans: { at: number; end: number; shown: number; shownEnd: number }[] =
    [];
  let text = "";
  let position = 0;
  for (const { at, attachment } of found) {
    if (at < position) continue;
    let index = attachments.indexOf(attachment);
    if (index < 0) index = attachments.push(attachment) - 1;
    const placeholder = `[Image #${index + 1}]`;
    text += draft.slice(position, at);
    const shown = text.length;
    text += placeholder;
    position = at + attachment.path.length;
    spans.push({ at, end: position, shown, shownEnd: text.length });
  }
  text += draft.slice(position);
  const pathOf = (number: string) => attachments[Number(number) - 1]?.path;
  return {
    text,
    attachments,
    toDraft: (shown) =>
      shown.replace(
        PLACEHOLDER,
        (placeholder, number: string) => pathOf(number) ?? placeholder,
      ),
    draftOffset: (shown, offset) => {
      let delta = 0;
      for (const match of shown.matchAll(PLACEHOLDER)) {
        const path = pathOf(match[1]!);
        if (!path || match.index! >= offset) continue;
        // Inside a placeholder counts as after it.
        delta += path.length - match[0].length;
      }
      return offset + delta;
    },
    shownOffset: (offset) => {
      let shown = offset;
      for (const span of spans) {
        if (span.at >= offset) break;
        // Inside a path counts as after its placeholder.
        if (span.end > offset) return span.shownEnd;
        shown -= span.end - span.at - (span.shownEnd - span.shown);
      }
      return shown;
    },
  };
}

/** The draft without an attachment (and the space after it). */
export function withoutAttachment(draft: string, path: string): string {
  return draft.split(`${path} `).join("").split(path).join("");
}

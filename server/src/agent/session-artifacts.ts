/** A page an agent published with Claude Code's Artifact tool. */
export type PublishedArtifact = {
  url: string;
  title: string;
  // The version number when an existing artifact was updated.
  version?: number;
};

/** An artifact as the session left it: its last publish. */
export type SessionArtifact = PublishedArtifact & { published_at?: string };

const ARTIFACT_URL = String.raw`(https://claude\.ai/(?:code/)?artifact/[\w-]+)`;
const CREATED = new RegExp(
  String.raw`^Created a new Artifact at ${ARTIFACT_URL}`,
);
const PUBLISHED = new RegExp(
  String.raw`^Published \S.*? at ${ARTIFACT_URL}(?: \(Version (\d+))?`,
);

// A page's file name, or its folder's for an index page.
function pageName(path: string) {
  const parts = path.split("/").filter(Boolean);
  const name = (parts.pop() ?? "").replace(/\.[^.]+$/, "");
  return name === "index" ? (parts.pop() ?? name) : name;
}

/**
 * The artifact an Artifact tool call published, from its arguments and
 * output; nothing for its other actions, asset uploads and refusals.
 */
export function publishedArtifact(
  args: Record<string, unknown>,
  output: string,
): PublishedArtifact | undefined {
  if ((args.action ?? "publish") !== "publish" || args.asset === true) return;
  const created = CREATED.exec(output);
  const published = created ? null : PUBLISHED.exec(output);
  const url = created?.[1] ?? published?.[1];
  if (!url) return;
  const title =
    (typeof args.title === "string" && args.title.trim()) ||
    (typeof args.file_path === "string" && pageName(args.file_path)) ||
    "Artifact";
  const version = published?.[2] ? Number(published[2]) : undefined;
  return { url, title, ...(version ? { version } : {}) };
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("\n");
}

/**
 * Every artifact a Claude session published, from its transcript records,
 * each at its latest publish, the most recent first.
 */
export function parseSessionArtifacts(
  records: Record<string, unknown>[],
): SessionArtifact[] {
  const calls = new Map<string, Record<string, unknown>>();
  const artifacts = new Map<string, SessionArtifact>();
  for (const record of records) {
    const message = record.message as { content?: unknown } | undefined;
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content as Record<string, unknown>[]) {
      if (part?.type === "tool_use" && part.name === "Artifact") {
        if (
          typeof part.id === "string" &&
          part.input &&
          typeof part.input === "object"
        )
          calls.set(part.id, part.input as Record<string, unknown>);
      } else if (
        part?.type === "tool_result" &&
        part.is_error !== true &&
        typeof part.tool_use_id === "string"
      ) {
        const args = calls.get(part.tool_use_id);
        const artifact =
          args && publishedArtifact(args, resultText(part.content));
        if (!artifact) continue;
        artifacts.delete(artifact.url);
        artifacts.set(artifact.url, {
          ...artifact,
          ...(typeof record.timestamp === "string"
            ? { published_at: record.timestamp }
            : {}),
        });
      }
    }
  }
  return [...artifacts.values()].reverse();
}

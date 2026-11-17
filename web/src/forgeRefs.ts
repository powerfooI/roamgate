import {
  type ForgeProject,
  type ForgeProvider,
  type ForgeRef,
  type ForgeSession,
  forgeRefKey,
  parseForgeUrl,
  validProject,
} from "../../shared/forge";

/**
 * A merge or pull request named in a message, before it is resolved
 * against the repository the chat is about: a full URL names its host;
 * `group/project!12` and `owner/repo#12` their project; `!12` and `#12`
 * only a number.
 */
export type ForgeMention =
  | { kind: "url"; ref: ForgeRef }
  | { kind: "full"; provider: ForgeProvider; project: string; number: number }
  | { kind: "short"; provider: ForgeProvider; number: number };

export type ForgeMatch = {
  start: number;
  end: number;
  text: string;
  mention: ForgeMention;
};

const URL_PATTERN = /https:\/\/[^\s<>"'`]+/g;
// A project path, then ! (GitLab) or # (GitHub) and the number: not inside
// a word, a path or an e-mail address.
const FULL_PATTERN =
  /(?<![\w./@#!-])([A-Za-z0-9_][\w.-]*(?:\/[\w.-]+)+)([!#])(\d{1,9})(?![\w])/g;
// `!12` (not `!=`, `!!12`, `foo!12`, `!important`) and `#12` (not a
// heading's `##`, `&#12;` or `a#12`).
const SHORT_PATTERN = /(?<![\w!#&/.-])([!#])(\d{1,9})(?![\w]|\.\d)/g;

/** Every request a piece of plain text names, in order. */
export function findForgeMentions(text: string): ForgeMatch[] {
  if (!text || text.length > 200_000) return [];
  const found: ForgeMatch[] = [];
  const taken: [number, number][] = [];
  const free = (start: number, end: number) =>
    !taken.some(([a, b]) => start < b && end > a);
  for (const match of text.matchAll(URL_PATTERN)) {
    // Sentence punctuation after a URL is not part of it.
    const raw = match[0].replace(/[.,;:!?)\]}>*_]+$/, "");
    const start = match.index ?? 0;
    // Any URL is taken, a request's or not: its path is no `a/b!12`.
    taken.push([start, start + match[0].length]);
    const ref = parseForgeUrl(raw);
    if (ref)
      found.push({
        start,
        end: start + raw.length,
        text: raw,
        mention: { kind: "url", ref },
      });
  }
  for (const match of text.matchAll(FULL_PATTERN)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const project = match[1]!;
    if (!free(start, end) || !validProject(project)) continue;
    taken.push([start, end]);
    found.push({
      start,
      end,
      text: match[0],
      mention: {
        kind: "full",
        provider: match[2] === "!" ? "gitlab" : "github",
        project,
        number: Number(match[3]),
      },
    });
  }
  for (const match of text.matchAll(SHORT_PATTERN)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (!free(start, end)) continue;
    const number = Number(match[2]);
    if (number <= 0) continue;
    taken.push([start, end]);
    found.push({
      start,
      end,
      text: match[0],
      mention: {
        kind: "short",
        provider: match[1] === "!" ? "gitlab" : "github",
        number,
      },
    });
  }
  return found.sort((a, b) => a.start - b.start);
}

/**
 * The request a mention names, read against the chat's repository: `!12`
 * only in a GitLab project's chat, `#12` only in a GitHub one's, and a
 * `group/project!12` on that GitLab's host. Null when it names none.
 */
export function resolveForgeMention(
  mention: ForgeMention,
  defaultProject: ForgeProject | null,
): ForgeRef | null {
  if (mention.kind === "url") return mention.ref;
  if (mention.kind === "short") {
    if (!defaultProject || defaultProject.provider !== mention.provider)
      return null;
    return { ...defaultProject, number: mention.number };
  }
  if (mention.provider === "github") {
    // owner/repo only: a deeper path is no GitHub repository.
    if (mention.project.split("/").length !== 2) return null;
    return {
      provider: "github",
      host:
        defaultProject?.provider === "github"
          ? defaultProject.host
          : "github.com",
      project: mention.project,
      number: mention.number,
    };
  }
  if (defaultProject?.provider !== "gitlab") return null;
  return {
    provider: "gitlab",
    host: defaultProject.host,
    project: mention.project,
    number: mention.number,
  };
}

/**
 * The text of a Markdown message without its code: fenced
 * blocks and inline spans are where `!12` is a shell history expansion or
 * `#12` a C preprocessor line, not a request.
 */
export function stripMarkdownCode(text: string): string {
  const blank = (part: string) => part.replace(/[^\n]/g, " ");
  let fence: string | null = null;
  const lines = text.split("\n").map((line) => {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (open && open[0] === fence[0] && open.length >= fence.length)
        fence = null;
      return blank(line);
    }
    if (open) {
      fence = open;
      return blank(line);
    }
    return line;
  });
  return lines.join("\n").replace(/(`+)[^`]*?\1/g, blank);
}

export type ConversationRequestSource = "branch" | "created" | "mentioned";

export type ConversationRequest = {
  ref: ForgeRef;
  key: string;
  sources: ConversationRequestSource[];
  /** The repository's checkout, for a branch's request. */
  root?: string;
  branch?: string;
  /** When the conversation last named it. */
  lastAt?: string;
};

export type ConversationRequestGroup = {
  /** provider:host/project */
  key: string;
  project: ForgeProject;
  /** A checkout of it the session works in. */
  root?: string;
  requests: ConversationRequest[];
};

type ScannedEntry = {
  role: string;
  kind?: string;
  text: string;
  sent_at?: string;
  created_request?: string;
};

function projectKey(project: ForgeProject): string {
  return `${project.provider}:${project.host.toLowerCase()}/${project.project.toLowerCase()}`;
}

const SOURCE_ORDER: ConversationRequestSource[] = [
  "branch",
  "created",
  "mentioned",
];

/**
 * Every request of a conversation: its repositories' branches' (from the
 * session), those it created (`glab mr create`, `gh pr create`) and those
 * its messages name outside code, grouped by repository. Requests of the
 * same repository keep the order they were first seen; the session's
 * repositories come first.
 */
export function conversationRequests(
  entries: readonly ScannedEntry[],
  session: Pick<ForgeSession, "defaultProject" | "repos"> | null,
): ConversationRequestGroup[] {
  const defaultProject = session?.defaultProject ?? null;
  const byKey = new Map<string, ConversationRequest>();
  const add = (
    ref: ForgeRef,
    source: ConversationRequestSource,
    extra: Partial<ConversationRequest> = {},
  ) => {
    const key = forgeRefKey(ref);
    const known = byKey.get(key);
    if (known) {
      if (!known.sources.includes(source)) known.sources.push(source);
      known.sources.sort(
        (a, b) => SOURCE_ORDER.indexOf(a) - SOURCE_ORDER.indexOf(b),
      );
      if (extra.lastAt) known.lastAt = extra.lastAt;
      if (extra.root && !known.root) Object.assign(known, extra);
      return;
    }
    byKey.set(key, { ref, key, sources: [source], ...extra });
  };
  const repoRoots = new Map<string, { root: string; branch: string }>();
  const sessionRefs: ForgeRef[] = [];
  for (const repo of session?.repos ?? []) {
    // A checkout of a fork is where its parent's requests are reviewed too.
    const ref = repo.request ? parseForgeUrl(repo.request.url) : null;
    for (const project of [repo.project, ref])
      if (project && !repoRoots.has(projectKey(project)))
        repoRoots.set(projectKey(project), {
          root: repo.root,
          branch: repo.branch,
        });
    if (!ref) continue;
    sessionRefs.push(ref);
    add(ref, "branch", { root: repo.root, branch: repo.branch });
  }
  for (const entry of entries) {
    if (entry.created_request) {
      const ref = parseForgeUrl(entry.created_request);
      if (ref) add(ref, "created", { lastAt: entry.sent_at });
    }
    if (entry.role === "tool" || (entry.kind && entry.kind !== "message"))
      continue;
    for (const match of findForgeMentions(stripMarkdownCode(entry.text))) {
      const ref = resolveForgeMention(match.mention, defaultProject);
      if (ref) add(ref, "mentioned", { lastAt: entry.sent_at });
    }
  }
  const groups = new Map<string, ConversationRequestGroup>();
  const group = (project: ForgeProject) => {
    const key = projectKey(project);
    let known = groups.get(key);
    if (!known) {
      known = {
        key,
        project: {
          provider: project.provider,
          host: project.host,
          project: project.project,
        },
        root: repoRoots.get(key)?.root,
        requests: [],
      };
      groups.set(key, known);
    }
    return known;
  };
  // The session's repositories first, in its order.
  for (const ref of sessionRefs) group(ref);
  for (const request of byKey.values())
    group(request.ref).requests.push(request);
  return [...groups.values()].filter((entry) => entry.requests.length);
}

/** The session's repositories whose branch has a request, for the header. */
export function branchRequests(
  session: Pick<ForgeSession, "repos"> | null,
): { ref: ForgeRef; root: string; branch: string }[] {
  const seen = new Set<string>();
  const out: { ref: ForgeRef; root: string; branch: string }[] = [];
  for (const repo of session?.repos ?? []) {
    const ref = repo.request ? parseForgeUrl(repo.request.url) : null;
    if (!ref || seen.has(forgeRefKey(ref))) continue;
    seen.add(forgeRefKey(ref));
    out.push({ ref, root: repo.root, branch: repo.branch });
  }
  return out;
}

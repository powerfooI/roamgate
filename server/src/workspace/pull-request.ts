import type {
  PullRequest,
  PullRequestStatus,
  ReviewProvider,
  ReviewRemote,
} from "../../../shared/pullRequest";
import { sshCommandArgv } from "../bridge/ssh-command";
import type { GitActionContext } from "./git-actions";

// Remote URLs and CLI diagnostics can contain credentials. Only project identity
// and explicitly selected provider fields may cross the browser boundary.
export function parseReviewRemote(
  name: string,
  value: string,
): ReviewRemote | null {
  try {
    const scp = value.match(/^(?:[^/@:]+@)?([^/:]+):(.+)$/);
    const url = new URL(
      value.includes("://") ? value : scp ? `ssh://${scp[1]}/${scp[2]}` : "",
    );
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol))
      return null;
    const host = url.protocol === "ssh:" ? url.hostname : url.host;
    const repository = url.pathname
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.git$/, "");
    if (
      !/^[a-z0-9][a-z0-9.-]*(?::\d+)?$/i.test(host) ||
      !/^[\w.-]+(?:\/[\w.-]+)+$/.test(repository) ||
      repository.split("/").some((part) => part === "." || part === "..")
    )
      return null;
    return { name, host: host.toLowerCase(), repository };
  } catch {
    return null;
  }
}

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid provider response");
  return value as Record<string, any>;
}
function text(value: unknown, fallback = "Unknown"): string {
  return typeof value === "string" && value ? value.slice(0, 2000) : fallback;
}
function number(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new Error("Invalid provider identifier");
  return value as number;
}
function list(value: unknown): any[] {
  if (!Array.isArray(value)) throw new Error("Invalid provider list");
  // Never silently choose from a truncated result set.
  if (value.length >= 100) throw new Error("Too many matches");
  return value;
}
function webUrl(host: string, value: unknown): string {
  const url = new URL(String(value));
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.host.toLowerCase() !== host ||
    url.username ||
    url.password
  )
    throw new Error("Invalid provider URL");
  return url.href;
}

export function githubChecks(value: unknown): string {
  if (!Array.isArray(value)) return "Unavailable";
  if (!value.length) return "No checks reported";
  const counts = new Map<string, number>();
  for (const item of value) {
    const check = object(item);
    const state =
      check.__typename === "CheckRun"
        ? check.status === "COMPLETED"
          ? text(check.conclusion)
          : text(check.status)
        : check.__typename === "StatusContext"
          ? text(check.state)
          : "Unknown";
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return [...counts].map(([state, count]) => `${count} ${state}`).join(", ");
}

export function gitlabApprovals(value: unknown): string {
  const data = object(value);
  // approved_by alone does not establish that approval rules are satisfied.
  if (typeof data.approved !== "boolean") {
    return Number.isSafeInteger(data.approvals_left) && data.approvals_left >= 0
      ? `${data.approvals_left} approvals remaining (provider-reported)`
      : "Unavailable";
  }
  const count = Array.isArray(data.approved_by)
    ? data.approved_by.length
    : null;
  return `${data.approved ? "Approved" : "Not approved"} (provider-reported)${count === null ? "" : `; ${count} approver(s)`}`;
}

export async function readPullRequestStatus(
  context: GitActionContext,
  params: Record<string, unknown>,
): Promise<PullRequestStatus> {
  const result: PullRequestStatus = {
    state: "error",
    root: context.root,
    branch: "",
    remotes: [],
    refreshedAt: new Date().toISOString(),
  };
  const deadline = Date.now() + 55_000;
  async function run(argv: string[]) {
    const command = `cd ${context.shQuote(context.root)} && GH_PROMPT_DISABLED=1 GIT_TERMINAL_PROMPT=0 NO_COLOR=1 ${argv.map(context.shQuote).join(" ")}`;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Request timed out");
    return context.runProcessWithCodeTimeout(
      context.host
        ? sshCommandArgv(context.host, command)
        : ["sh", "-lc", command],
      Math.min(15_000, remaining),
    );
  }
  async function json(argv: string[]) {
    const output = await run(argv);
    if (output.code !== 0) throw new Error("Provider request failed");
    return JSON.parse(output.stdout);
  }
  function finish(state: PullRequestStatus["state"], message?: string) {
    return { ...result, state, message, refreshedAt: new Date().toISOString() };
  }
  try {
    const branch = await run([
      "git",
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    if (branch.code === 1)
      return finish("detached", "Detached HEAD has no branch to resolve.");
    if (branch.code !== 0) throw new Error("Cannot read branch");
    result.branch = branch.stdout.trim();
    if (params.branch && params.branch !== result.branch)
      return finish(
        "error",
        "The branch changed. Refresh workspace status and try again.",
      );
    const remotes = await run(["git", "remote", "-v"]);
    if (remotes.code !== 0) throw new Error("Cannot read remotes");
    for (const line of remotes.stdout.split(/\r?\n/)) {
      const match = line.match(/^(\S+)\s+(.+)\s+\(fetch\)$/);
      if (!match) continue;
      const remote = parseReviewRemote(match[1], match[2]);
      if (remote) result.remotes.push(remote);
    }
    if (!result.remotes.length)
      return finish("unsupported", "No supported network remote found.");
    const selected =
      typeof params.remote === "string"
        ? result.remotes.find((r) => r.name === params.remote)
        : result.remotes.length === 1
          ? result.remotes[0]
          : undefined;
    if (!selected)
      return finish(
        "select_remote",
        "Select the source repository remote to resolve this branch.",
      );
    result.remote = selected.name;
    let provider: ReviewProvider | undefined =
      selected.host === "github.com"
        ? "github"
        : selected.host === "gitlab.com"
          ? "gitlab"
          : undefined;
    if (!provider) {
      // Ask CLIs only about their configured hosts; never probe an arbitrary
      // remote with a token intended for another host.
      const [gh, glab] = await Promise.allSettled([
        run([
          "gh",
          "auth",
          "status",
          "--json",
          "hosts",
          "--jq",
          ".hosts | keys[]",
        ]),
        run(["glab", "auth", "status", "--all"]),
      ]);
      const github =
        gh.status === "fulfilled" &&
        gh.value.stdout.split(/\r?\n/).includes(selected.host);
      const gitlab =
        glab.status === "fulfilled" &&
        `${glab.value.stdout}\n${glab.value.stderr}`
          .split(/\r?\n/)
          .some((line) => line.trim() === selected.host);
      if (github && gitlab)
        return finish(
          "unsupported",
          "This host is configured in both gh and glab; provider is ambiguous.",
        );
      provider = github ? "github" : gitlab ? "gitlab" : undefined;
      if (!provider && (gh.status === "rejected" || glab.status === "rejected"))
        throw new Error("Host discovery failed");
      if (!provider)
        return finish(
          "unsupported",
          "Unsupported or unconfigured host. Configure this instance in gh or glab on the checkout host.",
        );
    }
    result.provider = provider;
    const cli = provider === "github" ? "gh" : "glab";
    const version = await run([cli, "--version"]);
    if (version.code === 127)
      return finish("missing_cli", `Install ${cli} on the checkout host.`);
    if (version.code !== 0) throw new Error("Cannot run CLI");
    const auth = await run([
      cli,
      "auth",
      "status",
      "--hostname",
      selected.host,
      ...(provider === "github" ? ["--active"] : []),
    ]);
    if (auth.code !== 0)
      return finish(
        "unauthenticated",
        `${cli} authentication is unavailable or could not be verified for ${selected.host}. Check it on the checkout host.`,
      );
    const api = (path: string) =>
      json([cli, "api", "--hostname", selected.host, "--method", "GET", path]);
    const matches: PullRequest[] = [];
    if (provider === "github") {
      const repo = object(await api(`repos/${selected.repository}`));
      // GitHub redirects renamed/transferred repositories; compare canonical
      // identity rather than the old name still present in the Git remote.
      const sourceRepository = text(repo.full_name, selected.repository);
      const repositories = [sourceRepository];
      if (repo.fork && repo.parent?.full_name)
        repositories.push(text(repo.parent.full_name));
      for (const repository of new Set(repositories)) {
        const query = new URLSearchParams({
          state: "all",
          head: `${sourceRepository.split("/")[0]}:${result.branch}`,
          per_page: "100",
        });
        const pulls = list(await api(`repos/${repository}/pulls?${query}`));
        for (const raw of pulls) {
          const pr = object(raw);
          if (
            pr.head?.ref !== result.branch ||
            pr.head?.repo?.full_name?.toLowerCase() !==
              sourceRepository.toLowerCase()
          )
            continue;
          const id = number(pr.number);
          matches.push({
            id: `${repository}#${id}`,
            number: id,
            title: text(pr.title),
            author: text(pr.user?.login),
            source: text(pr.head?.label),
            target: text(pr.base?.label),
            state: pr.merged_at ? "merged" : text(pr.state),
            draft: pr.draft === true,
            url: webUrl(selected.host, pr.html_url),
          });
        }
      }
    } else {
      const repo = object(
        await api(`projects/${encodeURIComponent(selected.repository)}`),
      );
      const sourceId = number(repo.id);
      const projects = [sourceId];
      if (repo.forked_from_project?.id)
        projects.push(number(repo.forked_from_project.id));
      for (const project of new Set(projects)) {
        const query = new URLSearchParams({
          scope: "all",
          state: "all",
          source_branch: result.branch,
          per_page: "100",
        });
        for (const raw of list(
          await api(`projects/${project}/merge_requests?${query}`),
        )) {
          const mr = object(raw);
          if (
            mr.source_project_id !== sourceId ||
            mr.source_branch !== result.branch
          )
            continue;
          const id = number(mr.iid);
          matches.push({
            id: `${number(mr.target_project_id)}#${id}`,
            number: id,
            title: text(mr.title),
            author: text(mr.author?.username),
            source: text(mr.source_branch),
            target: text(mr.target_branch),
            state: text(mr.state),
            draft: mr.draft === true || mr.work_in_progress === true,
            url: webUrl(selected.host, mr.web_url),
          });
        }
      }
    }
    const uniqueMatches = [
      ...new Map(matches.map((match) => [match.id, match])).values(),
    ];
    result.matches = uniqueMatches;
    if (!uniqueMatches.length)
      return finish(
        "no_match",
        "No pull or merge request found for this source repository and branch.",
      );
    const request =
      typeof params.match === "string"
        ? uniqueMatches.find((m) => m.id === params.match)
        : uniqueMatches.length === 1
          ? uniqueMatches[0]
          : undefined;
    if (!request)
      return finish(
        "select_match",
        "Multiple requests match this branch. Select one explicitly.",
      );
    result.request = request;
    const [repository, id] = request.id.split("#");
    if (provider === "github") {
      const readField = (field: string) =>
        json([
          "gh",
          "pr",
          "view",
          id,
          "--repo",
          `${selected.host}/${repository}`,
          "--json",
          field,
        ]);
      const [ci, review] = await Promise.allSettled([
        readField("statusCheckRollup").then((data) =>
          githubChecks(object(data).statusCheckRollup),
        ),
        readField("reviewDecision").then((data) =>
          text(object(data).reviewDecision, "No review decision reported"),
        ),
      ]);
      result.ci =
        ci.status === "fulfilled"
          ? ci.value
          : "Unavailable (checks request failed)";
      result.review =
        review.status === "fulfilled"
          ? review.value
          : "Unavailable (review request failed)";
    } else {
      const path = `projects/${repository}/merge_requests/${id}`;
      const [ci, review] = await Promise.allSettled([
        api(path).then((data) => {
          const pipeline = object(data).head_pipeline;
          return pipeline === null
            ? "No pipeline reported"
            : text(pipeline?.status, "Unavailable");
        }),
        api(`${path}/approvals`).then(gitlabApprovals),
      ]);
      result.ci =
        ci.status === "fulfilled"
          ? ci.value
          : "Unavailable (pipeline request failed)";
      result.review =
        review.status === "fulfilled"
          ? review.value
          : "Unavailable (approvals request failed)";
    }
    const currentBranch = await run([
      "git",
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    if (
      currentBranch.code !== 0 ||
      currentBranch.stdout.trim() !== result.branch
    ) {
      delete result.request;
      delete result.matches;
      return finish(
        "error",
        "The branch changed during refresh. Refresh again.",
      );
    }
    return finish("ready");
  } catch {
    delete result.request;
    return finish(
      "error",
      "Could not read PR/MR status. Check repository access, CLI version and network connectivity on the checkout host, then refresh.",
    );
  }
}

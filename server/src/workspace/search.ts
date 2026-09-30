import { sshCommandArgv } from "../bridge/ssh-command";

export type FileSearchResult = {
  path: string;
  line?: number;
  snippet?: string;
};

const RESULT_LIMIT = 100;
const SEARCH_TIMEOUT_MS = 15000;

export async function searchWorkspaceFiles({
  root,
  host,
  query,
  mode,
  shQuote,
}: {
  root: string;
  host?: string;
  query: string;
  mode: "files" | "content";
  shQuote: (value: string) => string;
}) {
  const args =
    mode === "files"
      ? ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]
      : [
          "grep",
          "-n",
          "-z",
          "-I",
          "--no-index",
          "--exclude-standard",
          "-i",
          "-F",
          "-e",
          query,
          "--",
          ".",
        ];
  const argv = host
    ? sshCommandArgv(
        host,
        `git -C ${shQuote(root)} ${args.map(shQuote).join(" ")}`,
      )
    : ["git", "-C", root, ...args];
  const proc = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const results: FileSearchResult[] = [];
  const decoder = new TextDecoder();
  const needle = query.toLowerCase();
  let pending = "";
  let path = "";
  let line = "";
  let snippet = "";
  let field: "path" | "line" | "snippet" = "path";
  let truncated = false;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, SEARCH_TIMEOUT_MS);
  try {
    const reader = proc.stdout.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      while (pending) {
        const delimiter = field === "snippet" ? "\n" : "\0";
        const end = pending.indexOf(delimiter);
        if (end < 0) {
          if (field === "snippet") {
            snippet += pending.slice(0, Math.max(0, 240 - snippet.length));
            pending = "";
          } else if (pending.length > 4096) {
            throw new Error("search result path is too long");
          }
          break;
        }
        const value = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (field === "path") {
          path = value.replace(/^\.\//, "");
          if (mode === "content") {
            field = "line";
            continue;
          }
          if (path.toLowerCase().includes(needle)) {
            results.push({ path });
          }
        } else if (field === "line") {
          line = value;
          field = "snippet";
          continue;
        } else {
          snippet += value.slice(0, Math.max(0, 240 - snippet.length));
          results.push({ path, line: Number(line), snippet: snippet.trim() });
          snippet = "";
        }
        field = "path";
        if (results.length > RESULT_LIMIT) {
          truncated = true;
          proc.kill();
          break;
        }
      }
      if (truncated) break;
    }
    const [code, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    if (timedOut) throw new Error("File search timed out");
    if (!truncated && code !== 0 && !(mode === "content" && code === 1)) {
      throw new Error(stderr.trim().slice(0, 1000) || "File search failed");
    }
    return { results: results.slice(0, RESULT_LIMIT), truncated };
  } finally {
    clearTimeout(timer);
    if (!truncated) proc.kill();
  }
}

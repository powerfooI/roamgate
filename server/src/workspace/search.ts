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
  showHidden,
  shQuote,
}: {
  root: string;
  host?: string;
  query: string;
  mode: "files" | "content";
  showHidden: boolean;
  shQuote: (value: string) => string;
}) {
  const commands =
    mode === "files"
      ? [["ls-files", "--cached", "--others", "--exclude-standard", "-z"]]
      : [
          ["grep", "-n", "-z", "-I", "-i", "-F", "-e", query, "--", "."],
          [
            "grep",
            "-n",
            "-z",
            "-I",
            "--untracked",
            "--exclude-standard",
            "-i",
            "-F",
            "-e",
            query,
            "--",
            ".",
          ],
        ];
  const results: FileSearchResult[] = [];
  const seen = new Set<string>();
  const needle = query.toLowerCase();
  let truncated = false;
  const deadline = Date.now() + SEARCH_TIMEOUT_MS;
  for (const args of commands) {
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
    const decoder = new TextDecoder();
    let pending = "";
    let path = "";
    let pathVisible = true;
    let line = "";
    let snippet = "";
    let field: "path" | "line" | "snippet" = "path";
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        proc.kill();
      },
      Math.max(0, deadline - Date.now()),
    );
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
            pathVisible =
              showHidden ||
              !path.split("/").some((part) => part.startsWith("."));
            if (mode === "content") {
              field = "line";
              continue;
            }
            if (
              path.toLowerCase().includes(needle) &&
              pathVisible &&
              !seen.has(path)
            ) {
              seen.add(path);
              results.push({ path });
            }
          } else if (field === "line") {
            line = value;
            field = "snippet";
            continue;
          } else {
            snippet += value.slice(0, Math.max(0, 240 - snippet.length));
            const key = `${path}\0${line}`;
            if (pathVisible && !seen.has(key)) {
              seen.add(key);
              results.push({
                path,
                line: Number(line),
                snippet: snippet.trim(),
              });
            }
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
    } finally {
      clearTimeout(timer);
      if (!truncated) proc.kill();
    }
    if (truncated) break;
  }
  return { results: results.slice(0, RESULT_LIMIT), truncated };
}

import { statSync } from "node:fs";
import { win32 } from "node:path";
import { sshCommandArgv } from "../bridge/ssh-command";

type ShellOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  which?: (command: string) => string | null;
  isFile?: (path: string) => boolean;
};

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function windowsGitShell(options: ShellOptions): string {
  const env = options.env ?? process.env;
  const which = options.which ?? Bun.which;
  const exists = options.isFile ?? isFile;
  const envValue = (name: string) =>
    Object.entries(env).find(
      ([key]) => key.toLowerCase() === name.toLowerCase(),
    )?.[1];
  const roots = new Set<string>();
  const addRoot = (root: string | undefined) => {
    if (root && win32.isAbsolute(root)) roots.add(win32.normalize(root));
  };

  // The default Git for Windows installer puts only cmd/git.exe on PATH.
  // Also handle portable installs and direct mingw*/ucrt*/clang*/bin paths.
  const git = which("git");
  if (git && win32.isAbsolute(git)) {
    const directory = win32.dirname(git);
    const name = win32.basename(directory).toLowerCase();
    if (name === "cmd" || name === "bin") {
      addRoot(win32.dirname(directory));
      if (name === "bin") addRoot(win32.dirname(win32.dirname(directory)));
    }
  }

  // A GUI/service launch may have no Git (or even no PATH) in its environment.
  const drive = envValue("SystemDrive");
  const systemDrive = drive && /^[a-z]:$/i.test(drive) ? drive : "C:";
  for (const directory of [
    envValue("ProgramW6432"),
    envValue("ProgramFiles"),
    envValue("ProgramFiles(x86)"),
    `${systemDrive}\\Program Files`,
    `${systemDrive}\\Program Files (x86)`,
  ]) {
    if (directory) addRoot(win32.join(directory, "Git"));
  }
  const localAppData = envValue("LOCALAPPDATA");
  if (localAppData) addRoot(win32.join(localAppData, "Programs", "Git"));

  for (const root of roots) {
    // Prefer the supported console wrapper, not git-bash.exe (a GUI launcher).
    for (const relative of ["bin\\bash.exe", "usr\\bin\\bash.exe"]) {
      const shell = win32.join(root, relative);
      if (exists(shell)) return shell;
    }
  }

  // Preserve existing POSIX-shell-on-PATH setups, but do not use a generic
  // bash.exe: Windows' WSL launcher cannot operate on native paths as-is.
  const sh = which("sh");
  if (sh) return sh;
  throw new Error(
    "Local Git operations require Git Bash. Install Git for Windows, or add its cmd or bin directory to PATH, then restart Roamgate.",
  );
}

/** Run the existing POSIX scripts locally without depending on sh.exe on PATH. */
export function gitShellCommandArgv(
  command: string,
  host?: string,
  options: ShellOptions = {},
): string[] {
  // SSH scripts execute on the remote host; never resolve a local Git shell.
  if (host) return sshCommandArgv(host, command);
  const shell =
    (options.platform ?? process.platform) === "win32"
      ? windowsGitShell(options)
      : "sh";
  // Login startup initializes Git for Windows' Git/coreutils PATH. Keep the
  // executable and script as separate argv entries, including paths with spaces.
  return [shell, "-lc", command];
}

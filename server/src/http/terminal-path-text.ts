// Formats uploaded paths using host conventions, not detected shell syntax.
// POSIX hosts use POSIX quoting; Windows covers PowerShell and common Git Bash
// paths, with the PowerShell-only fallback below. Safe paths stay bare for
// agent image detection. Commas need quotes in PowerShell argument mode.
const SAFE_PATH = /^[A-Za-z0-9_\-./:@%+=]+$/;

export function terminalPathText(path: string, platform: NodeJS.Platform) {
  if (platform === "win32") {
    // Bash treats backslashes as escapes; Windows APIs, PowerShell, and Git
    // Bash all accept forward slashes.
    const slashed = path.replaceAll("\\", "/");
    if (SAFE_PATH.test(slashed)) return slashed;
    if (!slashed.includes("'")) return `'${slashed}'`;
    // Windows paths cannot contain double quotes. Double quotes still expand
    // `$` in both shells and backticks in PowerShell.
    if (!/[$`]/.test(slashed)) return `"${slashed}"`;
    // ponytail: this rare combination is PowerShell-only; broader support
    // requires shell-aware formatting rather than guessing from the host OS.
    return `'${slashed.replaceAll("'", "''")}'`;
  }
  if (SAFE_PATH.test(path)) return path;
  return `'${path.replaceAll("'", "'\\''")}'`;
}

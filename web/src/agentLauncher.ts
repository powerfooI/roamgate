import { roamgateLocalStorage } from "./browserStorage";

export function defaultAgentLaunchCommand(agent: string, command: string) {
  // Codex hooks need the pane's environment, not a shared daemon's startup environment.
  return agent === "codex" && command === "codex"
    ? "codex --no-daemon"
    : command;
}

function commandStorageKey(connectionId: string, agent: string) {
  return `agentLaunchCommand.v1:${JSON.stringify([connectionId, agent])}`;
}

export function readAgentLaunchCommand(
  connectionId: string,
  agent: string,
  fallback: string,
) {
  return (
    roamgateLocalStorage.getItem(commandStorageKey(connectionId, agent)) ??
    fallback
  );
}

export function validateAgentLaunchCommand(command: string) {
  if (!command.trim() || /[\x00-\x1f\x7f]/.test(command))
    throw new Error("Enter a single-line launch command.");
}

export function saveAgentLaunchCommand(
  connectionId: string,
  agent: string,
  command: string,
  fallback: string,
) {
  validateAgentLaunchCommand(command);
  const key = commandStorageKey(connectionId, agent);
  if (command === fallback) roamgateLocalStorage.removeItem(key);
  else roamgateLocalStorage.setItem(key, command);
}

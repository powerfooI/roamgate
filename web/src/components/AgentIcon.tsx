import { Bot } from "lucide-react";
import ampIcon from "@lobehub/icons-static-svg/icons/amp-color.svg?raw";
import antigravityIcon from "@lobehub/icons-static-svg/icons/antigravity-color.svg?raw";
import claudeCodeIcon from "@lobehub/icons-static-svg/icons/claudecode-color.svg?raw";
import clineIcon from "@lobehub/icons-static-svg/icons/cline.svg?raw";
import codexIcon from "@lobehub/icons-static-svg/icons/codex-color.svg?raw";
import cursorIcon from "@lobehub/icons-static-svg/icons/cursor.svg?raw";
import devinIcon from "@lobehub/icons-static-svg/icons/devin-color.svg?raw";
import geminiCliIcon from "@lobehub/icons-static-svg/icons/geminicli-color.svg?raw";
import githubCopilotIcon from "@lobehub/icons-static-svg/icons/githubcopilot.svg?raw";
import grokIcon from "@lobehub/icons-static-svg/icons/grok.svg?raw";
import kiloCodeIcon from "@lobehub/icons-static-svg/icons/kilocode.svg?raw";
import kimiIcon from "@lobehub/icons-static-svg/icons/kimi-color.svg?raw";
import kiroIcon from "@lobehub/icons-static-svg/icons/kiro-color.svg?raw";
import opencodeIcon from "@lobehub/icons-static-svg/icons/opencode.svg?raw";
import qoderIcon from "@lobehub/icons-static-svg/icons/qoder-color.svg?raw";
import piIcon from "../assets/pi-logo.svg?raw";
import { cn } from "../utils";
import "./AgentIcon.css";

type AgentKind =
  | "pi"
  | "claude"
  | "codex"
  | "gemini"
  | "cursor"
  | "devin"
  | "agy"
  | "cline"
  | "omp"
  | "opencode"
  | "copilot"
  | "kimi"
  | "kiro"
  | "droid"
  | "amp"
  | "grok"
  | "hermes"
  | "kilo"
  | "qodercli"
  | "unknown";

const AGENT_ICON_SVGS: Partial<Record<AgentKind, string>> = {
  pi: piIcon,
  claude: claudeCodeIcon,
  codex: codexIcon,
  gemini: geminiCliIcon,
  cursor: cursorIcon,
  devin: devinIcon,
  agy: antigravityIcon,
  cline: clineIcon,
  opencode: opencodeIcon,
  copilot: githubCopilotIcon,
  kimi: kimiIcon,
  kiro: kiroIcon,
  amp: ampIcon,
  grok: grokIcon,
  kilo: kiloCodeIcon,
  qodercli: qoderIcon,
};

function agentKind(agent?: string): AgentKind {
  const name = (agent ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, "")
    .replace(/[_\s]+/g, "-");

  if (!name) return "unknown";
  if (name === "pi" || name === "pi-agent" || name === "pi-coding-agent") {
    return "pi";
  }
  if (name === "claude" || name === "claude-code") return "claude";
  if (name === "codex") return "codex";
  if (name === "gemini") return "gemini";
  if (name === "cursor" || name === "cursor-agent") return "cursor";
  if (name === "devin" || name === "devin-cli") return "devin";
  if (name === "agy" || name === "antigravity" || name === "antigravity-cli") {
    return "agy";
  }
  if (name === "cline") return "cline";
  if (name === "omp") return "omp";
  if (name === "opencode" || name === "open-code") return "opencode";
  if (name === "copilot" || name === "github-copilot" || name === "ghcs") {
    return "copilot";
  }
  if (name === "kimi" || name === "kimi-code") return "kimi";
  if (name === "kiro" || name === "kiro-cli") return "kiro";
  if (name === "droid") return "droid";
  if (name === "amp" || name === "amp-local") return "amp";
  if (name === "grok" || name === "grok-build") return "grok";
  if (name === "hermes" || name === "hermes-agent") return "hermes";
  if (name === "kilo" || name === "kilo-code") return "kilo";
  if (
    name === "qodercli" ||
    name === "qoderclicn" ||
    name === "qoder" ||
    name === "qodercn"
  ) {
    return "qodercli";
  }
  return "unknown";
}

export function AgentIcon({
  agent,
  compact = false,
}: {
  agent?: string;
  compact?: boolean;
}) {
  const kind = agentKind(agent);
  const iconSvg = AGENT_ICON_SVGS[kind];

  return (
    <span
      className={cn("agent-icon", compact && "is-compact")}
      data-agent={kind}
      title={agent || "Agent"}
      aria-hidden="true"
    >
      {iconSvg ? (
        <span
          className="agent-icon-svg"
          dangerouslySetInnerHTML={{ __html: iconSvg }}
        />
      ) : (
        <Bot size={compact ? 14 : 15} strokeWidth={2.2} />
      )}
    </span>
  );
}

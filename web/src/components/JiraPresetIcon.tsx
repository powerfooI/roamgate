import { Bug, Code, FileText, Search, Sparkles, Wrench } from "lucide-react";
import type { JiraPresetIcon as IconName } from "../../../shared/jira";

const ICONS = {
  code: Code,
  search: Search,
  bug: Bug,
  wrench: Wrench,
  sparkles: Sparkles,
  file: FileText,
} as const;

export function JiraPresetIcon({
  icon,
  size = 15,
}: {
  icon: IconName;
  size?: number;
}) {
  const Icon = ICONS[icon] ?? Sparkles;
  return <Icon className="jira-preset-icon" size={size} aria-hidden="true" />;
}

import {
  HISTORY_CATEGORIES,
  type HistoryCategory,
  type HistoryFilters,
} from "./agentHistory";
import "./AgentHistoryFilters.css";

const labels: Record<HistoryCategory, string> = {
  user: "User",
  agent: "Agent",
  tool: "Tool",
};

export function AgentHistoryFilters({
  filters,
  counts,
  onToggle,
}: {
  filters: HistoryFilters;
  counts: Record<HistoryCategory, number>;
  onToggle: (category: HistoryCategory) => void;
}) {
  return (
    <div
      className="agent-history-filters"
      role="group"
      aria-label="Filter history by message type"
    >
      {HISTORY_CATEGORIES.map((category) => (
        <button
          key={category}
          type="button"
          className={`agent-history-filter is-${category}`}
          aria-label={labels[category]}
          aria-pressed={filters[category]}
          title={`${filters[category] ? "Hide" : "Show"} ${labels[category]} entries`}
          onClick={() => onToggle(category)}
        >
          {labels[category]}
          <span>{counts[category]}</span>
        </button>
      ))}
    </div>
  );
}

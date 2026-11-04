import { SquareCheck } from "lucide-react";
import {
  activeTaskBadge,
  issuePanelsVisible,
  jiraPanelAvailable,
  toggleJiraPanel,
  toggleTasksPanel,
  useIssueTrackers,
} from "../issueTrackers";
import "./IssueTrackerTopbar.css";

/** Jira and Tasks toggles in the desktop top bar (AC28, AC43, AC44). */
export function IssueTrackerTopbar() {
  const { jira, tasks, jiraPanelOpen, tasksPanelOpen } = useIssueTrackers();
  if (!issuePanelsVisible(jira)) return null;
  const badge = activeTaskBadge(tasks);
  return (
    <>
      {jiraPanelAvailable(jira) ? (
        <button
          type="button"
          className={`topbar-button issue-tracker-entry ${jiraPanelOpen ? "is-active" : ""}`}
          aria-pressed={jiraPanelOpen}
          title={jiraPanelOpen ? "Close Jira issues" : "Open Jira issues"}
          onClick={toggleJiraPanel}
        >
          <span className="topbar-jira-mark" aria-hidden="true">
            J
          </span>
          <span>Jira</span>
        </button>
      ) : null}
      <button
        type="button"
        className={`topbar-button issue-tracker-entry ${tasksPanelOpen ? "is-active" : ""}`}
        aria-pressed={tasksPanelOpen}
        title={tasksPanelOpen ? "Hide Tasks" : "Show Tasks"}
        aria-label={badge > 0 ? `Tasks, ${badge} active` : "Tasks"}
        onClick={toggleTasksPanel}
      >
        <SquareCheck size={15} aria-hidden="true" />
        <span>Tasks</span>
        {badge > 0 ? (
          <span className="topbar-task-badge" aria-hidden="true">
            {badge}
          </span>
        ) : null}
      </button>
    </>
  );
}

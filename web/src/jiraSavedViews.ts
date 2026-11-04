import {
  JIRA_SAVED_VIEWS_UI_KEY,
  type JiraFilters,
  type JiraSavedView,
} from "../../shared/jira";
import { bridge } from "./api";

// Saved views follow the user across browsers through the bridge's UI
// settings (AC36); the server stores them without interpreting them.
const MAX_VIEWS = 30;

export function parseSavedViews(value: unknown): JiraSavedView[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is JiraSavedView =>
        !!entry &&
        typeof entry === "object" &&
        typeof (entry as JiraSavedView).id === "string" &&
        typeof (entry as JiraSavedView).name === "string" &&
        (typeof (entry as JiraSavedView).jql === "string" ||
          ((entry as JiraSavedView).filters !== undefined &&
            typeof (entry as JiraSavedView).filters === "object")),
    )
    .slice(0, MAX_VIEWS);
}

export function addSavedView(
  views: readonly JiraSavedView[],
  name: string,
  query: { filters: JiraFilters } | { jql: string },
  id = `view-${Date.now().toString(36)}`,
): JiraSavedView[] {
  const trimmed = name.trim().slice(0, 60);
  if (!trimmed) throw new Error("Name the view.");
  const view: JiraSavedView = { id, name: trimmed, ...query };
  // A view with the same name is replaced rather than duplicated.
  return [view, ...views.filter((entry) => entry.name !== trimmed)].slice(
    0,
    MAX_VIEWS,
  );
}

export function removeSavedView(
  views: readonly JiraSavedView[],
  id: string,
): JiraSavedView[] {
  return views.filter((view) => view.id !== id);
}

export async function loadSavedViews(): Promise<JiraSavedView[]> {
  const result = (await bridge.call("bridge.ui_settings.get")) as {
    ui?: Record<string, unknown>;
  };
  return parseSavedViews(result?.ui?.[JIRA_SAVED_VIEWS_UI_KEY]);
}

export async function storeSavedViews(views: JiraSavedView[]) {
  await bridge.call("bridge.ui_settings.update", {
    key: JIRA_SAVED_VIEWS_UI_KEY,
    value: views.length ? views : undefined,
  });
}

export const ASSISTANT_MAX_WORKSPACES = 64;

export type AssistantWorkspaceRef = {
  connection_id: string;
  workspace_id: string;
};

export type AssistantWorkspace = AssistantWorkspaceRef & {
  connection_label: string;
  label: string;
  runtime_generation: number;
};

export type AssistantConfig = {
  provider: string;
  model: string;
  credential_source: "assistant" | "pi";
  allowed_workspaces: AssistantWorkspaceRef[];
};

export type AssistantSource = AssistantWorkspaceRef & {
  id: string;
  title: string;
  kind: "status" | "history" | "diff" | "terminal";
  runtime_generation: number;
  pane_id?: string;
  read_at: string;
};

export type AssistantToolActivity = {
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
};

export type AssistantActionKind =
  | "create_workspace"
  | "create_worktree"
  | "create_tab"
  | "split_pane"
  | "start_agent"
  | "send_prompt";

export type AssistantAction = Omit<AssistantWorkspace, "label"> & {
  workspace_label: string;
  id: string;
  kind: AssistantActionKind;
  status:
    | "pending"
    | "executing"
    | "succeeded"
    | "failed"
    | "uncertain"
    | "cancelled";
  created_at: string;
  params: Record<string, string>;
  summary: string;
  detail: string;
};

export type AssistantMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  sent_at: string;
  tools: AssistantToolActivity[];
  sources: AssistantSource[];
  actions?: AssistantAction[];
  task_proposals?: AssistantTaskProposal[];
};

export type AssistantTaskSchedule =
  | { type: "once"; at: string }
  | { type: "interval"; minutes: number }
  | { type: "daily"; time: string; timezone: string };

export type AssistantTaskInput = {
  title: string;
  prompt: string;
  scope: AssistantWorkspaceRef[];
  schedule: AssistantTaskSchedule;
  notification_mode?: "status" | "agent";
};

export type AssistantNotificationInput = {
  event_key: string;
  kind: "completed" | "attention";
  title: string;
  body: string;
};

export type AssistantNotificationReceipt = AssistantNotificationInput & {
  run_id: string;
  created_at: string;
  scope_key: string;
};

export type AssistantTaskRun = {
  id: string;
  task_id: string;
  status: "queued" | "running" | "waiting" | "succeeded" | "failed" | "stopped";
  scheduled_at: string;
  started_at?: string;
  finished_at?: string;
  error: string | null;
};

export type AssistantTaskNotification = {
  task_id: string;
  run_id: string;
  status: "succeeded" | "failed" | "waiting";
  title: string;
  body: string;
};

export function isAssistantTaskNotification(
  value: unknown,
): value is AssistantTaskNotification {
  const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
  return (
    record(value) &&
    text(value.task_id) &&
    uuid.test(value.task_id) &&
    text(value.run_id) &&
    uuid.test(value.run_id) &&
    (value.status === "succeeded" ||
      value.status === "failed" ||
      value.status === "waiting") &&
    text(value.title) &&
    !!value.title.trim() &&
    value.title.length <= 200 &&
    text(value.body) &&
    value.body.length <= 400
  );
}

export type AssistantTask = AssistantTaskInput & {
  id: string;
  status: "active" | "paused" | "cancelled";
  created_at: string;
  updated_at: string;
  next_run_at: string | null;
  workspaces: AssistantWorkspace[];
  model: { provider: string; id: string };
  current_run?: AssistantTaskRun;
  last_run?: AssistantTaskRun;
};

export type AssistantTaskRunDetail = AssistantTaskRun & {
  messages: AssistantMessage[];
};

export type AssistantTaskDetail = {
  task: AssistantTask;
  runs: AssistantTaskRun[];
  run?: AssistantTaskRunDetail;
};

export type AssistantTaskProposal = AssistantTaskInput & {
  id: string;
  status: "pending" | "confirmed" | "cancelled";
  created_at: string;
  task_id?: string;
};

export type AssistantAuthState = {
  id: string;
  provider: string;
  status: "waiting" | "working" | "completed" | "failed";
  message: string;
  url?: string;
  user_code?: string;
  prompt?: {
    id: string;
    type: "text" | "secret" | "select" | "manual_code";
    message: string;
    options?: { id: string; label: string }[];
  };
};

export type AssistantSessionSummary = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
};

export type AssistantSnapshot = {
  instance_id: string;
  revision: number;
  session_id?: string;
  sessions?: AssistantSessionSummary[];
  config: AssistantConfig;
  providers: {
    id: string;
    label: string;
    methods: ("api_key" | "oauth")[];
    configured: boolean;
    credential_method?: "api_key" | "oauth";
  }[];
  models: { provider: string; id: string; label: string }[];
  messages: AssistantMessage[];
  running: boolean;
  error: string | null;
  auth: AssistantAuthState | null;
  tasks?: AssistantTask[];
};

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string";
}

function workspaceRef(value: unknown): value is AssistantWorkspaceRef {
  return (
    record(value) &&
    text(value.connection_id) &&
    value.connection_id.length > 0 &&
    text(value.workspace_id) &&
    value.workspace_id.length > 0
  );
}

function generation(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function timestamp(value: unknown): value is string {
  return text(value) && Number.isFinite(Date.parse(value));
}

export function isAssistantTaskInput(
  value: unknown,
): value is AssistantTaskInput {
  if (
    !record(value) ||
    !text(value.title) ||
    !value.title.trim() ||
    value.title.length > 100 ||
    !text(value.prompt) ||
    !value.prompt.trim() ||
    value.prompt.length > 32_000 ||
    (value.notification_mode !== undefined &&
      value.notification_mode !== "status" &&
      value.notification_mode !== "agent") ||
    !Array.isArray(value.scope) ||
    !value.scope.length ||
    value.scope.length > ASSISTANT_MAX_WORKSPACES ||
    !value.scope.every(workspaceRef) ||
    new Set(
      value.scope.map((ref) =>
        JSON.stringify([ref.connection_id, ref.workspace_id]),
      ),
    ).size !== value.scope.length ||
    !record(value.schedule)
  )
    return false;
  const schedule = value.schedule;
  if (schedule.type === "once") return timestamp(schedule.at);
  if (schedule.type === "interval")
    return (
      typeof schedule.minutes === "number" &&
      Number.isSafeInteger(schedule.minutes) &&
      schedule.minutes >= 1 &&
      schedule.minutes <= 525600
    );
  if (
    schedule.type !== "daily" ||
    !text(schedule.time) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time) ||
    !text(schedule.timezone) ||
    schedule.timezone.length > 100
  )
    return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: schedule.timezone });
    return true;
  } catch {
    return false;
  }
}

function taskRun(value: unknown): value is AssistantTaskRun {
  return (
    record(value) &&
    text(value.id) &&
    !!value.id &&
    text(value.task_id) &&
    !!value.task_id &&
    ["queued", "running", "waiting", "succeeded", "failed", "stopped"].includes(
      String(value.status),
    ) &&
    timestamp(value.scheduled_at) &&
    (value.started_at === undefined || timestamp(value.started_at)) &&
    (value.finished_at === undefined || timestamp(value.finished_at)) &&
    (value.error === null || text(value.error))
  );
}

function task(value: unknown): value is AssistantTask {
  if (!isAssistantTaskInput(value)) return false;
  const data: Record<string, unknown> = value;
  return (
    text(data.id) &&
    !!data.id &&
    ["active", "paused", "cancelled"].includes(String(data.status)) &&
    timestamp(data.created_at) &&
    timestamp(data.updated_at) &&
    (data.next_run_at === null || timestamp(data.next_run_at)) &&
    record(data.model) &&
    text(data.model.provider) &&
    text(data.model.id) &&
    Array.isArray(data.workspaces) &&
    data.workspaces.length === value.scope.length &&
    data.workspaces.every(
      (workspace) =>
        record(workspace) &&
        text(workspace.label) &&
        text(workspace.connection_label) &&
        generation(workspace.runtime_generation) &&
        workspaceRef(workspace),
    ) &&
    (data.current_run === undefined ||
      (taskRun(data.current_run) && data.current_run.task_id === data.id)) &&
    (data.last_run === undefined ||
      (taskRun(data.last_run) && data.last_run.task_id === data.id))
  );
}

function taskProposal(value: unknown): value is AssistantTaskProposal {
  if (!isAssistantTaskInput(value)) return false;
  const data: Record<string, unknown> = value;
  return (
    text(data.id) &&
    !!data.id &&
    ["pending", "confirmed", "cancelled"].includes(String(data.status)) &&
    timestamp(data.created_at) &&
    (data.task_id === undefined || text(data.task_id))
  );
}

export function isAssistantTaskDetail(
  value: unknown,
): value is AssistantTaskDetail {
  if (
    !record(value) ||
    !task(value.task) ||
    !Array.isArray(value.runs) ||
    value.runs.length > 20
  )
    return false;
  const taskId = value.task.id;
  const runs = value.runs;
  if (!runs.every((run) => taskRun(run) && run.task_id === taskId))
    return false;
  const run = value.run;
  return (
    run === undefined ||
    (record(run) &&
      Array.isArray(run.messages) &&
      run.messages.length <= 80 &&
      run.messages.every(isAssistantMessage) &&
      taskRun(run) &&
      run.task_id === taskId &&
      runs.some((entry) => entry.id === run.id))
  );
}

function action(value: unknown): value is AssistantAction {
  return (
    record(value) &&
    workspaceRef({
      connection_id: value.connection_id,
      workspace_id: value.workspace_id,
    }) &&
    text(value.id) &&
    !!value.id &&
    [
      "create_workspace",
      "create_worktree",
      "create_tab",
      "split_pane",
      "start_agent",
      "send_prompt",
    ].includes(String(value.kind)) &&
    [
      "pending",
      "executing",
      "succeeded",
      "failed",
      "uncertain",
      "cancelled",
    ].includes(String(value.status)) &&
    generation(value.runtime_generation) &&
    text(value.connection_label) &&
    text(value.workspace_label) &&
    text(value.created_at) &&
    text(value.summary) &&
    text(value.detail) &&
    record(value.params) &&
    Object.keys(value.params).length <= 8 &&
    Object.values(value.params).every(
      (entry) => text(entry) && entry.length <= 20_000,
    )
  );
}

export function isAssistantMessage(value: unknown): value is AssistantMessage {
  return (
    record(value) &&
    text(value.id) &&
    (value.role === "user" || value.role === "assistant") &&
    text(value.text) &&
    text(value.sent_at) &&
    (value.actions === undefined ||
      (Array.isArray(value.actions) &&
        value.actions.length <= 8 &&
        value.actions.every(action))) &&
    Array.isArray(value.tools) &&
    value.tools.every(
      (tool) =>
        record(tool) &&
        text(tool.id) &&
        text(tool.name) &&
        ["running", "completed", "failed"].includes(String(tool.status)),
    ) &&
    Array.isArray(value.sources) &&
    value.sources.every(
      (source) =>
        record(source) &&
        text(source.connection_id) &&
        source.connection_id.length > 0 &&
        text(source.workspace_id) &&
        source.workspace_id.length > 0 &&
        text(source.id) &&
        text(source.title) &&
        ["status", "history", "diff", "terminal"].includes(
          String(source.kind),
        ) &&
        generation(source.runtime_generation) &&
        (source.pane_id === undefined || text(source.pane_id)) &&
        text(source.read_at),
    ) &&
    (value.task_proposals === undefined ||
      (Array.isArray(value.task_proposals) &&
        value.task_proposals.length <= 8 &&
        value.task_proposals.every(taskProposal)))
  );
}

export function isAssistantSnapshot(
  value: unknown,
): value is AssistantSnapshot {
  if (!record(value) || !record(value.config)) return false;
  const config = value.config;
  if (
    !text(value.instance_id) ||
    !value.instance_id ||
    !generation(value.revision) ||
    (value.session_id === undefined) !== (value.sessions === undefined) ||
    (value.session_id !== undefined &&
      (!text(value.session_id) ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(
          value.session_id,
        ))) ||
    (value.sessions !== undefined &&
      (!Array.isArray(value.sessions) ||
        !value.sessions.every(
          (session) =>
            record(session) &&
            text(session.id) &&
            /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(session.id) &&
            text(session.title) &&
            session.title.length > 0 &&
            session.title.length <= 80 &&
            text(session.created_at) &&
            Number.isFinite(Date.parse(session.created_at)) &&
            text(session.updated_at) &&
            Number.isFinite(Date.parse(session.updated_at)) &&
            generation(session.message_count) &&
            session.message_count <= 80,
        ) ||
        new Set(value.sessions.map((session) => session.id)).size !==
          value.sessions.length ||
        (value.session_id !== undefined &&
          !value.sessions.some(
            (session) => session.id === value.session_id,
          )))) ||
    typeof value.running !== "boolean" ||
    (value.error !== null && !text(value.error)) ||
    !text(config.provider) ||
    !text(config.model) ||
    !["assistant", "pi"].includes(String(config.credential_source)) ||
    !Array.isArray(config.allowed_workspaces) ||
    !config.allowed_workspaces.every(workspaceRef) ||
    !Array.isArray(value.providers) ||
    !value.providers.every(
      (provider) =>
        record(provider) &&
        text(provider.id) &&
        text(provider.label) &&
        typeof provider.configured === "boolean" &&
        (provider.credential_method === undefined ||
          provider.credential_method === "api_key" ||
          provider.credential_method === "oauth") &&
        Array.isArray(provider.methods) &&
        provider.methods.every(
          (method) => method === "api_key" || method === "oauth",
        ),
    ) ||
    !Array.isArray(value.models) ||
    !value.models.every(
      (model) =>
        record(model) &&
        text(model.provider) &&
        text(model.id) &&
        text(model.label),
    ) ||
    (value.tasks !== undefined &&
      (!Array.isArray(value.tasks) ||
        value.tasks.length > 50 ||
        !value.tasks.every(task) ||
        new Set(value.tasks.map((task) => task.id)).size !==
          value.tasks.length)) ||
    !Array.isArray(value.messages) ||
    !value.messages.every(isAssistantMessage)
  )
    return false;
  if (value.auth === null) return true;
  const auth = value.auth;
  if (
    !record(auth) ||
    !text(auth.id) ||
    !text(auth.provider) ||
    !["waiting", "working", "completed", "failed"].includes(
      String(auth.status),
    ) ||
    !text(auth.message) ||
    (auth.url !== undefined && !text(auth.url)) ||
    (auth.user_code !== undefined && !text(auth.user_code))
  )
    return false;
  if (auth.prompt === undefined) return true;
  const prompt = auth.prompt;
  return (
    record(prompt) &&
    text(prompt.id) &&
    text(prompt.message) &&
    ["text", "secret", "select", "manual_code"].includes(String(prompt.type)) &&
    (prompt.options === undefined ||
      (Array.isArray(prompt.options) &&
        prompt.options.every(
          (option) => record(option) && text(option.id) && text(option.label),
        )))
  );
}

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  AssistantAction,
  AssistantActionKind,
  AssistantConfig,
  AssistantMessage,
  AssistantSessionSummary,
  AssistantSnapshot,
  AssistantWorkspaceRef,
} from "../../../shared/assistant";
import {
  ASSISTANT_MAX_WORKSPACES,
  isAssistantSnapshot,
} from "../../../shared/assistant";
import { assertSafeDataPath, dataRoot } from "../config/data-paths";
import { roamgateEnv } from "../config/environment";
import type { AssistantContext } from "./context";
import { type AssistantDriver, createPiDriver } from "./pi-driver";

const DEFAULT_CONFIG: AssistantConfig = {
  provider: "",
  model: "",
  credential_source: "assistant",
  allowed_workspaces: [],
};
const MAX_TEXT = 32_000;
const MAX_MESSAGES = 80;
const MAX_CONTEXT_BYTES = 1_000_000;
const MAX_STATE_BYTES = 3_000_000;
const jsonBytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");
const refKey = (ref: AssistantWorkspaceRef) =>
  `${ref.connection_id}\0${ref.workspace_id}`;
const SESSION_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

function sessionSummary(
  id: string = randomUUID(),
  messages: AssistantMessage[] = [],
): AssistantSessionSummary {
  const first = messages.find((message) => message.role === "user");
  const now = new Date().toISOString();
  return {
    id,
    title:
      first?.text.trim().split(/\r?\n/, 1)[0]?.trim().slice(0, 72) ||
      "New chat",
    created_at:
      first && Number.isFinite(Date.parse(first.sent_at)) ? first.sent_at : now,
    updated_at: now,
    message_count: messages.length,
  };
}

function string(value: unknown, name: string, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`Invalid ${name}`);
  return value;
}

function refs(value: unknown): AssistantWorkspaceRef[] {
  if (!Array.isArray(value) || value.length > ASSISTANT_MAX_WORKSPACES)
    throw new Error("Invalid workspace scope");
  const result = value.map((entry) => {
    if (!entry || typeof entry !== "object")
      throw new Error("Invalid workspace scope");
    return {
      connection_id: string(entry.connection_id, "connection identifier"),
      workspace_id: string(entry.workspace_id, "workspace identifier"),
    };
  });
  if (new Set(result.map(refKey)).size !== result.length)
    throw new Error("Duplicate workspace scope");
  return result;
}

function config(value: Record<string, unknown>): AssistantConfig {
  if (
    value.credential_source !== "assistant" &&
    value.credential_source !== "pi"
  )
    throw new Error("Invalid credential source");
  return {
    provider: value.provider === "" ? "" : string(value.provider, "provider"),
    model: value.model === "" ? "" : string(value.model, "model"),
    credential_source: value.credential_source,
    allowed_workspaces: refs(value.allowed_workspaces),
  };
}

function authUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.username || url.password) return undefined;
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function createAssistantService(options: {
  context: AssistantContext;
  publish(snapshot: AssistantSnapshot): void;
  directory?: string;
  driver?: AssistantDriver;
}) {
  const directory =
    options.directory ??
    roamgateEnv("ASSISTANT_DIR") ??
    join(dataRoot(), "assistant");
  const statePath = join(directory, "state.json");
  const sessionsDirectory = join(directory, "sessions");
  const driver = options.driver ?? createPiDriver(directory);
  let entries: unknown[] = [];
  let entryScope = "";
  let requests: string[] = [];
  let pendingRequest: string | undefined;
  let invalidSavedState = false;
  let migrateSavedState = false;
  let disposed = false;
  let changing = false;
  let run: Promise<void> | undefined;
  let actionWork: Promise<void> | undefined;
  const preparedActions = new Map<
    string,
    {
      execute(): Promise<{
        status: "succeeded" | "failed" | "uncertain";
        detail: string;
      }>;
    }
  >();
  let turnController: AbortController | undefined;
  let authController: AbortController | undefined;
  let authWork: Promise<void> | undefined;
  let answer:
    | { id: string; resolve(value: string): void; reject(error: Error): void }
    | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const initialSession = sessionSummary();
  const state: AssistantSnapshot = {
    instance_id: randomUUID(),
    revision: 0,
    session_id: initialSession.id,
    sessions: [initialSession],
    config: structuredClone(DEFAULT_CONFIG),
    providers: [],
    models: [],
    messages: [],
    running: false,
    error: null,
    auth: null,
  };
  try {
    assertSafeDataPath(statePath);
    if (existsSync(statePath)) {
      if (statSync(statePath).size > MAX_STATE_BYTES)
        throw new Error("Saved session is too large");
      const saved = JSON.parse(readFileSync(statePath, "utf8"));
      const restoredConfig = config(saved.config);
      const restored = savedSession(saved);
      const migrated =
        saved.session_id === undefined && saved.sessions === undefined;
      const restoredId = migrated ? randomUUID() : saved.session_id;
      const restoredSessions = migrated
        ? [sessionSummary(restoredId, restored.messages)]
        : saved.sessions;
      if (
        !isAssistantSnapshot({
          ...state,
          config: restoredConfig,
          session_id: restoredId,
          sessions: restoredSessions,
          messages: restored.messages,
        })
      )
        throw new Error("Invalid saved session");
      state.config = restoredConfig;
      state.session_id = restoredId;
      state.sessions = restoredSessions;
      state.messages = restored.messages;
      retirePreviews(
        state.messages,
        "The bridge restarted. Ask Ranger for a fresh preview.",
      );
      entries = restored.entries;
      entryScope = restored.entry_scope;
      requests = restored.requests;
      migrateSavedState = migrated;
    }
  } catch {
    invalidSavedState = true;
    state.error = "The saved Ranger session could not be loaded.";
  }
  if (migrateSavedState) {
    try {
      persist();
    } catch {
      state.error = "The Ranger session migration could not be saved.";
    }
  }

  function savedSession(saved: Record<string, unknown>) {
    if (
      !Array.isArray(saved.messages) ||
      !Array.isArray(saved.entries) ||
      !Array.isArray(saved.requests) ||
      !isAssistantSnapshot({ ...state, messages: saved.messages }) ||
      !saved.requests.every(
        (id: unknown) => typeof id === "string" && id.length <= 500,
      )
    )
      throw new Error("Invalid saved session");
    return {
      messages: saved.messages as AssistantMessage[],
      entries:
        jsonBytes(saved.entries) <= MAX_CONTEXT_BYTES ? saved.entries : [],
      entry_scope:
        typeof saved.entry_scope === "string" ? saved.entry_scope : "",
      requests: (saved.requests as string[]).slice(-1000),
    };
  }
  function retirePreviews(messages: AssistantMessage[], detail: string) {
    for (const message of messages) {
      for (const action of message.actions ?? []) {
        if (action.status === "pending") {
          action.status = "cancelled";
          action.detail = detail;
        } else if (action.status === "executing") {
          action.status = "uncertain";
          action.detail =
            "The bridge restarted during execution. Check the target before proposing another operation; this action will not be replayed.";
        }
      }
    }
  }
  function boundMessages() {
    state.messages = state.messages.slice(-MAX_MESSAGES);
    while (
      state.messages.length > (state.running ? 2 : 0) &&
      jsonBytes(state.messages) > MAX_CONTEXT_BYTES
    )
      state.messages.splice(0, 2);
  }
  function updateSummary() {
    const existing = state.sessions!.find(
      (session) => session.id === state.session_id,
    )!;
    const last = state.messages.at(-1)?.sent_at;
    const next = {
      ...existing,
      title:
        existing.message_count === 0 && state.messages.length
          ? sessionSummary(existing.id, state.messages).title
          : existing.title,
      updated_at:
        last && Date.parse(last) > Date.parse(existing.updated_at)
          ? last
          : existing.updated_at,
      message_count: state.messages.length,
    };
    state.sessions = state
      .sessions!.map((session) => (session.id === next.id ? next : session))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }
  function current(): AssistantSnapshot {
    boundMessages();
    updateSummary();
    return structuredClone(state);
  }
  function publish(immediate = false) {
    state.revision++;
    if (disposed) return;
    if (immediate) {
      if (timer) clearTimeout(timer);
      timer = undefined;
      options.publish(current());
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = undefined;
        if (!disposed) options.publish(current());
      }, 80);
    }
  }
  function writeSaved(path: string, saved: unknown) {
    const contents = `${JSON.stringify(saved)}\n`;
    if (Buffer.byteLength(contents, "utf8") > MAX_STATE_BYTES)
      throw new Error("Saved session is too large");
    assertSafeDataPath(path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(dirname(path), 0o700);
    const temporary = join(dirname(path), `.state-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
      assertSafeDataPath(path);
      if (path === statePath && invalidSavedState && existsSync(statePath)) {
        renameSync(
          statePath,
          join(directory, `.invalid-state-${randomUUID()}.json`),
        );
        invalidSavedState = false;
      }
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  function persist() {
    boundMessages();
    updateSummary();
    requests = requests.slice(-1000);
    if (jsonBytes(entries) > MAX_CONTEXT_BYTES) entries = [];
    writeSaved(statePath, {
      config: state.config,
      session_id: state.session_id,
      sessions: state.sessions,
      messages: state.messages,
      entries,
      entry_scope: entryScope,
      requests,
    });
  }
  function saveChange(change: () => void) {
    const previous = {
      config: state.config,
      messages: structuredClone(state.messages),
      session_id: state.session_id,
      sessions: state.sessions,
      providers: state.providers,
      models: state.models,
      error: state.error,
      auth: state.auth,
    };
    const previousEntries = entries;
    const previousScope = entryScope;
    const previousRequests = requests;
    const previousPrepared = new Map(preparedActions);
    try {
      change();
      persist();
    } catch {
      Object.assign(state, previous);
      entries = previousEntries;
      entryScope = previousScope;
      requests = previousRequests;
      preparedActions.clear();
      for (const [id, prepared] of previousPrepared)
        preparedActions.set(id, prepared);
      throw new Error("The Ranger changes could not be saved.");
    }
  }
  async function catalog() {
    const source = state.config.credential_source;
    const result = await driver.catalog(source);
    if (state.config.credential_source === source) Object.assign(state, result);
  }
  function idle() {
    if (disposed) throw new Error("Ranger unavailable");
    if (state.running || changing || authController || actionWork)
      throw new Error("Ranger is busy");
  }
  function cancelPendingActions(detail: string) {
    for (const message of state.messages) {
      for (const action of message.actions ?? []) {
        if (action.status === "pending") {
          action.status = "cancelled";
          action.detail = detail;
        }
      }
    }
    preparedActions.clear();
  }
  function sessionPath(id: string) {
    return join(sessionsDirectory, `${id}.json`);
  }
  function archiveCurrent() {
    boundMessages();
    updateSummary();
    if (!state.messages.length) {
      state.sessions = state.sessions!.filter(
        (session) => session.id !== state.session_id,
      );
      return;
    }
    const archived = structuredClone(state.messages);
    retirePreviews(
      archived,
      "This chat was left. Ask Ranger for a fresh preview.",
    );
    // Publish the full transcript before the active pointer changes. An orphaned
    // backup on a later save failure is preferable to losing the old conversation.
    writeSaved(sessionPath(state.session_id!), {
      session_id: state.session_id,
      messages: archived,
      entries: jsonBytes(entries) <= MAX_CONTEXT_BYTES ? entries : [],
      entry_scope: entryScope,
      requests: requests.slice(-1000),
    });
  }
  function selectSession(params: Record<string, unknown>) {
    idle();
    const id = string(params.session_id, "session identifier");
    if (
      Object.keys(params).some((key) => key !== "session_id") ||
      !SESSION_ID.test(id)
    )
      throw new Error("Selection accepts only a saved session identifier.");
    if (!state.sessions!.some((session) => session.id === id))
      throw new Error("This Ranger chat is no longer available.");
    if (state.session_id === id) return;
    let selected: ReturnType<typeof savedSession>;
    try {
      const path = sessionPath(id);
      assertSafeDataPath(path);
      if (statSync(path).size > MAX_STATE_BYTES) throw new Error("Too large");
      const saved = JSON.parse(readFileSync(path, "utf8"));
      if (saved.session_id !== id) throw new Error("Invalid saved session");
      selected = savedSession(saved);
      retirePreviews(
        selected.messages,
        "This saved preview has expired. Ask Ranger for a fresh preview.",
      );
    } catch {
      throw new Error("The saved Ranger chat could not be loaded.");
    }
    saveChange(() => {
      archiveCurrent();
      state.session_id = id;
      state.messages = selected.messages;
      entries = selected.entries;
      entryScope = selected.entry_scope;
      requests = selected.requests;
      preparedActions.clear();
      state.error = null;
    });
    publish(true);
  }

  async function confirmAction(params: Record<string, unknown>) {
    const id = string(params.action_id, "action identifier");
    if (Object.keys(params).some((key) => key !== "action_id"))
      throw new Error("Confirmation accepts only the action identifier.");
    const action = state.messages
      .flatMap((message) => message.actions ?? [])
      .find((entry) => entry.id === id);
    if (!action) throw new Error("This action is no longer available.");
    // The persisted action ID is the receipt; concurrent browsers never replay it.
    if (action.status !== "pending") return;
    idle();
    const prepared = preparedActions.get(id);
    if (
      !prepared ||
      !state.config.allowed_workspaces.some(
        (ref) => refKey(ref) === refKey(action),
      )
    ) {
      action.status = "cancelled";
      action.detail =
        "The approved target is no longer available. Ask Ranger for a fresh preview.";
      persist();
      publish(true);
      return;
    }
    // Durably reserve the operation before any effect. A crash leaves an
    // uncertain receipt, never an operation that is automatically retried.
    action.status = "executing";
    action.detail =
      "Executing the confirmed operation and checking its result...";
    entries = [];
    try {
      persist();
    } catch {
      action.status = "pending";
      action.detail =
        "The confirmation could not be saved. Nothing was executed.";
      publish(true);
      throw new Error(
        "The confirmation could not be saved. Nothing was executed.",
      );
    }
    preparedActions.delete(id);
    publish(true);
    actionWork = (async () => {
      try {
        const result = await prepared.execute();
        action.status = result.status;
        action.detail = result.detail.slice(0, MAX_TEXT);
      } catch {
        action.status = "uncertain";
        action.detail =
          "The operation could not be verified. Check the target before proposing another operation; it will not be retried automatically.";
      } finally {
        try {
          persist();
        } catch {
          state.error =
            "The operation result could not be saved. The action will not be replayed.";
        }
        actionWork = undefined;
        publish(true);
      }
    })();
  }
  function message(
    role: AssistantMessage["role"],
    text: string,
  ): AssistantMessage {
    return {
      id: randomUUID(),
      role,
      text,
      sent_at: new Date().toISOString(),
      tools: [],
      sources: [],
    };
  }

  async function send(params: Record<string, unknown>) {
    if (
      params.session_id !== undefined &&
      params.session_id !== state.session_id
    )
      throw new Error(
        "The active Ranger chat changed. Select it again before sending.",
      );
    const requestId = string(params.request_id, "request identifier");
    if (requests.includes(requestId) || pendingRequest === requestId) return;
    idle();
    const text = string(params.text, "message", 20_000);
    const scope =
      params.scope === undefined
        ? structuredClone(state.config.allowed_workspaces)
        : refs(params.scope);
    const allowed = new Set(state.config.allowed_workspaces.map(refKey));
    if (!scope.length || scope.some((ref) => !allowed.has(refKey(ref))))
      throw new Error("Choose an authorized workspace scope");
    if (!state.config.provider || !state.config.model)
      throw new Error("Connect a provider and select a model first");
    // Reserve admission before any await so two browser connections cannot start a turn.
    state.running = true;
    pendingRequest = requestId;
    state.error = null;
    const controller = new AbortController();
    turnController = controller;
    const turnConfig = structuredClone(state.config);
    try {
      await catalog();
      if (
        !state.providers.some(
          (provider) =>
            provider.id === turnConfig.provider && provider.configured,
        ) ||
        !state.models.some(
          (model) =>
            model.provider === turnConfig.provider &&
            model.id === turnConfig.model,
        )
      )
        throw new Error("The selected model is not configured");
      const captured = await options.context.captureScope(
        scope,
        controller.signal,
      );
      if (disposed) throw new Error("Ranger unavailable");
      const capturedKey = JSON.stringify(captured);
      if (entryScope !== capturedKey) entries = [];
      entryScope = capturedKey;
      const draft = message("assistant", "");
      cancelPendingActions(
        "A new question replaced this preview. Ask Ranger to propose it again if needed.",
      );
      state.messages.push(message("user", text), draft);
      requests.push(requestId);
      pendingRequest = undefined;
      publish(true);
      let finalizedText = "";
      let streamedText = "";
      const updateText = () => {
        draft.text = [finalizedText, streamedText]
          .filter(Boolean)
          .join("\n\n")
          .slice(0, MAX_TEXT);
        publish();
      };
      run = (async () => {
        try {
          if (controller.signal.aborted) return;
          entries = await driver.run({
            config: turnConfig,
            entries,
            signal: controller.signal,
            text: `Authorized workspace scope for this turn (only these IDs may be read or used as action targets):\n${JSON.stringify(captured)}\n\nRecorded operation outcomes (server receipts, not proof of task completion):\n${JSON.stringify(
              state.messages
                .flatMap((item) => item.actions ?? [])
                .filter((action) =>
                  captured.some(
                    (ref) =>
                      refKey(ref) === refKey(action) &&
                      ref.runtime_generation === action.runtime_generation,
                  ),
                )
                .slice(-8),
            )}\n\nUser message:\n${text}`,
            propose: async (kind: AssistantActionKind, args, signal) => {
              const combined = signal
                ? AbortSignal.any([signal, controller.signal])
                : controller.signal;
              combined.throwIfAborted();
              if (!options.context.prepareAction)
                throw new Error("Action previews are unavailable.");
              if ((draft.actions?.length ?? 0) >= 8)
                throw new Error("This turn already has eight action previews.");
              const prepared = await options.context.prepareAction(
                kind,
                captured,
                args,
                combined,
              );
              combined.throwIfAborted();
              if ((draft.actions?.length ?? 0) >= 8)
                throw new Error("This turn already has eight action previews.");
              const action: AssistantAction = {
                ...structuredClone(prepared.preview),
                id: randomUUID(),
                kind,
                status: "pending",
                created_at: new Date().toISOString(),
                detail:
                  "Waiting for your confirmation. Nothing has been executed.",
              };
              draft.actions ??= [];
              draft.actions.push(action);
              try {
                persist();
              } catch {
                draft.actions = draft.actions.filter(
                  (entry) => entry.id !== action.id,
                );
                throw new Error("The action preview could not be saved.");
              }
              preparedActions.set(action.id, prepared);
              publish(true);
              return { text: JSON.stringify(action) };
            },
            read: async (kind, args, signal) => {
              const combined = signal
                ? AbortSignal.any([signal, controller.signal])
                : controller.signal;
              combined.throwIfAborted();
              const result = await options.context.read(
                kind,
                captured,
                args,
                combined,
              );
              combined.throwIfAborted();
              for (const source of result.sources) {
                if (
                  draft.sources.length < 64 &&
                  !draft.sources.some((entry) => entry.id === source.id)
                )
                  draft.sources.push(source);
              }
              publish();
              return result;
            },
            delta: (value) => {
              streamedText = (streamedText + value).slice(0, MAX_TEXT);
              updateText();
            },
            message: (value) => {
              if (value)
                finalizedText = [finalizedText, value]
                  .filter(Boolean)
                  .join("\n\n")
                  .slice(0, MAX_TEXT);
              streamedText = "";
              updateText();
            },
            tool: (id, name, status) => {
              const tool = draft.tools.find((entry) => entry.id === id);
              if (tool) tool.status = status;
              else if (draft.tools.length < 64)
                draft.tools.push({ id, name, status });
              publish();
            },
            error: () => {
              state.error =
                "The model request failed. Check the provider connection and try again.";
            },
          });
        } catch {
          if (!controller.signal.aborted)
            state.error =
              "The Ranger request failed. Check the provider connection and try again.";
        } finally {
          for (const tool of draft.tools)
            if (tool.status === "running") tool.status = "failed";
          if (controller.signal.aborted)
            cancelPendingActions(
              "The question was stopped. Ask Ranger for a fresh preview.",
            );
          state.running = false;
          turnController = undefined;
          try {
            persist();
          } catch {
            state.error = "The Ranger session could not be saved.";
          }
          publish(true);
        }
      })();
    } catch {
      state.running = false;
      turnController = undefined;
      requests = requests.filter((id) => id !== requestId);
      pendingRequest = undefined;
      publish(true);
      // Provider errors can contain credentials; expose only our fixed message.
      throw new Error(
        controller.signal.aborted
          ? "The Ranger request was stopped."
          : "The workspace scope or provider connection is unavailable",
      );
    }
  }

  async function startAuth(params: Record<string, unknown>) {
    idle();
    const credentialSource = state.config.credential_source;
    const provider = string(params.provider, "provider");
    const method = params.method;
    if (method !== "api_key" && method !== "oauth")
      throw new Error("Invalid login method");
    changing = true;
    try {
      await catalog();
    } catch {
      throw new Error("The provider catalog could not be loaded.");
    } finally {
      changing = false;
    }
    if (disposed) throw new Error("Ranger unavailable");
    if (
      !state.providers
        .find((entry) => entry.id === provider)
        ?.methods.includes(method)
    )
      throw new Error("This provider does not support that login method");
    const id = randomUUID();
    const controller = new AbortController();
    authController = controller;
    state.auth = {
      id,
      provider,
      status: "working",
      message: "Connecting provider...",
    };
    publish(true);
    authWork = (async () => {
      try {
        await driver.login(provider, method, {
          credential_source: credentialSource,
          signal: controller.signal,
          prompt: async (prompt) => {
            controller.signal.throwIfAborted();
            const promptId = randomUUID();
            state.auth = {
              ...state.auth!,
              status: "waiting",
              message: "Complete the provider login step.",
              prompt: {
                id: promptId,
                type: prompt.type,
                message: prompt.message.slice(0, 1000),
                options: prompt.options?.map((option) => ({
                  id: option.id,
                  label: option.label,
                })),
              },
            };
            publish(true);
            const signal = prompt.signal
              ? AbortSignal.any([prompt.signal, controller.signal])
              : controller.signal;
            return new Promise<string>((resolve, reject) => {
              const abort = () => {
                if (answer?.id === promptId) answer = undefined;
                reject(new Error("Login cancelled"));
              };
              const cleanup = () => signal.removeEventListener("abort", abort);
              answer = {
                id: promptId,
                resolve: (value) => {
                  cleanup();
                  resolve(value);
                },
                reject: (error) => {
                  cleanup();
                  reject(error);
                },
              };
              if (signal.aborted) abort();
              else signal.addEventListener("abort", abort, { once: true });
            });
          },
          notify: (event) => {
            if (controller.signal.aborted || state.auth?.id !== id) return;
            state.auth.status = "working";
            state.auth.message = "Waiting for provider authorization...";
            if (event.type === "auth_url") state.auth.url = authUrl(event.url);
            if (event.type === "device_code") {
              state.auth.url = authUrl(event.verificationUri);
              state.auth.user_code = event.userCode;
            }
            publish(true);
          },
        });
        controller.signal.throwIfAborted();
        await catalog();
        controller.signal.throwIfAborted();
        state.auth = {
          id,
          provider,
          status: "completed",
          message: "Provider connected. Select a model to continue.",
        };
      } catch {
        state.auth = {
          id,
          provider,
          status: "failed",
          message: controller.signal.aborted
            ? "Login cancelled."
            : "Provider login failed. Try again.",
        };
      } finally {
        answer = undefined;
        authController = undefined;
        publish(true);
      }
    })();
  }

  return {
    async snapshot(): Promise<AssistantSnapshot> {
      if (disposed) throw new Error("Ranger unavailable");
      try {
        await catalog();
      } catch {
        state.error = "The provider catalog could not be loaded.";
      }
      return current();
    },
    async handle(
      method: string,
      params: Record<string, unknown>,
    ): Promise<AssistantSnapshot> {
      if (disposed) throw new Error("Ranger unavailable");
      method = method.replace(/^bridge\.assistant\./, "");
      switch (method) {
        case "get":
          try {
            await catalog();
          } catch {
            state.error = "The provider catalog could not be loaded.";
          }
          break;
        case "configure": {
          idle();
          const next = config(
            (params.config ?? params) as Record<string, unknown>,
          );
          changing = true;
          try {
            const previous = state.config;
            const existing = new Set(previous.allowed_workspaces.map(refKey));
            const added = next.allowed_workspaces.filter(
              (ref) => !existing.has(refKey(ref)),
            );
            if (added.length) await options.context.captureScope(added);
            const nextCatalog = await driver.catalog(next.credential_source);
            if (disposed) throw new Error("Ranger unavailable");
            if (
              next.provider &&
              !nextCatalog.providers.some(
                (provider) => provider.id === next.provider,
              )
            )
              throw new Error("Invalid provider");
            if (
              next.model &&
              !nextCatalog.models.some(
                (model) =>
                  model.provider === next.provider && model.id === next.model,
              )
            )
              throw new Error("Invalid model");
            saveChange(() => {
              state.config = next;
              cancelPendingActions(
                "The Ranger configuration changed. Ask for a fresh preview.",
              );
              Object.assign(state, nextCatalog);
              if (
                previous.provider !== next.provider ||
                previous.credential_source !== next.credential_source
              )
                state.auth = null;
              // Removed scope must not remain in the model's historical tool context.
              if (
                JSON.stringify(previous.allowed_workspaces) !==
                JSON.stringify(next.allowed_workspaces)
              )
                entries = [];
              state.error = null;
            });
            publish(true);
          } catch {
            throw new Error(
              "The Ranger configuration could not be saved. Check the provider, model and workspace scope.",
            );
          } finally {
            changing = false;
          }
          break;
        }
        case "send":
          await send(params);
          break;
        case "stop":
          turnController?.abort();
          try {
            await driver.stop();
          } catch {
            throw new Error("Ranger could not be stopped.");
          }
          await run;
          break;
        case "new_session":
          idle();
          saveChange(() => {
            archiveCurrent();
            const next = sessionSummary();
            state.session_id = next.id;
            state.sessions!.push(next);
            state.messages = [];
            entries = [];
            entryScope = "";
            requests = [];
            preparedActions.clear();
            state.error = null;
          });
          publish(true);
          break;
        case "select_session":
          selectSession(params);
          break;
        case "action.confirm":
          await confirmAction(params);
          break;
        case "action.cancel": {
          idle();
          const id = string(params.action_id, "action identifier");
          const action = state.messages
            .flatMap((message) => message.actions ?? [])
            .find((entry) => entry.id === id);
          if (!action) throw new Error("This action is no longer available.");
          if (action.status === "pending") {
            action.status = "cancelled";
            action.detail = "Cancelled. Nothing was executed.";
            preparedActions.delete(id);
            entries = [];
            persist();
            publish(true);
          }
          break;
        }
        case "auth.start":
          await startAuth(params);
          break;
        case "auth.respond": {
          if (
            !state.auth ||
            state.auth.id !== params.auth_id ||
            !answer ||
            answer.id !== params.prompt_id
          )
            throw new Error("This login prompt is no longer active");
          const value =
            typeof params.value === "string" && params.value.length <= 20_000
              ? params.value
              : undefined;
          if (value === undefined) throw new Error("Invalid login response");
          const prompt = state.auth.prompt;
          if (
            prompt?.type === "select" &&
            !prompt.options?.some((option) => option.id === value)
          )
            throw new Error("Invalid login choice");
          const pending = answer;
          answer = undefined;
          delete state.auth.prompt;
          state.auth.status = "working";
          state.auth.message = "Connecting provider...";
          pending.resolve(value);
          publish(true);
          break;
        }
        case "auth.cancel":
          if (params.auth_id && params.auth_id !== state.auth?.id)
            throw new Error("This login is no longer active");
          authController?.abort();
          await authWork;
          break;
        default:
          throw new Error("Unknown Ranger method");
      }
      return current();
    },
    async dispose(): Promise<void> {
      disposed = true;
      if (timer) clearTimeout(timer);
      authController?.abort();
      turnController?.abort();
      await driver.dispose();
      await Promise.allSettled(
        [run, authWork, actionWork].filter(
          (entry): entry is Promise<void> => !!entry,
        ),
      );
    },
  };
}

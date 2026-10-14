export interface EndpointCreationSource {
  workspace_id: string;
  tab_id: string;
  pane_id: string;
  terminal_id: string;
}

/** Studio-only creation context; never forward this field to Herdr. */
export function parseEndpointCreationSource(
  value: unknown,
): EndpointCreationSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "Open the source workspace's terminal tab before creating a tab or workspace.",
    );
  }
  const source = value as Record<string, unknown>;
  for (const key of [
    "workspace_id",
    "tab_id",
    "pane_id",
    "terminal_id",
  ] as const) {
    const id = source[key];
    if (
      typeof id !== "string" ||
      !id ||
      id.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(id)
    ) {
      throw new Error(`Invalid browser creation source ${key}`);
    }
  }
  return {
    workspace_id: source.workspace_id as string,
    tab_id: source.tab_id as string,
    pane_id: source.pane_id as string,
    terminal_id: source.terminal_id as string,
  };
}

export function assertEndpointCreationSource(
  source: EndpointCreationSource,
  pane: unknown,
): void {
  if (
    !pane ||
    typeof pane !== "object" ||
    Object.entries(source).some(
      ([key, id]) => (pane as Record<string, unknown>)[key] !== id,
    )
  )
    throw new Error(
      "Source pane moved or closed. Open its current tab and retry creation.",
    );
}

/** Admission-to-dispatch budget stays below the browser's 30-second RPC timeout. */
export class EndpointCreationDeadline {
  private readonly expiresAt: number;
  private dispatched = false;

  constructor(timeoutMs = 20_000) {
    this.expiresAt = Date.now() + timeoutMs;
  }

  private error() {
    return new Error(
      this.dispatched
        ? "Creation timed out after dispatch; check Herdr before retrying. Creation may have succeeded."
        : "Creation expired before dispatch; nothing was created. Retry from the current terminal.",
    );
  }

  assertBeforeDispatch() {
    if (Date.now() >= this.expiresAt) throw this.error();
  }

  dispatch<T>(send: () => Promise<T>): Promise<T> {
    this.assertBeforeDispatch();
    this.dispatched = true;
    return send();
  }

  async wait<T>(
    pending: Promise<T>,
    onDispatchedTimeout?: () => void,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              reject(this.error());
              if (this.dispatched) onDispatchedTimeout?.();
            },
            Math.max(0, this.expiresAt - Date.now()),
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** One bootstrap lane per runtime: a second caller must recheck after the first. */
export function createEmptyWorkspaceCreator(
  call: (
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ) => Promise<unknown>,
) {
  let tail: Promise<unknown> = Promise.resolve();
  return (
    params: Record<string, unknown>,
    isCurrent: () => boolean,
    deadline: EndpointCreationDeadline,
    validatePath: () => Promise<void> = async () => {},
  ) => {
    const check = () => {
      deadline.assertBeforeDispatch();
      if (!isCurrent())
        throw new Error("Creation connection changed. Reconnect and retry.");
    };
    const task = tail.then(async () => {
      check();
      const topology = await call("workspace.list", {}, 5000);
      if (
        !topology ||
        typeof topology !== "object" ||
        !("type" in topology) ||
        topology.type !== "workspace_list" ||
        !("workspaces" in topology) ||
        !Array.isArray(topology.workspaces)
      )
        throw new Error(
          "Cannot verify an empty session. Refresh and retry creation.",
        );
      if (topology.workspaces.length !== 0)
        throw new Error(
          "Session is no longer empty. Open a terminal in the desired workspace and retry creation.",
        );
      await validatePath();
      check();
      const creationParams: Record<string, unknown> = {
        ...params,
        focus: false,
      };
      delete creationParams.browser_source;
      delete creationParams.source_workspace_id;
      return deadline.dispatch(() =>
        call("workspace.create", creationParams, 20_000),
      );
    });
    // Keep the lane until the actual control request settles, even if its caller expires.
    tail = task.catch(() => undefined);
    return task;
  };
}

import { useEffect, useEffectEvent, useState } from "react";
import type { ConnectionClient } from "../api";
import { store } from "../store";
import { useConnectionClient } from "../useConnectionClient";
import { TextInputDialog } from "./ModalDialogs";

type Location = {
  client: ConnectionClient;
  workspaceId: string;
  key: string | null;
  directory: string;
};

/** Edits where new worktrees of the workspace's repository are created. */
export function WorktreeLocationDialog({
  open,
  workspaceId,
  onClose,
}: {
  open: boolean;
  workspaceId: string | null;
  onClose: () => void;
}) {
  const connectionClient = useConnectionClient();
  const [location, setLocation] = useState<Location | null>(null);
  const close = useEffectEvent(onClose);
  const current =
    location?.client === connectionClient &&
    location.workspaceId === workspaceId
      ? location
      : null;

  useEffect(() => {
    if (!open || !workspaceId) {
      setLocation(null);
      return;
    }
    let cancelled = false;
    connectionClient
      .call("settings.worktree_directory.get", { workspace_id: workspaceId })
      .then((result) => {
        if (cancelled || !connectionClient.isCurrent()) return;
        setLocation({
          client: connectionClient,
          workspaceId,
          key: result?.key ?? null,
          directory: result?.worktree_directory ?? "",
        });
      })
      .catch((error) => {
        if (cancelled) return;
        store.notify({
          kind: "error",
          message: "Unable to read the worktree location",
          detail: (error as Error).message,
        });
        close();
      });
    return () => {
      cancelled = true;
    };
  }, [connectionClient, open, workspaceId]);

  return (
    <TextInputDialog
      open={open && !!current}
      title="Worktree Location"
      label="Directory for new worktrees (empty for Herdr's default)"
      initialValue={current?.directory ?? ""}
      placeholder="/path/to/worktrees"
      submitLabel="Save"
      onClose={onClose}
      onSubmit={(value) => {
        if (
          !current ||
          !connectionClient.isCurrent() ||
          store.get().activeConnectionId !== connectionClient.connectionId
        )
          return;
        const key = current.key;
        onClose();
        if (!key) return;
        void store.setRepoWorktreeDirectory(key, value.trim());
      }}
    />
  );
}

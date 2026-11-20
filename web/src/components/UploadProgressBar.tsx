import { useCallback, useRef, useState } from "react";
import type { UploadProgress } from "../uploadInOrder";
import "./UploadProgressBar.css";

/**
 * The files a message box is uploading, over every batch going up at once
 * (two pastes in a row): `start` a batch with its size, count each file it
 * settles, and `end` it.
 */
export function useUploadProgress() {
  const batches = useRef(new Map<number, UploadProgress>());
  const serial = useRef(0);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const publish = useCallback(() => {
    let done = 0;
    let total = 0;
    for (const batch of batches.current.values()) {
      done += batch.done;
      total += batch.total;
    }
    setProgress(total ? { done, total } : null);
  }, []);
  const start = useCallback(
    (total: number) => {
      const id = ++serial.current;
      batches.current.set(id, { done: 0, total });
      publish();
      return {
        settled: (done: number) => {
          const batch = batches.current.get(id);
          if (!batch) return;
          batch.done = done;
          publish();
        },
        end: () => {
          batches.current.delete(id);
          publish();
        },
      };
    },
    [publish],
  );
  return { progress, start };
}

/** "Uploading 3/8" over a thin bar, while a message box's files go up. */
export function UploadProgressBar({
  done,
  total,
  className,
}: {
  done: number;
  total: number;
  className?: string;
}) {
  const label = `Uploading ${done}/${total}`;
  return (
    <div
      className={`upload-progress${className ? ` ${className}` : ""}`}
      role="status"
    >
      <span className="upload-progress-label">{label}</span>
      <div
        className="upload-progress-bar"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
      >
        <span style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
      </div>
    </div>
  );
}

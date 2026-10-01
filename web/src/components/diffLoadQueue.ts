/** One queue per connection also bounds rapid file selections across panels. */
export function createDiffLoadQueue() {
  const pending: Array<{
    key?: string;
    wanted: () => boolean;
    run: () => Promise<{ diff: string }>;
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }> = [];
  let active = 0;
  let concurrency = 2;
  let fastResponses = 0;

  const pump = () => {
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (pending[index].wanted()) continue;
      pending.splice(index, 1)[0].reject(new Error("diff request retired"));
    }
    while (active < concurrency && pending.length) {
      const task = pending.shift()!;
      active += 1;
      const started = performance.now();
      void task
        .run()
        .then((file) => {
          const elapsed = performance.now() - started;
          const bytes = (file.diff?.length ?? 0) * 2;
          if (elapsed > 400 || bytes >= 128 * 1024) {
            concurrency = Math.max(1, Math.floor(concurrency / 2));
            fastResponses = 0;
          } else if (elapsed < 100 && bytes < 64 * 1024) {
            fastResponses += 1;
            if (fastResponses >= concurrency * 2) {
              concurrency = Math.min(8, concurrency + 1);
              fastResponses = 0;
            }
          }
          task.resolve(file);
        }, task.reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };

  return {
    prioritize(key: string) {
      const index = pending.findIndex((task) => task.key === key);
      if (index > 0) pending.unshift(pending.splice(index, 1)[0]);
    },
    request<T extends { diff: string }>(
      run: () => Promise<T>,
      wanted: () => boolean,
      priority = false,
      key?: string,
    ): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const task = { key, run, wanted, resolve, reject };
        if (priority) pending.unshift(task);
        else pending.push(task);
        pump();
      });
    },
  };
}

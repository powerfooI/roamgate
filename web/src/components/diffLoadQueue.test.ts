import { expect, test } from "bun:test";
import { createDiffLoadQueue } from "./diffLoadQueue";

test("bounds requests, prioritizes selections, and drops obsolete queued files", async () => {
  const queue = createDiffLoadQueue();
  const started: string[] = [];
  const release: Array<() => void> = [];
  let wanted = true;
  const request = (name: string, priority = false) =>
    queue.request(
      () => {
        started.push(name);
        return new Promise<{ diff: string }>((resolve) => {
          release.push(() => resolve({ diff: "patch" }));
        });
      },
      () => name !== "obsolete" || wanted,
      priority,
      name,
    );
  const first = request("first");
  const second = request("second");
  const obsolete = request("obsolete").catch((error: Error) => error.message);
  const nearby = request("nearby");
  wanted = false;
  const selected = request("selected");
  queue.prioritize("selected");
  expect(started).toEqual(["first", "second"]);
  expect(await obsolete).toBe("diff request retired");
  release.shift()!();
  await first;
  // Resolving a request pumps the next task after its promise reaction.
  await Promise.resolve();
  expect(started).toEqual(["first", "second", "selected"]);
  release.shift()!();
  await second;
  await Promise.resolve();
  expect(started).toEqual(["first", "second", "selected", "nearby"]);
  for (const resolve of release) resolve();
  await Promise.all([selected, nearby]);

  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 60 }, () =>
      queue.request(
        async () => {
          active += 1;
          peak = Math.max(peak, active);
          await Promise.resolve();
          active -= 1;
          return { diff: "small" };
        },
        () => true,
      ),
    ),
  );
  expect(peak).toBeLessThanOrEqual(8);
});

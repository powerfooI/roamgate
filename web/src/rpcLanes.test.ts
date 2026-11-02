import { describe, expect, test } from "bun:test";
import { backgroundCallKey, createBackgroundLane } from "./rpcLanes";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("background RPC lane", () => {
  test("runs at most its limit at once, the rest in turn", async () => {
    const lane = createBackgroundLane(2);
    const calls = Array.from({ length: 4 }, () => deferred<number>());
    let started = 0;
    const results = calls.map((call, index) =>
      lane.run(`k${index}`, () => {
        started += 1;
        return call.promise;
      }),
    );
    expect(started).toBe(2);
    expect(lane.size).toEqual({ active: 2, waiting: 2 });
    calls[0]!.resolve(0);
    await Bun.sleep(0);
    expect(started).toBe(3);
    // A failure frees its place as well.
    calls[1]!.reject(new Error("shed"));
    await expect(results[1]!).rejects.toThrow("shed");
    expect(started).toBe(4);
    calls[2]!.resolve(2);
    calls[3]!.resolve(3);
    expect(await Promise.all([results[0], results[2], results[3]])).toEqual([
      0, 2, 3,
    ]);
    expect(lane.size).toEqual({ active: 0, waiting: 0 });
  });

  test("shares an identical call in flight, then asks again", async () => {
    const lane = createBackgroundLane(4);
    const first = deferred<string>();
    let asked = 0;
    const call = () => {
      asked += 1;
      return first.promise;
    };
    const key = backgroundCallKey("c1", "git.pull_request", { branch: "x" });
    const a = lane.run(key, call);
    const b = lane.run(key, call);
    expect(asked).toBe(1);
    first.resolve("ready");
    expect(await Promise.all([a, b])).toEqual(["ready", "ready"]);
    await lane.run(key, async () => {
      asked += 1;
      return "again";
    });
    expect(asked).toBe(2);
  });

  test("keys calls by scope, method and parameters", () => {
    const key = (scope: string, method: string, branch: string) =>
      backgroundCallKey(scope, method, { branch });
    expect(key("c1", "m", "a")).toBe(key("c1", "m", "a"));
    expect(key("c1", "m", "a")).not.toBe(key("c2", "m", "a"));
    expect(key("c1", "m", "a")).not.toBe(key("c1", "n", "a"));
    expect(key("c1", "m", "a")).not.toBe(key("c1", "m", "b"));
  });
});

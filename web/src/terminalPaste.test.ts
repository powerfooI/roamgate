import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  test,
} from "bun:test";
import {
  createTerminalPasteRunner,
  prepareTerminalPasteText,
  terminalPasteInputText,
  terminalPasteRequest,
  type TerminalPasteTextareaSnapshot,
} from "./terminalPaste";

function deferred() {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("terminal paste loading", () => {
  let current: boolean;
  const setLoading = mock((loading: boolean) => loading);
  let runner: ReturnType<typeof createTerminalPasteRunner>;

  beforeEach(() => {
    jest.useFakeTimers();
    current = true;
    setLoading.mockClear();
    runner = createTerminalPasteRunner(() => current, setLoading);
  });
  afterEach(() => {
    runner.dispose();
    jest.useRealTimers();
  });

  test("a paste finishing before 200ms never shows the overlay", async () => {
    const operation = deferred();
    const result = runner.run(() => operation.promise);
    jest.advanceTimersByTime(199);
    expect(setLoading).not.toHaveBeenCalled();
    operation.resolve("pasted");
    expect(await result).toBe("pasted");
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(1000);
    expect(setLoading.mock.calls).toEqual([[false]]);
  });

  test("shows at 200ms and hides when a slow paste finishes", async () => {
    const operation = deferred();
    const result = runner.run(() => operation.promise);
    jest.advanceTimersByTime(199);
    expect(setLoading).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(setLoading.mock.calls).toEqual([[true]]);
    operation.resolve("pasted");
    await result;
    expect(setLoading.mock.calls).toEqual([[true], [false]]);
  });

  test("overlapping pastes share the delay and wait for the last completion", async () => {
    const first = deferred();
    const second = deferred();
    const a = runner.run(() => first.promise);
    jest.advanceTimersByTime(150);
    const b = runner.run(() => second.promise);
    expect(jest.getTimerCount()).toBe(1);
    first.resolve("first");
    await a;
    expect(setLoading).not.toHaveBeenCalled();
    jest.advanceTimersByTime(50);
    expect(setLoading.mock.calls).toEqual([[true]]);
    second.resolve("second");
    await b;
    expect(setLoading.mock.calls).toEqual([[true], [false]]);
  });

  test("a new busy period gets a fresh delay", async () => {
    await runner.run(() => Promise.resolve("first"));
    setLoading.mockClear();
    const operation = deferred();
    const result = runner.run(() => operation.promise);
    jest.advanceTimersByTime(199);
    expect(setLoading).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(setLoading.mock.calls).toEqual([[true]]);
    operation.resolve("second");
    await result;
  });

  test("a synchronous throw cancels the timer and preserves the error", async () => {
    const error = new Error("clipboard unavailable");
    await expect(
      runner.run(() => {
        throw error;
      }),
    ).rejects.toBe(error);
    jest.advanceTimersByTime(1000);
    expect(setLoading.mock.calls).toEqual([[false]]);
  });

  test("an async rejection hides the overlay and preserves the error", async () => {
    const operation = deferred();
    const result = runner.run(() => operation.promise);
    jest.advanceTimersByTime(200);
    const error = new Error("upload failed");
    operation.reject(error);
    await expect(result).rejects.toBe(error);
    expect(setLoading.mock.calls).toEqual([[true], [false]]);
  });

  test("a stale connection cannot start a paste", async () => {
    current = false;
    const operation = mock(() => Promise.resolve("unused"));
    await expect(runner.run(operation)).rejects.toThrow("paste cancelled");
    expect(operation).not.toHaveBeenCalled();
    jest.advanceTimersByTime(200);
    expect(setLoading).not.toHaveBeenCalled();
  });

  test("a disposed runner cannot start a paste on a current connection", async () => {
    runner.dispose();
    setLoading.mockClear();
    const operation = mock(() => Promise.resolve("unused"));
    await expect(runner.run(operation)).rejects.toThrow("paste cancelled");
    expect(operation).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    expect(setLoading).not.toHaveBeenCalled();
  });

  test("a connection switch before the delay prevents a stale overlay", async () => {
    const operation = deferred();
    const result = runner.run(() => operation.promise);
    current = false;
    jest.advanceTimersByTime(200);
    operation.resolve("stale");
    await expect(result).rejects.toThrow("paste cancelled");
    expect(setLoading).not.toHaveBeenCalled();
  });

  test("teardown cancels a pending timer and prevents late updates", async () => {
    const operation = deferred();
    const result = runner.run(() => operation.promise);
    runner.dispose();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(200);
    operation.resolve("stale");
    await expect(result).rejects.toThrow("paste cancelled");
    expect(setLoading.mock.calls).toEqual([[false]]);
  });

  test("teardown resets a visible overlay even after the connection expires", async () => {
    const operation = deferred();
    const result = runner.run(() => operation.promise);
    jest.advanceTimersByTime(200);
    current = false;
    runner.dispose();
    expect(setLoading.mock.calls).toEqual([[true], [false]]);
    operation.resolve("stale");
    await expect(result).rejects.toThrow("paste cancelled");
    expect(setLoading.mock.calls).toEqual([[true], [false]]);
  });

  test("an old effect's completion cannot hide a new effect's overlay", async () => {
    const oldOperation = deferred();
    const oldResult = runner.run(() => oldOperation.promise);
    jest.advanceTimersByTime(200);
    runner.dispose();
    runner = createTerminalPasteRunner(() => current, setLoading);
    const newOperation = deferred();
    const newResult = runner.run(() => newOperation.promise);
    jest.advanceTimersByTime(200);
    setLoading.mockClear();
    oldOperation.resolve("old");
    await expect(oldResult).rejects.toThrow("paste cancelled");
    expect(setLoading).not.toHaveBeenCalled();
    newOperation.resolve("new");
    await newResult;
    expect(setLoading.mock.calls).toEqual([[false]]);
  });
});

function snapshot(
  value: string,
  selectionStart = value.length,
  selectionEnd = selectionStart,
): TerminalPasteTextareaSnapshot {
  return { value, selectionStart, selectionEnd };
}

describe("terminal paste", () => {
  test("recovers full native paste text from xterm's helper textarea", () => {
    const firstLine = "中英文😀".repeat(300);
    const text = `${firstLine}\nsecond line\nthird line`;
    expect(
      terminalPasteInputText(
        { inputType: "insertFromPaste", isComposing: false },
        snapshot(""),
        text,
      ),
    ).toBe(text);
    expect(terminalPasteRequest("p7", text).params.text).toBe(
      `${firstLine}\rsecond line\rthird line`,
    );
    expect(
      terminalPasteInputText(
        { inputType: "insertFromPaste", isComposing: false },
        snapshot("previous"),
        "previouspasted",
      ),
    ).toBe("pasted");
  });

  test("extracts selection replacement without replaying surviving text", () => {
    const paste = { inputType: "insertFromPaste", isComposing: false };
    expect(terminalPasteInputText(paste, snapshot("abc", 1, 2), "aXc")).toBe(
      "X",
    );
    expect(terminalPasteInputText(paste, snapshot("abc", 0, 3), "XYZ")).toBe(
      "XYZ",
    );
    expect(terminalPasteInputText(paste, snapshot("abc", 1, 2), "abc")).toBe(
      "b",
    );
    expect(
      terminalPasteInputText(paste, snapshot("abc", 1, 1), "axc"),
    ).toBeNull();
  });

  test("ignores composing, unchanged collapsed, and non-paste input", () => {
    expect(
      terminalPasteInputText(
        { inputType: "insertFromPaste", isComposing: true },
        snapshot(""),
        "text",
      ),
    ).toBeNull();
    expect(
      terminalPasteInputText(
        { inputType: "insertFromPaste", isComposing: false },
        snapshot(""),
        "",
      ),
    ).toBeNull();
    expect(
      terminalPasteInputText(
        { inputType: "insertText", isComposing: false },
        snapshot(""),
        "text",
      ),
    ).toBeNull();
  });

  test("normalizes browser line endings like xterm", () => {
    expect(prepareTerminalPasteText("one\ntwo\r\nthree\rfour")).toBe(
      "one\rtwo\rthree\rfour",
    );
  });

  test("routes text through Herdr's mode-aware pane input API", () => {
    expect(terminalPasteRequest("p7", "if true\n  echo ok")).toEqual({
      method: "pane.send_input",
      params: {
        pane_id: "p7",
        text: "if true\r  echo ok",
        keys: [],
      },
    });
  });
});

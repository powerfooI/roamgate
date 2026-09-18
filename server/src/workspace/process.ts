export async function runBinaryProcessWithTimeout(
  argv: string[],
  timeoutMs: number,
) {
  const proc = Bun.spawn(argv, {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const output = Promise.all([
    proc.exited,
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
  ]).then(([code, stdout, stderr]) => {
    if (timer) clearTimeout(timer);
    return { code, stdout: Buffer.from(stdout), stderr };
  });
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
      reject(new Error(`${argv[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([output, timeout]);
}

// A child may exit before it reads stdin: `git check-ignore --stdin` outside a
// repository exits 128 immediately. Writing a payload larger than the pipe
// buffer then breaks the pipe, and Bun reports that EPIPE on the FileSink
// promise rather than by throwing. Nothing awaits that promise, so leaving it
// unhandled terminates the whole server. The child's exit code and stderr still
// describe the failure, so the broken pipe itself is safe to drop here.
function ignoreBrokenStdin(result: number | Promise<number>) {
  if (typeof result !== "number") void result.catch(() => {});
}

export async function runProcessWithInputTimeout(
  argv: string[],
  input: Buffer | string,
  timeoutMs: number,
) {
  const proc = Bun.spawn(argv, {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  ignoreBrokenStdin(proc.stdin.write(input));
  ignoreBrokenStdin(proc.stdin.end());
  let timer: ReturnType<typeof setTimeout> | null = null;
  const output = Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).then(([code, stdout, stderr]) => {
    if (timer) clearTimeout(timer);
    return { code, stdout, stderr };
  });
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
      reject(new Error(`${argv[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([output, timeout]);
}

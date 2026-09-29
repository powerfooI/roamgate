export async function runProcess(
  argv: string[],
  input?: string,
): Promise<{ stdout: string; stderr: string }> {
  const { code, stdout, stderr } = await runProcessWithCode(argv, input);
  if (code !== 0) {
    throw new Error(
      `${argv[0]} exited ${code}: ${stderr.trim() || stdout.trim()}`,
    );
  }
  return { stdout, stderr };
}

export async function runProcessWithCode(
  argv: string[],
  input?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, {
    stdin: input === undefined ? "ignore" : Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

export async function runProcessWithCodeTimeout(
  argv: string[],
  timeoutMs: number,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, {
    ...options,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
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

export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

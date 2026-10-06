/**
 * Resolve the non-executable subset of a launchd shell environment file.
 * Never source user configuration during install: command substitutions and
 * standalone commands could have side effects before validation has finished.
 */
export function resolveLaunchdEnvironment(
  contents: string,
  path: string,
  homeDir: string,
): Record<string, string> {
  const values: Record<string, string> = Object.create(null);
  values.HOME = homeDir;
  let offset = 0;
  const fail = (reason: string): never => {
    const line = contents.slice(0, offset).split("\n").length;
    // Do not include source text or expanded values: either can hold a secret.
    throw new Error(
      `invalid launchd environment at ${path}:${line}: ${reason}`,
    );
  };
  if (contents.includes("\0")) fail("NUL characters are not supported");
  const horizontalSpace = () => {
    while (contents[offset] === " " || contents[offset] === "\t") offset++;
  };
  const expandVariable = (quoted: boolean): string => {
    offset++;
    if (contents.startsWith("\\\n", offset)) {
      fail("line continuations inside variable references are not supported");
    }
    if (!quoted && /['"]/.test(contents[offset] ?? "")) {
      fail("shell-specific quoting is not supported");
    }
    const braced = contents[offset] === "{";
    if (braced) offset++;
    const match = contents.slice(offset).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (!match) {
      if (braced || /[([0-9@*#?$!-]/.test(contents[offset] ?? "")) {
        fail("only $NAME and ${NAME} variable expansion is supported");
      }
      return "$";
    }
    const name = match[0];
    offset += name.length;
    if (!braced && contents.startsWith("\\\n", offset)) {
      fail("line continuations inside variable references are not supported");
    }
    if (braced) {
      if (contents[offset] !== "}") {
        fail("only $NAME and ${NAME} variable expansion is supported");
      }
      offset++;
    }
    if (!Object.hasOwn(values, name)) {
      fail(
        "define referenced variables earlier in the config (HOME is available)",
      );
    }
    return values[name];
  };

  while (offset < contents.length) {
    horizontalSpace();
    if (contents[offset] === "#") {
      while (offset < contents.length && contents[offset] !== "\n") offset++;
    }
    if (contents[offset] === "\n") {
      offset++;
      continue;
    }
    if (offset === contents.length) break;
    if (/^export[ \t]+/.test(contents.slice(offset))) {
      offset += "export".length;
      horizontalSpace();
    }
    const assignment = contents
      .slice(offset)
      .match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!assignment) fail("expected one NAME=value assignment per line");
    const name = assignment![1];
    // These variables have shell-specific behavior, including readonly values
    // and values that change on every expansion. They cannot be resolved here.
    if (
      /^(?:BASH.*|COMP.*|HIST.*|READLINE.*|ENV|IFS|SHELLOPTS|UID|EUID|PPID|SHLVL|RANDOM|SRANDOM|SECONDS|LINENO|OPTIND|OPTARG|GROUPS|DIRSTACK|FUNCNAME|PIPESTATUS|COPROC|MAPFILE|EPOCHREALTIME|EPOCHSECONDS|HOSTNAME|HOSTTYPE|MACHTYPE|OSTYPE|REPLY|_)$/.test(
        name,
      )
    ) {
      fail("shell-special variable assignments are not supported");
    }
    offset += assignment![0].length;
    let value = "";
    let quote: "'" | '"' | undefined;
    while (offset < contents.length) {
      const character = contents[offset];
      if (quote === "'") {
        offset++;
        if (character === "'") quote = undefined;
        else value += character;
        continue;
      }
      if (character === quote) {
        quote = undefined;
        offset++;
        continue;
      }
      if (!quote) {
        if (/[ \t\n]/.test(character)) break;
        if (character === "'" || character === '"') {
          quote = character;
          offset++;
          continue;
        }
        if (/[;&|<>()~]/.test(character)) {
          fail(
            "shell operators and unquoted tilde expansion are not supported",
          );
        }
      }
      if (character === "`") fail("command substitution is not supported");
      if (character === "$") {
        value += expandVariable(quote === '"');
        continue;
      }
      if (character === "\\") {
        const escaped = contents[offset + 1];
        if (escaped === undefined) fail("incomplete escape");
        if (!quote || /[$`"\\\n]/.test(escaped!)) {
          if (escaped !== "\n") value += escaped;
          offset += 2;
          continue;
        }
      }
      value += character;
      offset++;
    }
    if (quote) fail("unterminated quote");
    values[name] = value;
    horizontalSpace();
    if (contents[offset] === "#") {
      while (offset < contents.length && contents[offset] !== "\n") offset++;
    }
    if (offset < contents.length && contents[offset] !== "\n") {
      fail("expected one NAME=value assignment per line");
    }
    if (contents[offset] === "\n") offset++;
  }
  return values;
}

import { dlopen, FFIType, ptr, read } from "bun:ffi";
import { getSystemErrorName } from "node:util";

function moveError(errno: number, source: string, target: string) {
  const code = getSystemErrorName(-errno);
  return Object.assign(
    new Error(`${code}: cannot move ${source} to ${target}`),
    { code, errno, path: source, dest: target },
  );
}

function openExclusiveRename() {
  if (process.platform === "win32") {
    const { symbols } = dlopen("kernel32.dll", {
      MoveFileExW: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
      GetLastError: { args: [], returns: FFIType.u32 },
    });
    return (source: string, target: string) => {
      const from = Buffer.from(`${source}\0`, "utf16le");
      const to = Buffer.from(`${target}\0`, "utf16le");
      // Zero flags prohibit both replacement and cross-filesystem copying.
      if (symbols.MoveFileExW(ptr(from), ptr(to), 0) === 0) {
        throw new Error(
          `Cannot move file: Windows error ${symbols.GetLastError()}`,
        );
      }
    };
  }
  if (process.platform === "darwin") {
    const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", {
      renamex_np: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
      __error: { args: [], returns: FFIType.ptr },
    });
    return (source: string, target: string) => {
      const from = Buffer.from(`${source}\0`);
      const to = Buffer.from(`${target}\0`);
      if (symbols.renamex_np(ptr(from), ptr(to), 4) !== 0) {
        throw moveError(read.i32(symbols.__error()!), source, target);
      }
    };
  }
  if (process.platform === "linux") {
    const definitions = {
      renameat2: {
        args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
      __errno_location: { args: [], returns: FFIType.ptr },
    } as const;
    let library;
    try {
      library = dlopen("libc.so.6", definitions);
    } catch {
      library = dlopen(
        `/lib/ld-musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`,
        definitions,
      );
    }
    const { symbols } = library;
    return (source: string, target: string) => {
      const from = Buffer.from(`${source}\0`);
      const to = Buffer.from(`${target}\0`);
      if (symbols.renameat2(-100, ptr(from), -100, ptr(to), 1) !== 0) {
        throw moveError(read.i32(symbols.__errno_location()!), source, target);
      }
    };
  }
  throw new Error("Atomic file moves are unsupported on this host");
}

let exclusiveRename: ReturnType<typeof openExclusiveRename> | undefined;

export function renameFileExclusive(source: string, target: string) {
  if (source === target)
    throw new Error("Source and destination are identical");
  exclusiveRename ??= openExclusiveRename();
  exclusiveRename(source, target);
}

// Python's standard library exposes the host's atomic primitive without installing a helper.
export const REMOTE_EXCLUSIVE_RENAME = `
import ctypes, os, sys
source, target = sys.argv[1:]
if source == target:
    sys.exit("Source and destination are identical")
libc = ctypes.CDLL(None, use_errno=True)
try:
    if sys.platform == "darwin":
        rename = libc.renamex_np
        rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        args = [os.fsencode(source), os.fsencode(target), 4]
    elif sys.platform.startswith("linux"):
        rename = libc.renameat2
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        args = [-100, os.fsencode(source), -100, os.fsencode(target), 1]
    else:
        raise AttributeError()
except AttributeError:
    sys.exit("Atomic file moves are unsupported on this host")
rename.restype = ctypes.c_int
result = rename(*args)
if result != 0:
    sys.exit(os.strerror(ctypes.get_errno()))
`;

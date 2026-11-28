// A package command's standard output, which a caller may read as data (the container's runner
// writes `cron supercronic`'s to its crontab). A reader redirects file descriptors, so nothing
// package code prints while gathering reaches it, from child processes and direct writes included.
// A `result` handler's text goes through a pipe the first process gave the reader, and that process
// prints it only when the reader exits 0.
import { dlopen } from "bun:ffi";
import { fstatSync, readdirSync, writeFileSync } from "node:fs";

/** The reader's descriptor for a result's text; descriptor 3 is unused. */
export const resultDescriptor = 4;

function sameFile(fd: number, other: number) {
  try {
    const [a, b] = [fstatSync(fd), fstatSync(other)];

    return a.dev === b.dev && a.ino === b.ino && a.rdev === b.rdev;
  } catch {
    return false;
  }
}

function load() {
  if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("Package commands redirect file descriptors only on Linux or macOS");
  const path = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";

  return dlopen(path, {
    dup: { args: ["i32"], returns: "i32" },
    dup2: { args: ["i32", "i32"], returns: "i32" },
    close: { args: ["i32"], returns: "i32" },
    lseek: { args: ["i32", "i64", "i32"], returns: "i64" },
  });
}

function checked(result: number, what: string) {
  if (result < 0) throw new Error(`office couldn't ${what} for a package command`);

  return result;
}

/** In a reader: leaves `text`, ending in a newline unless empty, for the first process to print if this one exits 0. */
export function writeResult(text: string) {
  writeFileSync(resultDescriptor, text && !text.endsWith("\n") ? `${text}\n` : text);
}

/**
 * In a reader, sends standard output to standard error until the returned function points it at
 * the caller's again, for a `run` handler or help. Call it before any package code runs.
 * `process.stdout` keeps the caller's terminal type, since the process started with the caller's
 * standard output. When standard error already writes where standard output does, as in a
 * terminal, there is nothing to keep apart and nothing is redirected.
 */
export function divertStdout(): () => void {
  const { dup, dup2, close, lseek } = load().symbols;
  const offset = (fd: number) => Number(lseek(fd, 0, 1));
  const at = offset(1);
  // Descriptors on standard output's file, standard error's among them when it is that file too.
  const candidates = [2, ...readdirSync("/dev/fd").map(Number).filter(fd => fd > 2)].filter(fd => sameFile(fd, 1));
  let shared = candidates;

  // A seekable file's descriptors write where 1 does only if they share its open file description,
  // and with it the offset: moved, 1's offset shows in each that shares it. Bun's process.stdout
  // writes through such a copy; another description of the file (standard error, or input, opened
  // on it separately) keeps its own. Any descriptor on a terminal or pipe writes to the same place.
  if (at >= 0) {
    const before = candidates.filter(fd => offset(fd) === at);

    try {
      // An offset that doesn't move (/dev/null's) tells nothing, and there is nothing to keep apart.
      if (Number(lseek(1, at + 1, 0)) === at + 1) shared = before.filter(fd => offset(fd) === at + 1);
    } finally {
      checked(Number(lseek(1, at, 0)), "restore standard output's offset");
    }
  }

  if (shared.includes(2)) return () => undefined;
  const targets = [1, ...shared];
  const saved = checked(dup(1), "keep standard output");

  for (const fd of targets) checked(dup2(2, fd), "redirect standard output");

  return () => {
    for (const fd of targets) checked(dup2(saved, fd), "restore standard output");
    close(saved);
  };
}

import { resultDescriptor } from "../command-stdout.ts";
import { OfficeError } from "../office.ts";
import { toolPath } from "../tool.ts";

function program() {
  return Bun.isStandaloneExecutable ? [process.execPath] : [process.execPath, "--no-install", toolPath("src/cli.ts")];
}

const callerOptions = "OFFICE_CALLER_BUN_OPTIONS";

/**
 * The compiled evaluator preserves symlinks, so a definition loaded through its set's link
 * resolves its imports inside that set. The checkout's pnpm-installed dependencies don't
 * resolve under the flag.
 */
function evaluatorEnv(): NodeJS.ProcessEnv {
  if (!Bun.isStandaloneExecutable) return process.env;
  const caller = process.env.BUN_OPTIONS;

  return { ...process.env, BUN_OPTIONS: [caller, "--preserve-symlinks"].filter(Boolean).join(" "), [callerOptions]: caller ?? "" };
}

/** Gives processes the evaluator starts the caller's BUN_OPTIONS back. */
export function restoreCallerEnv() {
  const caller = process.env[callerOptions];

  if (caller === undefined) return;
  delete process.env[callerOptions];

  if (caller) process.env.BUN_OPTIONS = caller;
  else delete process.env.BUN_OPTIONS;
}

/** Forwards Ctrl+C until disposed; the caller owns any pipes it asks for. */
export function spawnWorker(command: string[], env: NodeJS.ProcessEnv, descriptors: (number | "ignore" | "pipe")[] = []) {
  const child = Bun.spawn(command, { env, stdio: ["inherit", "inherit", "inherit", ...descriptors] });
  const stop = () => child.kill("SIGINT");
  process.once("SIGINT", stop);

  return { stdio: child.stdio, exited: child.exited, [Symbol.dispose]: () => process.off("SIGINT", stop) };
}

/** Runs an evaluator to completion with no result pipe. */
export async function runEvaluator(args: string[]) {
  using child = spawnWorker([...program(), ...args], evaluatorEnv());

  return await child.exited;
}

/** Starts a reader with a result pipe on fd 4. */
export function startReader(dir: string, args: string[]) {
  const child = spawnWorker([...program(), "--package-reader", dir, ...args], evaluatorEnv(), ["ignore", "pipe"]);
  const pipe = child.stdio[resultDescriptor];

  if (pipe === undefined || pipe === null) {
    child[Symbol.dispose]();

    throw new OfficeError("the package reader has no result pipe");
  }

  return { pipe, exited: child.exited, [Symbol.dispose]: child[Symbol.dispose] };
}

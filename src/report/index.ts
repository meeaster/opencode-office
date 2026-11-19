// How `office setup`, `office sync` and `office up` show progress. `reported` runs one of them with
// a reporter: Clack when stdin and stdout are a terminal, plain lines otherwise. Code deeper down
// reports through `say`, `warn`, `progress` and `output`, which go to the stage running now, or
// straight to the console when no reporter runs (other commands, tests): nothing may write around
// a live spinner. `stream` runs a slow subprocess without blocking, so the display stays live.
import { type ChildProcess, spawn } from "node:child_process";

import { OfficeError } from "../office.ts";
import { ClackReporter } from "./clack.ts";
import { PlainReporter } from "./plain.ts";
import { Cancelled, displayLines, type Question, type Reporter, type Stage } from "./reporter.ts";

export { type NextStep, type Reporter, type Stage, silentStage } from "./reporter.ts";

let reporter: Reporter | undefined;
const children = new Set<ChildProcess>();
const lasts: (() => void)[] = [];

/** The reporter running now, if any. */
export function currentReporter(): Reporter | undefined {
  return reporter;
}

function stage(): Stage | undefined {
  return reporter?.active;
}

/**
 * Something the user should read: the running stage's note, else a line on the console, after
 * `prefix`, which names the step there as a stage does under a reporter (such as "GitHub: ").
 */
export function say(text: string, prefix = ""): void {
  const active = stage();

  if (active !== undefined) active.note(text);
  else if (reporter !== undefined) reporter.note(text);
  else console.log(`${prefix}${text}`);
}

/** Something the user should know that doesn't stop the command. Without a reporter, `fallback` is printed as before. */
export function warn(text: string, fallback = `Warning: ${text}`): void {
  const active = stage();

  if (active !== undefined) active.warn(text);
  else if (reporter !== undefined) reporter.note(`warning: ${text}`);
  else console.log(fallback);
}

/** What the running stage is doing now; nothing without a reporter. */
export function progress(text: string): void {
  stage()?.detail(text);
}

/** One line of a subprocess's output: the running stage's, else the console. */
export function output(line: string): void {
  const active = stage();

  if (active !== undefined) active.output(line);
  else console.log(line);
}

/** Hands the terminal to `body` (a browser login, sudo's prompt), pausing any live display. */
export async function inherit<T>(what: string, body: () => T | Promise<T>): Promise<T> {
  const active = stage();

  return active === undefined ? body() : active.inherit(what, body);
}

/** Runs `action` after everything else the command shows, even when it stops. */
export function last(action: () => void): void {
  lasts.push(action);
}

/**
 * The `ask` setup's steps take, for prompts on a terminal: a question ending in [yes/no] becomes
 * a confirm, [yes/no/other] a choice, anything else a text prompt. Undefined without a terminal,
 * where the steps take their flags or stop, naming one.
 */
export function terminalAsk(): ((text: string) => Promise<string>) | undefined {
  const current = reporter;

  if (current === undefined || !current.interactive) return undefined;

  return async (text) => {
    const choice = /\s*\[([a-z/]+)\]\s*$/.exec(text);
    const message = choice === null ? text.replace(/:\s*$/, "") : text.slice(0, choice.index);

    if (choice?.[1] === "yes/no") return (await current.ask({ kind: "confirm", message })) ? "yes" : "no";

    if (choice !== null) {
      const options = choice[1].split("/").map((value) => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) }));

      return current.ask({ kind: "select", message, options });
    }

    return (await current.ask({ kind: "text", message })).trim();
  };
}

/** A question on the terminal; callers check `currentReporter()?.interactive` first. */
export function ask<Q extends Question>(question: Q) {
  if (reporter === undefined || !reporter.interactive) throw new OfficeError(`${question.message} Rerun interactively or supply the documented setup options; no prompt was opened`);

  return reporter.ask(question);
}

function killChildren(): void {
  for (const child of children) child.kill("SIGTERM");
}

/** What `stream` saw: the exit status (1 for a signal or a spawn error) and everything printed. */
export type Streamed = { status: number; stdout: string; stderr: string };

/** A subprocess line for the running stage only; dropped without one. */
function stageOutput(line: string): void {
  stage()?.output(line);
}

/**
 * Runs a command without blocking, stdin closed, giving each display line of its output to `line`
 * (the running stage's output by default, nothing without one) and returning the whole output.
 * Ctrl+C or the end of the command stops it.
 */
export function stream(command: string, args: string[], { cwd, env, timeout, line = stageOutput }: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; line?: (text: string) => void } = {}): Promise<Streamed> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const collected = { stdout: "", stderr: "" };
    const pending = { stdout: "", stderr: "" };
    const timer = timeout === undefined ? undefined : setTimeout(() => child.kill("SIGTERM"), timeout);

    children.add(child);

    // A progress meter rewrites its line after each carriage return, many times a second: such an
    // update is shown at most once a second, and every line that ends in a newline is shown.
    const meter = { stdout: -Infinity, stderr: -Infinity };

    const take = (which: "stdout" | "stderr") => (chunk: Buffer) => {
      const text = chunk.toString("utf8");

      collected[which] += text;
      pending[which] += text;

      // Each piece with the separator that ended it; the last may be a line still being written.
      const pieces = pending[which].split(/(\r\n|\r|\n)/);

      pending[which] = pieces.pop() ?? "";

      for (let index = 0; index < pieces.length; index += 2) {
        if (pieces[index + 1] === "\r") {
          if (performance.now() - meter[which] < 1000) continue;

          meter[which] = performance.now();
        }

        for (const shown of displayLines(pieces[index])) line(shown);
      }
    };

    child.stdout.on("data", take("stdout"));
    child.stderr.on("data", take("stderr"));

    const settle = (status: number, error?: string) => {
      if (timer !== undefined) clearTimeout(timer);
      children.delete(child);

      for (const rest of [pending.stdout, pending.stderr]) for (const shown of displayLines(rest)) line(shown);

      resolve({ status, stdout: collected.stdout, stderr: error ?? collected.stderr });
    };

    child.on("error", (error) => settle(1, error.message));
    child.on("close", (code) => settle(code ?? 1));
  });
}

/**
 * A command that exited unsuccessfully, with a message like execFileSync's: the command, then the
 * last line it printed on stderr (git's `fatal:`, BuildKit's `ERROR:`). A long command line is
 * cut; the stage already shows the rest of the output.
 */
export class CommandFailed extends OfficeError {
  constructor(readonly command: string[], readonly result: Streamed) {
    const line = command.join(" ");
    const said = displayLines(result.stderr).at(-1) ?? "";

    super(`Command failed: ${line.length > 160 ? `${line.slice(0, 159)}…` : line}${said === "" ? "" : `\n${said}`}`);
  }
}

/** `stream`, throwing CommandFailed unless the command succeeds. */
export async function streamChecked(command: string, args: string[], options: Parameters<typeof stream>[2] = {}): Promise<Streamed> {
  const result = await stream(command, args, options);

  if (result.status !== 0) throw new CommandFailed([command, ...args], result);

  return result;
}

/** Whether progress goes to a terminal, so the Clack renderer is used. */
export function onTerminal(): boolean {
  return process.stdout.isTTY === true && process.stdin.isTTY === true;
}

/**
 * Runs an office command with a reporter. An OfficeError stops it with the reason and exit code 1,
 * Ctrl+C with 130; anything else is reported and rethrown. What `last` registered runs at the end.
 */
export async function reported(command: "setup" | "sync" | "up" | "refresh" | "check" | "skills update" | "packages update", context: string, body: (reporter: Reporter) => Promise<void>, { verbose = false } = {}): Promise<void> {
  const name = `office ${command}`;
  const rerun = `Run ${name} again to continue`;
  let over = false;

  // Ctrl+C during a stage; interactive prompts handle their own cancellation.
  const interrupt = () => {
    if (over) return;
    over = true;
    killChildren();
    created.interrupted();
    process.exit(130);
  };

  const created: Reporter = onTerminal() ? new ClackReporter(name, rerun) : new PlainReporter(name, verbose);

  // Restore the terminal and report an interruption on an unexpected exit during a stage.
  const onExit = () => {
    if (over) return;
    over = true;
    killChildren();
    created.interrupted();
    process.exitCode = 130;
  };

  reporter = created;
  process.on("exit", onExit);
  process.on("SIGINT", interrupt);

  try {
    created.begin(context);
    await body(created);
  } catch (error) {
    if (error instanceof Cancelled) process.exitCode = 130;
    // A blocking child killed by the same Ctrl+C: execFileSync's error names the signal.
    else if (error instanceof Error && "signal" in error && error.signal === "SIGINT") interrupt();
    else {
      created.active?.fail();
      created.stopped(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;

      if (!(error instanceof OfficeError)) throw error;
    }
  } finally {
    over = true;
    process.off("exit", onExit);
    process.off("SIGINT", interrupt);
    reporter = undefined;

    for (const action of lasts.splice(0)) action();
  }
}

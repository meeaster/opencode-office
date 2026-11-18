// The one interface `office setup`, `office sync` and `office up` report progress through. The
// command decides what happens and what it means; a renderer decides only how it looks: Clack on a
// terminal (src/report/clack.ts), plain lines otherwise (src/report/plain.ts).

/** A question for the person at the terminal. Only an interactive reporter asks one. */
export type Question =
  | { kind: "confirm"; message: string; initial?: boolean }
  | { kind: "select"; message: string; options: { value: string; label: string; hint?: string }[] }
  | { kind: "text"; message: string; placeholder?: string; validate?: (value: string) => string | undefined };

export type Answer<Q extends Question> = Q extends { kind: "confirm" } ? boolean : string;

export interface Reporter {
  /** True when questions open prompts. Without a terminal nothing ever prompts. */
  readonly interactive: boolean;
  /** The stage running now, if any. */
  readonly active: Stage | undefined;
  begin(context: string): void;
  /**
   * `title` is what a person reads; `key` prefixes plain lines. A stage's first subprocess line
   * turns its spinner into the last few lines on a terminal.
   */
  stage(title: string, options: { key: string }): Stage;
  ask<Q extends Question>(question: Q): Promise<Answer<Q>>;
  /** Something said outside any stage. */
  note(text: string): void;
  /** The command succeeded: closing next steps, the things only the user can do. */
  finish(steps: NextStep[]): void;
  /** The command stopped: what to fix, and that rerunning continues. */
  stopped(reason: string): void;
  /** The user interrupted the command (Ctrl+C). */
  interrupted(): void;
}

export interface Stage {
  /** What the stage is doing now; replaces the previous detail. */
  detail(text: string): void;
  /** One line of a subprocess's output. */
  output(line: string): void;
  /** A named piece of work inside the stage, such as cloning one reference; several may run at once. */
  part(name: string, doing: string): Part;
  /** How many parts the stage will run, for a count while they do. */
  expect(parts: number): void;
  /** Something said once, not a warning (for example a change sync made). */
  note(text: string): void;
  /** Something the user should know that doesn't stop the stage. */
  warn(text: string): void;
  /** A problem the stage reports and goes on past, such as a sync line that starts with FAILED. */
  error(text: string): void;
  /**
   * Hands the terminal to `body`, such as a browser login, sudo's password prompt or office
   * check's own lines: the live display pauses until it returns.
   */
  inherit<T>(what: string, body: () => T | Promise<T>): Promise<T>;
  done(summary?: string): void;
  fail(reason?: string): void;
}

export interface Part {
  output(line: string): void;
  done(summary?: string): void;
  fail(reason: string): void;
}

/** A closing group of things only the user can do: each a label and, usually, a command or URL. */
export type NextStep = { title: string; items: { label: string; value?: string }[] };

/** Thrown when the user cancels a prompt; the command ends without a stack trace. */
export class Cancelled extends Error {}

export function elapsed(ms: number): string {
  const seconds = Math.round(ms / 1000);

  if (seconds < 1) return "";

  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * A failed part's reason as one line, and the evidence to show under it: the part's own last
 * output lines, then any line of the reason that output doesn't already hold (git's error is both).
 */
export function partFailure(reason: string, own: string[]) {
  const [first = "", ...rest] = reason.split("\n");
  const extra = rest.map((line) => line.trim()).filter((line) => line !== "" && !own.some((seen) => seen.trim() === line));

  return { reason: first, evidence: [...own, ...extra] };
}

/** A stage that reports nothing, for callers without a reporter (tests, `office init`). */
export const silentStage: Stage = {
  detail() {},
  output() {},
  part: () => ({ output() {}, done() {}, fail() {} }),
  expect() {},
  note() {},
  warn() {},
  error() {},
  inherit: async (_what, body) => body(),
  done() {},
  fail() {},
};

// CSI and OSC sequences, then any other control character but tab.
const control = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]|[\u0000-\u0008\u000b-\u001f\u007f]/g;

/**
 * Splits subprocess output into display lines: on newlines and on the carriage returns progress
 * meters (git's, Docker's) separate their updates with, without escape codes, blank lines dropped.
 * Clack's taskLog counts escape codes as width and would erase lines above itself.
 */
export function displayLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/).map((line) => line.replace(control, "").trimEnd()).filter((line) => line.trim() !== "");
}

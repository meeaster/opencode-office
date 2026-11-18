// The renderer on a terminal, with Clack. A stage shows a spinner with elapsed time, which becomes a
// taskLog of the last few subprocess lines at the first one, and ends as one line; prompts and
// inherited sections pause whatever is live. Clack must never write when output isn't a terminal:
// its taskLog writes erase codes even into a pipe, so src/report/index.ts picks the plain renderer.
import { styleText } from "node:util";

import * as clack from "@clack/prompts";

import { type Answer, Cancelled, elapsed, partFailure, type NextStep, type Part, type Question, type Reporter, type Stage } from "./reporter.ts";

/** Lines of output a taskLog shows while it runs. */
const logLimit = 3;

/** A stage that finishes within this is printed as one line, with no spinner flashing first. */
const quiet = 150;

const dim = (text: string) => styleText("dim", text);

function columns(): number {
  return process.stdout.columns ?? 80;
}

/** One line cut to fit the terminal: wrapped lines in a taskLog or spinner break their erasing. */
function fit(line: string, reserve = 4): string {
  const width = Math.max(20, columns() - reserve);

  return line.length > width ? `${line.slice(0, width - 1)}…` : line;
}

/** Clack's log lines don't wrap to the terminal, so a long one breaks the guide; wrap it first. */
function wrap(text: string): string {
  const width = Math.max(30, columns() - 4);

  return text
    .split("\n")
    .map((paragraph) => {
      const lines: string[] = [];
      let line = "";

      for (const word of paragraph.split(" ")) {
        if (line !== "" && line.length + 1 + word.length > width) {
          lines.push(line);
          line = word;
        } else line = line === "" ? word : `${line} ${word}`;
      }

      return [...lines, line].join("\n");
    })
    .join("\n");
}

export class ClackReporter implements Reporter {
  readonly interactive = true;
  active: ClackStage | undefined;

  /** `rerun` says how to continue, such as "Run office setup again to continue". */
  constructor(private readonly command: string, private readonly rerun: string, private readonly onSpinnerCancel: () => void) {}

  begin(context: string): void {
    // Clack's intro doesn't wrap: the context is cut to the line.
    clack.intro(`${styleText(["bgCyan", "black"], ` ${this.command} `)} ${dim(fit(context, this.command.length + 8))}`);
  }

  stage(name: string, _options: { key: string }): Stage {
    const stage = new ClackStage(name, this.onSpinnerCancel, () => {
      if (this.active === stage) this.active = undefined;
    });

    this.active = stage;

    return stage;
  }

  async ask<Q extends Question>(question: Q): Promise<Answer<Q>> {
    const resume = this.active?.pause();
    let answer: unknown;

    if (question.kind === "confirm") answer = await clack.confirm({ message: wrap(question.message), initialValue: question.initial ?? true });
    else if (question.kind === "select") answer = await clack.select({ message: wrap(question.message), options: question.options });
    else answer = await clack.text({ message: wrap(question.message), placeholder: question.placeholder, validate: question.validate && ((value) => question.validate?.(value ?? "")) });

    if (clack.isCancel(answer)) {
      this.active?.abandon();
      clack.cancel(`Stopped at your request. ${this.rerun}.`);
      throw new Cancelled();
    }

    resume?.();

    // SAFETY: not a cancel, so confirm answered a boolean and select and text a string, as Answer<Q> maps each kind.
    return answer as Answer<Q>;
  }

  note(text: string): void {
    clack.log.info(wrap(text));
  }

  finish(steps: NextStep[]): void {
    for (const step of steps) {
      const width = Math.max(0, ...step.items.filter((item) => item.value && item.label).map((item) => item.label.length));
      // Side by side when it fits; otherwise each value under its label.
      const fits = step.items.every((item) => !item.value || width + 2 + item.value.length <= columns() - 8);

      const line = (item: (typeof step.items)[number]) => {
        if (!item.value) return wrap(item.label);

        if (item.label === "") return `  ${styleText("cyan", item.value)}`;

        return fits ? `${item.label.padEnd(width)}  ${styleText("cyan", item.value)}` : `${wrap(item.label)}\n  ${styleText("cyan", item.value)}`;
      };

      clack.note(step.items.map(line).join("\n"), step.title);
    }

    clack.outro(`${this.command} is done.`);
  }

  stopped(reason: string): void {
    this.active?.abandon();
    // cancel() doesn't indent a second line, so the reason goes in a log line above it.
    clack.log.error(wrap(reason));
    clack.cancel(`Stopped. Once that's fixed, ${this.rerun.charAt(0).toLowerCase()}${this.rerun.slice(1)}.`);
  }

  interrupted(): void {
    this.active?.abandon();
    process.stdout.write("\r"); // over the terminal's ^C echo
    clack.cancel(`Interrupted. ${this.rerun}.`);
  }
}

class ClackStage implements Stage {
  private readonly start = performance.now();
  private paused = 0;
  private spin: ReturnType<typeof clack.spinner> | undefined;
  private log: ReturnType<typeof clack.taskLog> | undefined;
  /** The taskLog's group for the current detail: its header names the step, its lines are the step's output. */
  private group: ReturnType<ReturnType<typeof clack.taskLog>["group"]> | undefined;
  private detailText: string | undefined;
  private lazy: ReturnType<typeof setTimeout> | undefined;
  private message: string;
  /** Notes, warnings and errors, shown when the stage ends or something pauses it. */
  private readonly pending: { kind: "note" | "warn" | "error"; text: string }[] = [];
  private readonly tail: string[] = [];
  private readonly running: string[] = [];
  private total = 0;
  private finishedParts = 0;
  private readonly completedLines: string[] = [];
  /** Output of parts that failed, shown on their own when the stage fails. */
  private readonly failedParts: string[] = [];
  /** Whether the stage's header line has been written above its part lines. */
  private headed = false;
  private finished = false;

  constructor(private readonly name: string, private readonly onCancel: () => void, private readonly onEnd: () => void) {
    this.message = name;
    this.lazy = setTimeout(() => this.show(), quiet);
  }

  /** Starts the live view once the stage has run long enough to need one. */
  private show(): void {
    this.lazy = undefined;

    if (this.finished || this.spin !== undefined || this.log !== undefined) return;

    // withGuide off: Clack would print a guide line above the spinner that clear() leaves behind.
    this.spin = clack.spinner({ indicator: "timer", withGuide: false, onCancel: this.onCancel, cancelMessage: `${this.name} interrupted` });
    this.spin.start(this.spinnerText());
  }

  /**
   * The spinner's message, kept to one line: writing above a spinner relies on it erasing exactly
   * one. While parts run, the stage's header is above them, so the spinner carries only the count
   * and the names in flight.
   */
  private spinnerText(): string {
    if (this.running.length === 0) return fit(this.message, 12);

    const verbs = new Set(this.running.map((entry) => entry.split(" ")[0]));
    const names = verbs.size === 1 ? `${[...verbs][0]} ${this.running.map((entry) => entry.slice(entry.indexOf(" ") + 1)).join(", ")}` : this.running.join(", ");
    const count = this.total > 0 ? `${this.finishedParts}/${this.total} done · ` : "";

    return fit(`${count}${names}`, 12);
  }

  private refresh(): void {
    this.spin?.message(this.spinnerText());
  }

  /**
   * Swaps the spinner for a taskLog at the first subprocess line: taskLog has no timer, so the
   * spinner covers the quiet part of a stage. Its title is the stage; each detail is a group whose
   * header names the step, so a later step doesn't run under an earlier one's name, and a finished
   * step collapses to one line until the stage ends. Nothing styled goes into a taskLog: it
   * measures lines with their escape codes when erasing, and would erase lines above itself.
   */
  private logView(): { message(line: string): void } {
    if (this.log === undefined) {
      if (this.lazy !== undefined) clearTimeout(this.lazy), (this.lazy = undefined);
      this.spin?.clear();
      this.spin = undefined;
      this.log = clack.taskLog({ title: this.name, limit: logLimit });
      this.group = this.detailText === undefined ? undefined : this.log.group(fit(this.detailText));
    }

    return this.group ?? this.log;
  }

  /** Writes a persistent line above the live spinner, which redraws itself below it on its next frame. */
  private above(line: string): void {
    process.stdout.write(`${this.spin === undefined ? "" : "\r\u001b[J"}${line}\n`);
  }

  /** The stage's name above its part lines, once. */
  private header(): void {
    if (this.headed) return;

    this.headed = true;
    this.above(`${styleText("gray", clack.S_BAR)}\n${styleText("green", clack.S_STEP_SUBMIT)}  ${this.name}`);
  }

  private took(): string {
    return elapsed(performance.now() - this.start - this.paused);
  }

  private flush(): void {
    if (this.completedLines.length > 0) process.stdout.write(`${this.completedLines.splice(0).join("\n")}\n`);

    for (const { kind, text } of this.pending.splice(0)) {
      if (kind === "note") clack.log.info(wrap(text));
      else if (kind === "warn") clack.log.warn(wrap(text));
      else clack.log.error(wrap(text));
    }
  }

  /** Clears the live view for a prompt or the terminal's own use; the returned function brings it back. */
  pause(): () => void {
    const at = performance.now();

    if (this.lazy !== undefined) clearTimeout(this.lazy), (this.lazy = undefined);
    this.spin?.clear();
    this.spin = undefined;
    // A taskLog can't pause: its last lines stay on screen as they are, and a later line starts a new one.
    this.log = undefined;
    this.group = undefined;
    this.flush();

    return () => {
      this.paused += performance.now() - at;

      if (!this.finished) this.lazy = setTimeout(() => this.show(), quiet);
    };
  }

  /** Stops the live view without a result line (Clack's cancel also drops its exit handlers). */
  abandon(): void {
    this.finished = true;

    if (this.lazy !== undefined) clearTimeout(this.lazy);
    this.spin?.cancel(`${this.name} interrupted`);
    this.log?.error(`${this.name} interrupted`, { showLog: false });
    this.spin = undefined;
    this.log = undefined;
    this.onEnd();
  }

  detail(text: string): void {
    this.message = `${this.name}: ${text}`;

    if (this.log !== undefined) {
      if (this.detailText !== undefined) this.group?.success(fit(this.detailText));
      this.group = this.log.group(fit(text));
    } else this.refresh();

    this.detailText = text;
  }

  output(line: string): void {
    this.tail.push(line);

    if (this.tail.length > 20) this.tail.shift();

    if (!this.finished) this.logView().message(fit(line));
  }

  expect(parts: number): void {
    this.total = parts;
    this.refresh();
  }

  part(name: string, doing: string): Part {
    const entry = `${doing} ${name}`;
    const start = performance.now();
    const own: string[] = [];

    const end = () => {
      this.running.splice(this.running.indexOf(entry), 1);
      this.finishedParts++;
      this.refresh();
    };

    this.header();
    this.running.push(entry);
    this.refresh();

    return {
      output: (line) => {
        own.push(line);

        if (own.length > 10) own.shift();
      },
      done: (summary) => {
        end();
        const rest = [summary ?? "done", elapsed(performance.now() - start)].filter(Boolean).join(" · ");

        this.completedLines.push(`${styleText("gray", clack.S_BAR)}  ${styleText("green", "✓")} ${name}  ${dim(rest)}`);
      },
      fail: (why) => {
        const { reason, evidence } = partFailure(why, own);

        end();
        this.above(`${styleText("gray", clack.S_BAR)}  ${styleText("red", "✗")} ${name}  ${styleText("red", fit(reason, name.length + 10))}`);
        this.failedParts.push(`${entry}: ${reason}`, ...evidence);
      },
    };
  }

  note(text: string): void {
    this.pending.push({ kind: "note", text });
  }

  warn(text: string): void {
    this.pending.push({ kind: "warn", text });
  }

  error(text: string): void {
    this.pending.push({ kind: "error", text });
  }

  async inherit<T>(what: string, body: () => T | Promise<T>): Promise<T> {
    const resume = this.pause();

    clack.log.step(wrap(what));

    try {
      return await body();
    } finally {
      resume();
    }
  }

  private end(): void {
    this.finished = true;

    if (this.lazy !== undefined) clearTimeout(this.lazy);
    this.onEnd();
  }

  done(summary?: string): void {
    this.end();

    const rest = [summary, this.took()].filter(Boolean).join(" · ");

    // Plain text into a taskLog (see logView); dim elsewhere.
    if (this.log !== undefined) this.log.success(wrap(`${this.name}  ${rest}`));
    else {
      this.spin?.clear();
      const [first = "", ...more] = wrap(`${this.name}  ${rest}`).split("\n");

      clack.log.success([first.startsWith(`${this.name}  `) ? `${this.name}  ${dim(first.slice(this.name.length + 2))}` : first, ...more.map(dim)].join("\n"));
    }

    this.spin = undefined;
    this.log = undefined;
    this.flush();
  }

  fail(reason?: string): void {
    this.end();

    // Without a reason of its own, the step it was on says where it failed.
    const why = reason ?? (this.detailText === undefined ? undefined : `while ${this.detailText}`);
    const line = `${this.name} failed${this.took() ? ` after ${this.took()}` : ""}${why ? `: ${why}` : ""}`;
    // Only the output that explains the failure stays: a failed part's, else the stage's last lines.
    // (taskLog.error's own showLog would replay everything.)
    const evidence = this.failedParts.length > 0 ? this.failedParts : this.tail.slice(-12);

    if (this.log !== undefined) this.log.error(wrap(line), { showLog: false });
    else {
      this.spin?.clear();
      clack.log.error(wrap(line));
    }

    this.spin = undefined;
    this.log = undefined;

    if (evidence.length > 0) clack.log.message(evidence.map((entry) => dim(fit(entry, 6))).join("\n"));

    this.flush();
  }
}

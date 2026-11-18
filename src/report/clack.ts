// The terminal renderer: Clack owns prompts and permanent output; stages own their live rows.
import { styleText } from "node:util";

import * as clack from "@clack/prompts";

import { type Answer, Cancelled, elapsed, partFailure, type NextStep, type Part, type Question, type Reporter, type Stage } from "./reporter.ts";

/** Lines of output a taskLog shows while it runs. */
const logLimit = 3;

/** A stage that finishes within this is printed as one line, with no spinner flashing first. */
const quiet = 150;

const dim = (text: string) => styleText("dim", text);
const graphemes = new Intl.Segmenter();

function columns(): number {
  return process.stdout.columns ?? 80;
}

/** One line cut to fit the terminal: wrapped lines in a taskLog or spinner break their erasing. */
function fit(line: string, reserve = 4): string {
  const width = Math.max(1, columns() - reserve);

  const text = line.replaceAll("\t", "    ");

  if (Bun.stringWidth(text) <= width) return text;

  let used = 0;
  let end = 0;

  for (const { segment, index } of graphemes.segment(text)) {
    used += Bun.stringWidth(segment);

    if (used >= width) break;
    end = index + segment.length;
  }

  return `${text.slice(0, end)}…`;
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
  constructor(private readonly command: string, private readonly rerun: string) {}

  begin(context: string): void {
    // Clack's intro doesn't wrap: the context is cut to the line.
    clack.intro(`${styleText(["bgCyan", "black"], ` ${this.command} `)} ${dim(fit(context, this.command.length + 8))}`);
  }

  stage(name: string, _options: { key: string }): Stage {
    const stage = new ClackStage(name, () => {
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

/** Animation frames overwrite only the leading glyph, never erase and repaint a stationary label. */
class StatusLine {
  private drawn = "";
  private readonly started = performance.now();
  private frame = 0;
  private seconds = 0;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private text: string) {
    process.stdout.write("\x1b[?25l");
    this.draw();
    this.timer = setInterval(() => {
      this.frame++;
      const seconds = Math.floor((performance.now() - this.started) / 1000);

      const previous = this.seconds;
      this.seconds = seconds;

      if (this.drawn !== this.text) this.draw();
      else process.stdout.write(`\r${this.glyph()}${seconds === previous ? "" : this.clock(seconds)}`);
    }, 100);
  }

  private glyph(): string {
    return styleText("magenta", ["◒", "◐", "◓", "◑"][this.frame % 4]);
  }

  private clock(seconds: number): string {
    return ` ${`${seconds}s`.padStart(6)} `;
  }

  private draw(): void {
    this.drawn = this.text;
    process.stdout.write(`\r${this.glyph()}${this.clock(this.seconds)} ${this.text}\x1b[K`);
  }

  message(text: string): void {
    this.text = text;
  }

  above(line: string): void {
    process.stdout.write(`\r${line.replaceAll("\n", "\x1b[K\n")}\x1b[K\n`);
    this.draw();
  }

  clear(): void {
    clearInterval(this.timer);
    process.stdout.write("\r\x1b[K\x1b[?25h");
  }
}

/** Cursor rests just below the visible rows. The heading above them is never part of a repaint. */
class LiveLog {
  private readonly lines: string[] = [];
  private rows = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(heading: string) {
    clack.log.step(fit(heading));
  }

  message(line: string): void {
    this.lines.push(line);

    if (this.lines.length > logLimit) this.lines.shift();
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      const up = this.rows ? `\x1b[${this.rows}A` : "";
      process.stdout.write(up + this.lines.map((entry) => `\r  ${fit(entry)}\x1b[K\n`).join(""));
      this.rows = this.lines.length;
    }, 100);
  }

  clear(): void {
    clearTimeout(this.timer);

    if (this.rows) process.stdout.write(`\x1b[${this.rows}A\r\x1b[J`);
  }
}

class ClackStage implements Stage {
  private readonly start = performance.now();
  private paused = 0;
  private spin: StatusLine | undefined;
  private log: LiveLog | undefined;
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

  constructor(private readonly name: string, private readonly onEnd: () => void) {
    this.message = name;
    this.lazy = setTimeout(() => this.show(), quiet);
  }

  /** Starts the live view once the stage has run long enough to need one. */
  private show(): void {
    this.lazy = undefined;

    if (this.finished || this.spin !== undefined || this.log !== undefined) return;

    this.spin = new StatusLine(this.spinnerText());
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

  /** Switch from quiet progress to the current step's subprocess output. */
  private logView(): { message(line: string): void } {
    if (this.log === undefined) {
      if (this.lazy !== undefined) clearTimeout(this.lazy), (this.lazy = undefined);
      this.spin?.clear();
      this.spin = undefined;
      this.log = new LiveLog(this.message);
    }

    return this.log;
  }

  /** Writes a persistent line above the live spinner, which redraws itself below it on its next frame. */
  private above(line: string): void {
    this.log?.clear();
    this.log = undefined;

    if (this.spin) this.spin.above(line);
    else process.stdout.write(`${line}\n`);
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
    this.log?.clear();
    this.log = undefined;
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
    this.spin?.clear();
    this.log?.clear();
    this.spin = undefined;
    this.log = undefined;
    this.onEnd();
  }

  detail(text: string): void {
    if (text === this.detailText) return;
    this.message = `${this.name}: ${text}`;

    if (this.log !== undefined) {
      this.log.clear();
      this.log = undefined;
      this.lazy = setTimeout(() => this.show(), quiet);
    } else this.refresh();

    this.detailText = text;
  }

  output(line: string): void {
    this.tail.push(line);

    if (this.tail.length > 20) this.tail.shift();

    if (!this.finished) this.logView().message(line);
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

    this.log?.clear();
    this.spin?.clear();
    const [first = "", ...more] = wrap(`${this.name}  ${rest}`).split("\n");

    clack.log.success([first.startsWith(`${this.name}  `) ? `${this.name}  ${dim(first.slice(this.name.length + 2))}` : first, ...more.map(dim)].join("\n"));

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
    const evidence = this.failedParts.length > 0 ? this.failedParts : this.tail.slice(-12);

    this.log?.clear();
    this.spin?.clear();
    clack.log.error(wrap(line));

    this.spin = undefined;
    this.log = undefined;

    if (evidence.length > 0) clack.log.message(evidence.map((entry) => dim(fit(entry, 6))).join("\n"));

    this.flush();
  }
}

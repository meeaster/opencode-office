// The renderer without a terminal: agents, cron and pipes. One line per event, `key: message`, no
// escape codes, never a prompt. Subprocess output is kept back and shown only when its work fails
// (its last lines), unless `verbose` prints every line as it comes.
import { type Answer, elapsed, partFailure, type NextStep, type Part, type Question, type Reporter, type Stage } from "./reporter.ts";

/** How many of a failed subprocess's last lines are shown. */
const tailLength = 12;

export class PlainReporter implements Reporter {
  readonly interactive = false;
  active: Stage | undefined;
  private started = performance.now();

  constructor(
    private readonly command: string,
    private readonly verbose: boolean,
    private readonly write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
    private readonly writeError: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  ) {}

  begin(context: string): void {
    this.started = performance.now();
    this.write(`${this.command}: ${context}`);
  }

  stage(_title: string, { key }: { key: string }): Stage {
    // A multi-line message keeps its prefix on every line.
    const say = (text: string) => {
      for (const line of text.split("\n")) this.write(`${key}: ${line}`);
    };

    const tail: string[] = [];

    const keep = (line: string) => {
      if (this.verbose) say(`| ${line}`);
      else {
        tail.push(line);

        if (tail.length > tailLength) tail.shift();
      }
    };

    const start = performance.now();
    const took = (from: number) => (elapsed(performance.now() - from) ? ` (${elapsed(performance.now() - from)})` : "");

    const end = () => {
      if (this.active === stage) this.active = undefined;
    };

    const stage: Stage = {
      detail: say,
      output: keep,
      part: (name, doing): Part => {
        const partStart = performance.now();
        const own: string[] = [];

        say(`${doing} ${name}`);

        return {
          output: (line) => {
            if (this.verbose) say(`| ${name}: ${line}`);
            else {
              own.push(line);

              if (own.length > tailLength) own.shift();
            }
          },
          done: (summary) => say(`${name}: ${summary ?? "done"}${took(partStart)}`),
          fail: (why) => {
            const { reason, evidence } = partFailure(why, this.verbose ? [] : own);

            say(`${name}: FAILED: ${reason}`);

            for (const line of evidence) say(`| ${name}: ${line}`);
          },
        };
      },
      expect() {},
      note: say,
      warn: (text) => say(`warning: ${text}`),
      error: say,
      inherit: async (what, body) => {
        say(what);

        return body();
      },
      done: (summary) => {
        end();
        say(`done${summary ? `: ${summary}` : ""}${took(start)}`);
      },
      fail: (reason) => {
        end();

        for (const line of tail) say(`| ${line}`);
        tail.length = 0;
        say(`FAILED${reason ? `: ${reason}` : ""}${took(start)}`);
      },
    };

    this.active = stage;

    return stage;
  }

  ask<Q extends Question>(question: Q): Promise<Answer<Q>> {
    return Promise.reject(new Error(`no prompt opens without a terminal: ${question.message}`));
  }

  note(text: string): void {
    for (const line of text.split("\n")) this.write(`${this.command}: ${line}`);
  }

  finish(steps: NextStep[]): void {
    this.write(`${this.command}: done (${elapsed(performance.now() - this.started) || "0s"})`);

    for (const step of steps) {
      for (const item of step.items) this.write(`next: ${[item.label.replace(/:$/, ""), item.value].filter(Boolean).join(": ")}`);
    }
  }

  stopped(reason: string): void {
    const [first, ...rest] = reason.split("\n");

    this.writeError(`${this.command}: stopped: ${first}`);

    for (const line of rest) this.writeError(`${this.command}: ${line}`);
  }

  interrupted(): void {
    this.writeError(`${this.command}: interrupted; run ${this.command} again to continue`);
  }
}

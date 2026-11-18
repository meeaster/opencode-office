# Clack terminal rendering in `office`

**There is no synchronized-output or flicker-free animation switch in the installed release.** The [lockfile](../../pnpm-lock.yaml) resolves `@clack/prompts` 1.9.0 and `@clack/core` 1.6.0. The three renderers behave differently in that [upstream release][release]:

| Renderer | What actually reaches the terminal |
| --- | --- |
| `spinner()` | On a normal interactive terminal each tick moves the cursor, erases downward, then writes the whole frame in separate writes. `delay` (80 ms for Unicode, 120 ms otherwise) changes the tick rate, not the erase strategy. `frames`, `styleFrame`, and `indicator: 'timer'` change appearance; even one frame still repaints. `message()` updates state for the next tick. `clear()` stops without a result line but leaves the initial guide bar if enabled. [Options and defaults][spinner-options] · [render loop][spinner-render] · [cleanup][spinner-end] |
| `taskLog()` | Event-driven: each `message()` clears the previous region and, on a non-CI TTY, reprints all visible groups. `limit` bounds lines per buffer, not refresh frequency; `raw` joins consecutive chunks, not writes. `retainLog` keeps evicted history for final display. Success hides the log by default; error shows it; `showLog` overrides either. There is no public pause or clear. Even off-TTY the erase path runs, so use plain output for pipes. [Clear and height calculation][log-clear] · [updates and limits][log-update] · [public methods][log-end] |
| `confirm()`, `select()`, `text()` | The core prompt renderer skips identical wrapped frames. It can repaint one changed line or redraw from the first changed line down; cursor movement, erasure and replacement are separate writes. This optimization is internal to prompts, not shared by spinner or task log. [Core render routine][prompt] |

**For the office reporter:** use `spinner({ accessible: true })` when static status is acceptable: it prints the starting message, a heartbeat every 30 seconds, and a final line. `message()` does not immediately announce a change in that mode. The setting resolves per call, then globally, then via `ACCESSIBLE`; `taskLog` does not consult it. For animated status with a stationary label, updating just the changed glyph or clock is an application-level choice. Give prompts exclusive use of the terminal while awaiting input: their cursor positions are relative to their own last frame. [Accessible spinner][spinner-render] · [settings resolution][settings] · [task log initialization][log-clear] · [prompt cursor restoration][prompt]

Terminal *synchronized output* (DEC private mode 2026) is a separate protocol: supporting terminals defer display updates between `CSI ? 2026 h` and `CSI ? 2026 l`. Clack’s render routines above do not emit those brackets. If used by an application, bracket **one complete redraw**, never the time spent waiting for a subprocess or a prompt answer. [Terminal protocol and support query][sync]

## Local evidence: 80-column PTY

The user's measurements of [`ClackReporter`](../../src/report/clack.ts) count terminal writes and escape sequences, not screen refreshes:

| Scenario | Observed output |
| --- | --- |
| `stage → detail → output` (100 consecutive lines) `→ done` | 100 group-label writes and 500 `CSI 2 K` line erases. |
| Four parts already started; 24 rapid simulated repo completions/replacements | 44 visible progress labels and 24 success lines. |
| Idle `Tools` stage | The label was written once. |

The repeated labels in these runs came with incoming output or part changes, not idle animation. [`stream()`](../../src/report/index.ts#L124-L165) throttles carriage-return progress updates only; newline-delimited logs still reach the reporter without that throttle.

[release]: https://github.com/bombshell-dev/clack/tree/50c8ea04ac165df77a874af54ec8ff0cdc135453
[spinner-options]: https://github.com/bombshell-dev/clack/blob/50c8ea04ac165df77a874af54ec8ff0cdc135453/packages/prompts/src/spinner.ts#L15-L61
[spinner-render]: https://github.com/bombshell-dev/clack/blob/50c8ea04ac165df77a874af54ec8ff0cdc135453/packages/prompts/src/spinner.ts#L107-L185
[spinner-end]: https://github.com/bombshell-dev/clack/blob/50c8ea04ac165df77a874af54ec8ff0cdc135453/packages/prompts/src/spinner.ts#L187-L238
[log-clear]: https://github.com/bombshell-dev/clack/blob/50c8ea04ac165df77a874af54ec8ff0cdc135453/packages/prompts/src/task-log.ts#L39-L107
[log-update]: https://github.com/bombshell-dev/clack/blob/50c8ea04ac165df77a874af54ec8ff0cdc135453/packages/prompts/src/task-log.ts#L108-L183
[log-end]: https://github.com/bombshell-dev/clack/blob/50c8ea04ac165df77a874af54ec8ff0cdc135453/packages/prompts/src/task-log.ts#L185-L237
[prompt]: https://github.com/bombshell-dev/clack/blob/50c8ea04ac165df77a874af54ec8ff0cdc135453/packages/core/src/prompts/prompt.ts#L301-L368
[settings]: https://github.com/bombshell-dev/clack/blob/50c8ea04ac165df77a874af54ec8ff0cdc135453/packages/core/src/utils/settings.ts#L185-L198
[sync]: https://github.com/contour-terminal/vt-extensions/blob/master/synchronized-output.md

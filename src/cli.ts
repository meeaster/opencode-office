// The `office` command: initialize, sync, check and run an office. See README.md.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { officeInstructions } from "../plugins/office/instructions.ts";
import { deploy } from "./commands/apps.ts";
import { check } from "./commands/check.ts";
import { down, up } from "./commands/compose.ts";
import { init } from "./commands/init.ts";
import { sync } from "./commands/sync.ts";
import { upgradeTools } from "./commands/upgrade.ts";
import { catchUp, runJob, wrappedCrontab } from "./cron/container.ts";
import { currentOffice, findOffice, OfficeError } from "./office.ts";
import { version } from "./tool.ts";

const usage = `usage: office <command> [--office <dir>]

  init <dir> [--name <name>]   create an office from the template, with one example desk
  sync [--references]          clone and update, refresh the tool's plugins, scaffold missing
                               desks, copy and link skills
  check                        report drift from office.yaml and the tool, and the running
                               containers' state
  instructions [folder]        print the office guidance a session started in <folder> gets
  up | down                    start or stop this office's containers
  apps deploy                  deploy every Executor app in the office from its files
  upgrade-tools                bump exact pins in the office's mise.toml files and commit them
  cron crontab | catch-up | run <command>
                               the container's cron runner: print the wrapped crontab, run
                               jobs missed since their last success, or run one job and stamp it

  --version                    print the version and the commit this office was built from

Commands other than init act on the office in the current folder or above it, or --office.`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    office: { type: "string" },
    name: { type: "string" },
    references: { type: "boolean" },
    version: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

async function main(): Promise<void> {
  const [command, ...rest] = positionals;

  if (flags.version) {
    console.log(version());

    return;
  }

  if (flags.help || command === undefined) {
    console.log(usage);

    return;
  }

  if (command === "init") {
    if (rest[0] === undefined) throw new OfficeError("usage: office init <dir> [--name <name>]");

    const { dir, changes } = init(rest[0], flags.name);

    for (const line of changes) console.log(line);

    console.log(`created the office in ${dir}`);
  } else if (command === "instructions") {
    // The same code the office plugin runs; `office check` reports an office whose copy differs.
    const text = officeInstructions(resolve(rest[0] ?? flags.office ?? process.cwd()));

    if (text !== "") console.log(text);
  } else if (command === "sync") {
    const changes = sync(currentOffice(flags), { referencesOnly: flags.references === true });

    for (const line of changes) console.log(line);

    if (changes.length === 0) console.log("already in sync");

    if (changes.some((line) => line.startsWith("FAILED"))) process.exitCode = 1;
  } else if (command === "check") {
    if (!(await check(currentOffice(flags)))) process.exitCode = 1;
  } else if (command === "up") {
    await up(currentOffice(flags));
  } else if (command === "down") {
    down(currentOffice(flags));
  } else if (command === "upgrade-tools") {
    if (!(await upgradeTools(currentOffice(flags)))) process.exitCode = 1;
  } else if (command === "cron" && rest[0] !== undefined) {
    const dir = findOffice(flags.office ?? process.cwd());
    const crontab = join(dir, "cron/crontab");
    const text = existsSync(crontab) ? readFileSync(crontab, "utf8") : "";

    if (rest[0] === "crontab") console.log(wrappedCrontab(text));
    else if (rest[0] === "catch-up") catchUp(dir, text);
    else if (rest[0] === "run" && rest[1] !== undefined) process.exitCode = runJob(dir, rest.slice(1).join(" "));
    else throw new OfficeError("usage: office cron crontab | catch-up | run <command>");
  } else if (command === "apps" && rest[0] === "deploy") {
    await deploy(currentOffice(flags));
  } else {
    console.error(usage);
    process.exitCode = 2;
  }
}

try {
  await main();
} catch (error) {
  if (!(error instanceof OfficeError)) throw error;

  console.error(`office: ${error.message}`);
  process.exitCode = 1;
}

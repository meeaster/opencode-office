// The `office` command: initialize, sync, check and run an office. See README.md.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import * as v from "valibot";

import { officeInstructions } from "../packages/office/plugin/instructions.ts";
import { deploy } from "./commands/apps.ts";
import { check } from "./commands/check.ts";
import { down, up } from "./commands/compose.ts";
import { containerEnvText } from "./commands/env.ts";
import { credentials } from "./commands/executor.ts";
import { guiDev } from "./commands/gui.ts";
import { init } from "./commands/init.ts";
import { pair } from "./commands/pair.ts";
import { pin } from "./commands/pin.ts";
import { setup } from "./commands/setup.ts";
import { runInContainer } from "./commands/shell.ts";
import { sync } from "./commands/sync.ts";
import { update } from "./commands/update.ts";
import { upgradeTools } from "./commands/upgrade.ts";
import { catchUp, runJob, wrappedCrontab } from "./cron/container.ts";
import { migrateHome } from "./home-migration.ts";
import { releaseMachine } from "./machine.ts";
import { currentOffice, findOffice, type Office, OfficeError } from "./office.ts";
import { age } from "./schema.ts";
import { writeContainerWrappers } from "./sfw.ts";
import { version } from "./tool.ts";

const usage = `usage: office <command> [--office <dir>]

  init <dir> [--name <name>]   create an office from the template, with one example desk
  setup [--owner-email <email>] [--generate-age-key] [--install-deps] [--manage-machine]
                               guide resumable onboarding (explicit consent to create a host identity)
                               --install-deps authorizes host mise/SOPS/age (and gh) installs and
                               updates, using exact stable releases at least 3d old. office.yaml's
                               git block declares the commit identity and GitHub (credentials: gh).
                               --manage-machine lets a host-mode office link machine.toml and its
                               packages' tools into mise's global conf.d, as interactive setup asks
  executor credentials [--password-only]
                               deliberately reveal the stored encrypted owner login, even offline
  sync [--references | --release-machine]
                               clone and update, scaffold missing desks, copy and link library
                               skills, install, restore and link packages, link a host-mode
                               office's tools into mise's global conf.d, install panels on the
                               desktop app's machine, migrate old layouts. --release-machine only
                               removes every file the office wrote on this machine, and its consent
  check                        report drift from office.yaml and the tool, the running
                               containers and opted-in managed OpenCode
  instructions [folder]        print the office guidance a session started in <folder> gets
  up [--upgrade] [--refresh] | down
                               start or stop this office's containers. up runs the versions it
                               last applied; --upgrade applies office.yaml's newer ones;
                               --refresh rebuilds the opencode image with current Debian
                               packages, which a weekly timer runs in container mode.
                               With managed host OpenCode, up starts it, --upgrade queues a
                               restart or takeover, and down stops it
  shell                        open a shell in the running opencode container, in the folder
                               matching this one
  exec -- <command...>         run one command there the same way, with its stdin and exit status
  pin                          write office.lock for the versions office.yaml pins
  pair [--origin <url>]        print a one-time link that connects the OpenCode app or a browser
  apps deploy                  deploy every Executor app in the office from its files
  gui dev <package>            install a local package's panel on the desktop app's machine each
                               time its build writes the bundle
  upgrade-tools                bump exact pins in mise.toml files, machine.toml, .office/mise/
                               and office.yaml's versions, and commit them
  update [--check] [--minimum-release-age <age> | --version <release>]
                               replace this office executable with the newest release at least
                               1d old (or <age>), or exactly <release>; --check only reports.
                               Offices pick it up with office sync and office up; it never
                               changes office.yaml's versions
  cron crontab | catch-up | run <command>
                               the container's cron runner: print the wrapped crontab, run
                               jobs missed since their last success, or run one job and stamp it
  migrate-home                 the container's start: move sessions and logins stored under
                               /home/assistant, the old home, to this home
  env --container              print the opencode container's environment file: the Socket
                               Firewall wrappers on PATH and package managers' release ages
  sfw-wrappers                 the image's build: write the Socket Firewall wrappers into
                               /usr/local/lib/office/sfw

  --version                    print the version and the commit this office was built from

Commands other than init and update act on the office in the current folder or above it, or
--office.`;

const updateUsage = "usage: office update [--check] [--minimum-release-age <age> | --version <release>]";

/** `office update`'s own options: its --version names a release, unlike the global --version. */
async function updateCommand(args: string[]): Promise<void> {
  let flags;

  try {
    ({ values: flags } = parseArgs({
      args,
      options: { check: { type: "boolean" }, "minimum-release-age": { type: "string" }, version: { type: "string" }, help: { type: "boolean", short: "h" } },
    }));
  } catch (error) {
    throw new OfficeError(`${error instanceof Error ? error.message : String(error)}\n${updateUsage}`);
  }

  if (flags.help) {
    console.log(updateUsage);

    return;
  }

  const minimumAge = flags["minimum-release-age"] ?? "1d";

  if (flags.version !== undefined && flags["minimum-release-age"] !== undefined) {
    throw new OfficeError(`--version installs that exact release, whatever its age, so it takes no --minimum-release-age\n${updateUsage}`);
  }

  if (!v.is(age, minimumAge)) throw new OfficeError(`--minimum-release-age must be an age such as 36h, 1d or 2w, not ${minimumAge}`);

  await update({ check: flags.check === true, age: minimumAge, version: flags.version });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === "update") {
    await updateCommand(args.slice(1));

    return;
  }

  const { values: flags, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      office: { type: "string" },
      name: { type: "string" },
      "owner-email": { type: "string" },
      "generate-age-key": { type: "boolean" },
      "install-deps": { type: "boolean" },
      "manage-machine": { type: "boolean" },
      "release-machine": { type: "boolean" },
      "password-only": { type: "boolean" },
      references: { type: "boolean" },
      upgrade: { type: "boolean" },
      refresh: { type: "boolean" },
      container: { type: "boolean" },
      origin: { type: "string" },
      version: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

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

    const { dir, changes } = await init(rest[0], flags.name);

    for (const line of changes) console.log(line);

    console.log(`created the office in ${dir}`);
  } else if (command === "instructions") {
    // The same code the office package's plugin runs; `office check` reports a copy that differs.
    const text = officeInstructions(resolve(rest[0] ?? flags.office ?? process.cwd()));

    if (text !== "") console.log(text);
  } else if (command === "sync") {
    if (flags["release-machine"] && flags.references) throw new OfficeError("usage: office sync [--references | --release-machine]");

    const changes = flags["release-machine"] ? releaseMachine(currentOffice(flags)) : await sync(currentOffice(flags), { referencesOnly: flags.references === true });

    for (const line of changes) console.log(line);

    if (changes.length === 0) console.log("already in sync");

    if (changes.some((line) => line.startsWith("FAILED"))) process.exitCode = 1;
  } else if (command === "check") {
    if (!(await check(currentOffice(flags)))) process.exitCode = 1;
  } else if (command === "up") {
    await up(currentOffice(flags), { upgrade: flags.upgrade === true, refresh: flags.refresh === true });
  } else if (command === "setup") {
    await setup(currentOffice(flags), { ownerEmail: flags["owner-email"], generateAgeKey: flags["generate-age-key"] === true, installDeps: flags["install-deps"] === true, manageMachine: flags["manage-machine"] === true });
  } else if (command === "shell") {
    if (rest.length > 0) throw new OfficeError("usage: office shell (to run a command: office exec -- <command...>)");

    process.exitCode = runInContainer(currentOffice(flags), undefined);
  } else if (command === "exec") {
    if (rest.length === 0) throw new OfficeError("usage: office exec -- <command...>");

    process.exitCode = runInContainer(currentOffice(flags), rest);
  } else if (command === "executor" && rest[0] === "credentials") {
    credentials(currentOffice(flags), flags["password-only"] === true);
  } else if (command === "pin") {
    for (const line of await pin(currentOffice(flags))) console.log(line);
  } else if (command === "pair") {
    console.log(await pair(currentOffice(flags), flags.origin));
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
  } else if (command === "env" && flags.container === true) {
    process.stdout.write(containerEnvText(containerOffice(flags)));
  } else if (command === "sfw-wrappers") {
    for (const path of writeContainerWrappers()) console.log(`office: wrote ${path}`);
  } else if (command === "migrate-home") {
    for (const line of migrateHome(homedir())) console.log(`office: ${line}`);
  } else if (command === "apps" && rest[0] === "deploy") {
    await deploy(currentOffice(flags));
  } else if (command === "gui" && rest[0] === "dev") {
    if (rest[1] === undefined) throw new OfficeError("usage: office gui dev <package>");

    await guiDev(currentOffice(flags), rest[1]);
  } else {
    console.error(usage);
    process.exitCode = 2;
  }
}

/**
 * The office the container runs, for its environment file. At image build there is none, and an
 * office.yaml that doesn't read must not keep the container from starting, so both get the defaults.
 */
function containerOffice(flags: { office?: string }): Office | undefined {
  try {
    return currentOffice(flags);
  } catch (error) {
    if (flags.office !== undefined) console.error(`office: ${error instanceof Error ? error.message : String(error)}; the container's environment takes the defaults, with the Socket Firewall on`);

    return undefined;
  }
}

try {
  await main();
} catch (error) {
  if (!(error instanceof OfficeError)) throw error;

  console.error(`office: ${error.message}`);
  process.exitCode = 1;
}

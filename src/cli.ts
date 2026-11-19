// The `office` command: initialize, sync, check and run an office. See README.md.
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import * as v from "valibot";

import { officeInstructions } from "../packages/office/plugin/instructions.ts";
import { agentUpdateJob, updateAgentClis } from "./commands/agent-cli-update.ts";
import { adopt, deploy } from "./commands/apps.ts";
import { check } from "./commands/check.ts";
import { down, up } from "./commands/compose.ts";
import { contextReport } from "./commands/context.ts";
import { containerEnvText } from "./commands/env.ts";
import { credentials } from "./commands/executor.ts";
import { guiDev } from "./commands/gui.ts";
import { init, nextSteps } from "./commands/init.ts";
import { pair } from "./commands/pair.ts";
import { pin } from "./commands/pin.ts";
import { updatePackages, updateSkills } from "./commands/pins.ts";
import { setup } from "./commands/setup.ts";
import { sessionInstructions } from "./commands/session-instructions.ts";
import { runInContainer } from "./commands/shell.ts";
import { summarize, sync } from "./commands/sync.ts";
import { update } from "./commands/update.ts";
import { upgradeTools } from "./commands/upgrade.ts";
import { catchUp, runContainerJob, supercronicInput } from "./cron/container.ts";
import { executeJob, requireJobs } from "./cron/jobs.ts";
import { migrateHome } from "./home-migration.ts";
import { releaseMachine } from "./machine.ts";
import { currentOffice, type Office, OfficeError } from "./office.ts";
import { packageSecret } from "./package-services.ts";
import { decrypt } from "./secrets.ts";
import { onTerminal, reported, type Reporter, type Stage } from "./report/index.ts";
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
                               packages' tools into mise's global conf.d, as interactive setup asks;
                               it never covers the system packages the office declares, which setup
                               installs through mise only on a yes in a terminal
  executor credentials [--password-only]
                               deliberately reveal the stored encrypted owner login, even offline
  secrets get <package> <key>  write one declared, generated package secret to stdout
  secrets decrypt <file>       decrypt an office-relative SOPS JSON/YAML file to stdout as JSON
  sync [--packages | --references | --release-machine]
                               clone and update, scaffold missing desks, copy and link library
                               skills, install, restore and link packages, link a host-mode
                               office's tools into mise's global conf.d, install panels on the
                               desktop app's machine, migrate old layouts. --release-machine only
                               removes every file the office wrote on this machine, and its consent.
                               --packages applies packages at their declared pins without refreshing
                               desk repos, references or separately declared plugin clones
  skills update                move each skills.copied group with a track to the newest commit of
                               its branch, or of its highest stable SemVer tag matching a pattern
                               such as v2.*; recopy the whole group and record the commit as its ref.
                               A group missing a skill, or with edits the copy would lose, stays put
  packages update              likewise for packages from other repositories with a track, then
                               apply them as sync does. Neither command syncs anything else, and
                               office sync applies pins without moving them
  check                        report drift from office.yaml and the tool, the running
                               containers and opted-in managed OpenCode
  refresh [--verbose]          update tracked package and skill pins, run a full sync, start
                               services with ordinary up, then check office health
  instructions [folder]        print the office guidance a session started in <folder> gets
  instructions --session <id>  print each stored instruction entry from a running OpenCode server
  context --model <provider/model#variant>
                               measure the tokens the office adds to the first request of a
                               session in the current folder, against an empty folder, on the
                               running host-mode OpenCode server. Repeat --model to compare models
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
  apps deploy                  install declared catalog apps and deploy local Executor app sources
  apps adopt <catalog-id>      copy an installed Executor app's source into executor-apps/<catalog-id>
  gui dev <package>            install a local package's panel on the desktop app's machine each
                               time its build writes the bundle
  upgrade-tools [--apply]      bump exact pins in mise.toml files, machine.toml, .office/mise/
                               and office.yaml's versions, and commit them; --apply then runs
                               up --upgrade, even when the pins were already current
  update [--check] [--minimum-release-age <age> | --version <release>]
                               replace this office executable with the newest eligible release
                               (minimum age: 0d by default), or exactly <release>; --check only reports.
                               Offices pick it up with office sync and office up; it never
                               changes office.yaml's versions
  cron list | run <job-id>      list applicable YAML jobs or run one by its qualified ID
  cron supercronic | catch-up   container internals: print generated supercronic input or run
                               jobs missed since their last success
  migrate-home                 the container's start: move sessions and logins stored under
                               /home/assistant, the old home, to this home
  env --container              print the opencode container's environment file: the Socket
                               Firewall wrappers on PATH and package managers' release ages
  sfw-wrappers                 the image's build: write the Socket Firewall wrappers into
                               /usr/local/lib/office/sfw

  --version                    print the version and the commit this office was built from
  --verbose                    show all check results in a terminal; with plain progress, show
                               every subprocess line, not only a failed command's last lines

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

  const minimumAge = flags["minimum-release-age"] ?? "0d";

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
      session: { type: "string" },
      model: { type: "string", multiple: true },
      name: { type: "string" },
      "owner-email": { type: "string" },
      "generate-age-key": { type: "boolean" },
      "install-deps": { type: "boolean" },
      "manage-machine": { type: "boolean" },
      "release-machine": { type: "boolean" },
      "password-only": { type: "boolean" },
      references: { type: "boolean" },
      packages: { type: "boolean" },
      upgrade: { type: "boolean" },
      apply: { type: "boolean" },
      refresh: { type: "boolean" },
      container: { type: "boolean" },
      origin: { type: "string" },
      version: { type: "boolean" },
      verbose: { type: "boolean" },
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

  if (flags.session !== undefined && command !== "instructions") throw new OfficeError("--session is an option for office instructions");

  if (flags.packages && command !== "sync") throw new OfficeError("--packages is an option for office sync");

  if (flags.apply && command !== "upgrade-tools") throw new OfficeError("--apply is an option for office upgrade-tools");

  if (flags.model !== undefined && command !== "context") throw new OfficeError("--model is an option for office context");

  if (command === "init") {
    if (rest[0] === undefined) throw new OfficeError("usage: office init <dir> [--name <name>]");

    const { dir, changes } = await init(rest[0], flags.name);

    for (const line of changes) console.log(line);

    console.log(`created the office in ${dir}`);
    console.log(nextSteps(dir));
  } else if (command === "instructions") {
    if (rest.length > (flags.session === undefined ? 1 : 0)) throw new OfficeError("usage: office instructions [folder] | office instructions --session <id>");

    const text = flags.session === undefined
      ? officeInstructions(resolve(rest[0] ?? flags.office ?? process.cwd()))
      : await sessionInstructions(currentOffice(flags), flags.session);

    if (text !== "") console.log(text);
  } else if (command === "context") {
    if (rest.length !== 0 || flags.model === undefined) throw new OfficeError("usage: office context --model <provider/model#variant>");

    const office = currentOffice(flags);
    const report = await contextReport(office, process.cwd(), flags.model);

    console.log(report.text);

    if (report.failed) process.exitCode = 1;
  } else if (command === "sync") {
    if ([flags["release-machine"], flags.references, flags.packages].filter(Boolean).length > 1) throw new OfficeError("usage: office sync [--packages | --references | --release-machine]");

    if (flags["release-machine"]) {
      const changes = releaseMachine(currentOffice(flags));

      for (const line of changes) console.log(line);

      if (changes.length === 0) console.log("already in sync");

      if (changes.some((line) => line.startsWith("FAILED"))) process.exitCode = 1;

      return;
    }

    const office = currentOffice(flags);
    const verbose = flags.verbose === true;

    await reported("sync", officeContext(office), async (reporter) => {
      const stage = flags.packages ? reporter.stage("Packages", { key: "packages" }) : reporter.stage("Repositories and packages", { key: "repos" });
      const changes = await sync(office, { scope: flags.packages ? "packages" : flags.references ? "references" : "all", stage, verbose });
      finishSync(stage, changes);
      reporter.finish([]);
    }, { verbose });
  } else if ((command === "skills" || command === "packages") && rest[0] === "update" && rest.length === 1) {
    const office = currentOffice(flags);

    await reported(`${command} update`, officeContext(office), async (reporter) => {
      const stage = reporter.stage(command === "skills" ? "Copied skill groups" : "Remote packages", { key: command });

      if (command === "skills") await updateSkills(office, stage);
      else await updatePackages(office, stage);

      reporter.finish([]);
    }, { verbose: flags.verbose === true });
  } else if (command === "refresh") {
    if (rest.length || Object.keys(flags).some(key => !["office", "verbose"].includes(key))) throw new OfficeError("usage: office refresh [--office <dir>] [--verbose]");
    const verbose = flags.verbose === true;
    const office = currentOffice(flags);

    await reported("refresh", officeContext(office), async reporter => {
      await updatePackages(office, reporter.stage("Remote packages", { key: "packages" }), { apply: false });
      await updateSkills(currentOffice(flags), reporter.stage("Copied skill groups", { key: "skills" }));
      const stage = reporter.stage("Repositories and packages", { key: "sync" });

      finishSync(stage, await sync(currentOffice(flags), { stage, verbose }));
      const synced = currentOffice(flags);
      const services = reporter.stage("Services", { key: "services" });

      services.done(await up(synced));
      await checkStage(synced, reporter, verbose);
      reporter.finish([]);
    }, { verbose });
  } else if (command === "check") {
    const office = currentOffice(flags);
    const verbose = flags.verbose === true;

    if (onTerminal()) {
      await reported("check", officeContext(office), async reporter => {
        await checkStage(office, reporter, verbose);
        reporter.finish([]);
      }, { verbose });
    } else if (!(await check(office))) process.exitCode = 1;
  } else if (command === "up" || command === "upgrade-tools") {
    if (command === "upgrade-tools") {
      if (!(await upgradeTools(currentOffice(flags)))) {
        process.exitCode = 1;

        return;
      }

      if (!flags.apply) return;
    }

    // Read the office after bumping so up sees the newly written pins.
    const office = currentOffice(flags);

    await reported("up", officeContext(office), async (reporter) => {
      const stage = reporter.stage("Services", { key: "services" });

      stage.done(await up(office, { upgrade: command === "upgrade-tools" || flags.upgrade === true, refresh: command === "up" && flags.refresh === true }));
      reporter.finish([]);
    }, { verbose: flags.verbose === true });
  } else if (command === "setup") {
    const office = currentOffice(flags);
    const options = { ownerEmail: flags["owner-email"], generateAgeKey: flags["generate-age-key"] === true, installDeps: flags["install-deps"] === true, manageMachine: flags["manage-machine"] === true, verbose: flags.verbose === true };

    await reported("setup", officeContext(office), (reporter) => setup(office, options, reporter), { verbose: flags.verbose === true });
  } else if (command === "shell") {
    if (rest.length > 0) throw new OfficeError("usage: office shell (to run a command: office exec -- <command...>)");

    process.exitCode = runInContainer(currentOffice(flags), undefined);
  } else if (command === "exec") {
    if (rest.length === 0) throw new OfficeError("usage: office exec -- <command...>");

    process.exitCode = runInContainer(currentOffice(flags), rest);
  } else if (command === "executor" && rest[0] === "credentials") {
    credentials(currentOffice(flags), flags["password-only"] === true);
  } else if (command === "secrets") {
    const [action, target, key] = rest;

    if (action === "get" && rest.length === 3) process.stdout.write(packageSecret(currentOffice(flags), target, key));
    else if (action === "decrypt" && rest.length === 2) process.stdout.write(decrypt(currentOffice(flags), target));
    else throw new OfficeError("usage: office secrets get <package> <key> | office secrets decrypt <file>");
  } else if (command === "pin") {
    for (const line of await pin(currentOffice(flags))) console.log(line);
  } else if (command === "pair") {
    console.log(await pair(currentOffice(flags), flags.origin));
  } else if (command === "down") {
    down(currentOffice(flags));
  } else if (command === "host-agent-cli-update" && rest.length === 0) {
    const office = currentOffice(flags);

    if (!requireJobs(office).some((job) => job.id === agentUpdateJob)) throw new OfficeError(`cron ${agentUpdateJob}: not enabled for this office`);

    process.exitCode = await updateAgentClis(office);
  } else if (command === "cron") {
    const office = currentOffice(flags);
    const jobs = requireJobs(office);
    const [action, id] = rest;

    if (action === "run" && id !== undefined && rest.length === 2) {
      const job = jobs.find((candidate) => candidate.id === id);

      if (job === undefined) throw new OfficeError(`cron ${id}: not enabled for this office; see office cron list`);

      process.exitCode = office.opencode.mode === "container" ? await runContainerJob(office, job) : await executeJob(office, job);
    } else if (action === "list" && rest.length === 1) {
      for (const job of jobs) console.log(job.id);
    } else if (office.opencode.mode === "container" && rest.length === 1 && action === "supercronic") {
      if (jobs.length > 0) console.log(supercronicInput(jobs));
    } else if (office.opencode.mode === "container" && rest.length === 1 && action === "catch-up") {
      await catchUp(office, jobs);
    } else {
      throw new OfficeError("usage: office cron list | run <job-id>");
    }
  } else if (command === "env" && flags.container === true) {
    process.stdout.write(containerEnvText(containerOffice(flags)));
  } else if (command === "sfw-wrappers") {
    for (const path of writeContainerWrappers()) console.log(`office: wrote ${path}`);
  } else if (command === "migrate-home") {
    for (const line of migrateHome(homedir())) console.log(`office: ${line}`);
  } else if (command === "apps" && rest[0] === "adopt" && rest.length === 2) {
    await adopt(currentOffice(flags), rest[1]);
  } else if (command === "apps" && rest[0] === "deploy" && rest.length === 1) {
    await deploy(currentOffice(flags));
  } else if (command === "gui" && rest[0] === "dev") {
    if (rest[1] === undefined) throw new OfficeError("usage: office gui dev <package>");

    await guiDev(currentOffice(flags), rest[1]);
  } else {
    console.error(usage);
    process.exitCode = 2;
  }
}

function finishSync(stage: Stage, changes: string[]) {
  const summary = summarize(changes);

  if (changes.some(line => line.startsWith("FAILED"))) {
    stage.fail(summary);

    throw new OfficeError("Fix the sync failures above and run the command again");
  }

  stage.done(summary);
}

async function checkStage(office: Office, reporter: Reporter, verbose: boolean) {
  const stage = reporter.stage("Health check", { key: "check" });
  const ok = await check(office, reporter.interactive ? stage : undefined, verbose);

  if (!reporter.interactive) {
    if (ok) stage.done("office check passed");
    else stage.fail("office check found problems");
  }

  if (!ok) throw new OfficeError("Fix the reported checks and run office check again");
}

/** What progress commands show first: the office, its mode and its folder. */
function officeContext(office: Office): string {
  const home = homedir();
  const dir = office.dir === home || office.dir.startsWith(`${home}/`) ? `~${office.dir.slice(home.length)}` : office.dir;

  return `office ${office.name} · ${office.opencode.mode} mode · ${dir}`;
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

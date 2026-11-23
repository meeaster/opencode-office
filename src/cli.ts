// The `office` command: initialize, sync, check and run an office. See README.md.
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { commandHelp, dispatchCommand, type Reader } from "./direct-commands.ts";
import { packageRoute, reservedWord } from "./command-table.ts";

import * as v from "valibot";

import { officeInstructions } from "../packages/office/plugin/instructions.ts";
import { inspect } from "../standard/opencode/inspect.ts";
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
import { finishSetup, setup } from "./commands/setup.ts";
import { sessionInstructions } from "./commands/session-instructions.ts";
import { runInContainer } from "./commands/shell.ts";
import { summarize, sync } from "./commands/sync.ts";
import { update } from "./commands/update.ts";
import { upgradeTools } from "./commands/upgrade.ts";
import { cronCommand } from "../standard/cron/command.ts";
import { namedJob } from "../standard/cron/discovery.ts";
import { releaseMachine, serviceEnvironment } from "./machine.ts";
import { currentOffice, findOffice, type Office, OfficeError } from "./office.ts";
import { type Gathered, gatherPackages } from "./gather.ts";
import { ensureDiscovery, hasPublishedSet } from "./package-generation.ts";
import { bindReader, evaluateAdmission, restoreCallerEnv, runReader } from "./package-operation.ts";
import { packageSecret } from "./package-services.ts";
import { decrypt } from "./secrets.ts";
import { onTerminal, reported, type Reporter, type Stage } from "./report/index.ts";
import { age } from "./schema.ts";
import { writeContainerWrappers } from "./sfw.ts";
import { requireKnownLockKeys } from "./versions.ts";
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
                               desktop app's machine. --release-machine only removes every file
                               the office wrote on this machine, and its consent.
                               --packages applies packages at their declared pins without refreshing
                                desk repos, references or separately declared plugin clones.
                                Each package's package.json names its definition (office.definition)
  skills update                move each skills.copied group with a track to the newest commit of
                               its branch, or of its highest stable SemVer tag matching a pattern
                               such as v2.*; recopy the whole group and record the commit as its ref.
                               A group missing a skill, or with edits the copy would lose, stays put
  packages update              likewise for packages from other repositories with a track, move
                               the office.lock commit of each untracked tag or branch ref to where
                               it points now, then apply them as sync does. Neither command syncs
                               anything else, and office sync applies pins without moving them
  check                        report drift from office.yaml and the tool, the running
                               containers and opted-in managed OpenCode
  refresh [--verbose]          update tracked package and skill pins and the office.lock commits
                               of untracked package refs, run a full sync, start services with
                               ordinary up, then check office health
  instructions [folder]        print the office guidance a session started in <folder> gets
  instructions --session <id>  print each stored instruction entry from a running OpenCode server
  opencode inspect [folder]    list office-local native config and plugin sources on disk (offline)
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
  pin                          write office.lock's runtime pins for the versions office.yaml pins
  pair [--origin <url>]        print a one-time link that connects the OpenCode app or a browser
  apps deploy [--verbose]      install missing catalog apps and deploy changed local Executor apps
  apps adopt <catalog-id>      copy an installed Executor app's source into executor-apps/<catalog-id>
  gui dev <package>            install a local package's panel on the desktop app's machine each
                               time its build writes the bundle
  upgrade-tools [--commit] [--apply]
                               bump exact pins in mise.toml files, machine.toml,
                               machine.packages.toml and office.yaml's tools to releases at
                               least tools.minimum_release_age old (or a runtime's own).
                               --commit commits the changes; --apply runs up --upgrade, even when the pins
                               were already current
  update [--check] [--minimum-release-age <age> | --version <release>]
                               replace this office executable with the newest eligible release
                               (minimum age: 0d by default), or exactly <release>; --check only reports.
                               Offices pick it up with office sync and office up; it never
                               changes office.yaml's tools
  cron list | run <job-id>      list applicable jobs or run one by its qualified ID
  cron supercronic | catch-up   container internals: print generated supercronic input or run
                               jobs missed since their last success
  env --container              print the opencode container's environment file: the Socket
                                Firewall wrappers on PATH and package managers' and mise's release ages
  env host-service <name> --office <absolute-dir>
                               unit startup: print the recorded installer's verified environment,
                               or nothing if it does not own the machine
  sfw-wrappers                 the image's build: write the Socket Firewall wrappers into
                               /usr/local/lib/office/sfw

  --version                    print the version and the commit this office was built from
  --verbose                    show all check results in a terminal; with plain progress, show
                               every subprocess line, not only a failed command's last lines

Commands other than init and update act on the office in the current folder or above it, or
--office.`;

const updateUsage = "usage: office update [--check] [--minimum-release-age <age> | --version <release>]";
const inspectUsage = "usage: office opencode inspect [folder] [--office <dir>]";

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

function commandArgs(args: string[]) {
  return parseArgs({
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
      commit: { type: "boolean" },
      refresh: { type: "boolean" },
      container: { type: "boolean" },
      origin: { type: "string" },
      version: { type: "boolean" },
      verbose: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
}

/** Says no command matched `words`, and when the office has no published package set, that sync publishes one. */
function unknownCommand(dir: string | undefined, words: readonly string[], failures: readonly string[]) {
  const unpublished = dir !== undefined && words[0] !== undefined && !reservedWord(words[0]) && !hasPublishedSet(dir);
  const failed = failures.length ? `; packages that failed to load, one of which may provide it: ${failures.join("; ")}` : "";

  console.error(`Unknown command or options: ${words.join(" ")}; see office --help${unpublished ? ". Package commands load once office sync publishes a package set: run office sync" : ""}${failed}`);
  process.exitCode = 2;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const reader = args[0] === "--package-reader";
  const admission = args[0] === "--package-admission";

  // An evaluator gives the processes it starts the caller's BUN_OPTIONS, not its own.
  if (reader || admission) restoreCallerEnv();

  if (admission) return evaluateAdmission(args[1]);
  // Only a reader, bound to a published package set, loads packages for commands and help.
  let bound: Reader | undefined;

  if (reader) {
    const [, dir, name] = args.splice(0, 3);
    bindReader(dir, name);
    bound = { dir };

    if (args[0] === "--finish-setup" && args[1] === dir) {
      const office = currentOffice({ office: dir });

      return reported("setup", officeContext(office), reporter => finishSetup(office, args[2] === "shell", args[3] || undefined, reporter), { verbose: args[4] === "verbose" });
    }

    if (args[0] === "--finish-refresh" && args[1] === dir) {
      const office = currentOffice({ office: dir });
      const verbose = args[2] === "verbose";

      return reported("refresh", officeContext(office), async reporter => {
        // One gathering for every step of the finishing reader; office up itself needs none.
        const gathered = await gatherPackages(office, { machine: true });
        const services = reporter.stage("Services", { key: "services" });
        services.done(await up(office, { inventory: gathered.inventory }));
        await checkStage(office, reporter, verbose, gathered);
        reporter.finish([]);
      }, { verbose });
    }
  }

  if (args[0] === "update") {
    await updateCommand(args.slice(1));

    return;
  }

  // A package command gets its words as typed: they never reach the CLI's own option parser.
  const route = packageRoute(args);

  if (route) {
    if (bound) {
      const dispatched = await dispatchCommand(bound, route.words);

      if (!dispatched.found) unknownCommand(bound.dir, route.words, dispatched.failures);

      return;
    }

    let found: string | undefined;

    try { found = findOffice(route.office ?? process.cwd()); } catch { /* not in an office: no package command can run */ }

    if (found) {
      ensureDiscovery(found);
      const status = await runReader(found, args);

      if (status !== undefined) {
        process.exitCode = status;

        return;
      }
    }

    unknownCommand(found, route.words, []);

    return;
  }

  let parsed;

  try {
    parsed = commandArgs(args);
  } catch (error) {
    if (args.includes("opencode") && args.includes("inspect")) throw new OfficeError(inspectUsage);
    throw error;
  }

  const { values: flags, positionals } = parsed;
  const [command, ...rest] = positionals;

  // The office this first process found; unset in a reader.
  let dir: string | undefined;

  if (!reader && !flags.version && command !== "init") {
    try { dir = findOffice(flags.office ?? process.cwd()); } catch { /* bootstrap handles offices not found */ }

    // A sync that publishes refuses a lock it can't read whole before it repairs anything, discovery links too.
    if (dir && command === "sync" && !flags.references && !flags["release-machine"]) requireKnownLockKeys(dir);

    if (dir) ensureDiscovery(dir);

    // Help and bare `office` list package commands, so they load packages in the reader too.
    if (dir && (flags.help || command === undefined || !["sync", "refresh", "packages", "sfw-wrappers", "env"].includes(command))) {
      const status = await runReader(dir, args);

      if (status !== undefined) {
        process.exitCode = status;

        return;
      }
    }
  }

  if (flags.version) {
    console.log(version());

    return;
  }

  if (command === "opencode" && rest[0] === "inspect") {
    if (flags.help) {
      console.log(inspectUsage);

      return;
    }

    if (rest.length > 2 || Object.keys(flags).some(key => key !== "office")) throw new OfficeError(inspectUsage);
    console.log(inspect(resolve(flags.office ?? ".", rest[1] ?? "."), flags.office).join("\n"));

    return;
  }

  if (flags.help || command === undefined) {
    console.log(usage);
    const lines = bound ? await commandHelp(bound) : [];

    if (lines.length) console.log(lines.join("\n"));

    return;
  }

  if (flags.session !== undefined && command !== "instructions") throw new OfficeError("--session is an option for office instructions");

  if (flags.packages && command !== "sync") throw new OfficeError("--packages is an option for office sync");

  if (flags.apply && command !== "upgrade-tools") throw new OfficeError("--apply is an option for office upgrade-tools");

  if (flags.commit && command !== "upgrade-tools") throw new OfficeError("--commit is an option for office upgrade-tools");

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
      const status = await runReader(office.dir, ["--finish-refresh", office.dir, verbose ? "verbose" : ""]);

      if (status !== 0) throw new OfficeError("refresh did not complete with the published package generation");
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
    const office = currentOffice(flags);

    await reported(command, officeContext(office), async (reporter) => {
      if (command === "upgrade-tools") {
        await upgradeTools(office, reporter.stage("Tool pins", { key: "tools" }), { commit: flags.commit === true });
      }

      if (command === "up" || flags.apply) {
        const stage = reporter.stage("Services", { key: "services" });
        const updated = command === "up" ? office : currentOffice(flags);

        stage.done(await up(updated, { upgrade: command === "upgrade-tools" || flags.upgrade === true, refresh: command === "up" && flags.refresh === true }));
      }

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

    namedJob(office, agentUpdateJob);

    process.exitCode = await updateAgentClis(office);
  } else if (command === "cron") {
    await cronCommand(currentOffice(flags), rest);
  } else if (command === "env" && flags.container === true) {
    process.stdout.write(containerEnvText(containerOffice(flags)));
  } else if (command === "env" && rest[0] === "host-service") {
    const name = rest[1];

    if (rest.length !== 2 || !name || !flags.office || !isAbsolute(flags.office)) {
      throw new OfficeError("usage: office env host-service <name> --office <absolute-dir>");
    }

    process.stdout.write(serviceEnvironment({ name, dir: flags.office }));
  } else if (command === "sfw-wrappers") {
    for (const path of writeContainerWrappers()) console.log(`office: wrote ${path}`);
  } else if (command === "apps" && rest[0] === "adopt" && rest.length === 2) {
    await adopt(currentOffice(flags), rest[1]);
  } else if (command === "apps" && rest[0] === "deploy" && rest.length === 1) {
    const office = currentOffice(flags);

    await reported("apps deploy", officeContext(office), async reporter => {
      const stage = reporter.stage("Apps", { key: "apps" });

      stage.done(await deploy(office));
      reporter.finish([]);
    }, { verbose: flags.verbose === true });
  } else if (command === "gui" && rest[0] === "dev") {
    if (rest[1] === undefined) throw new OfficeError("usage: office gui dev <package>");

    await guiDev(currentOffice(flags), rest[1]);
  } else {
    // A first word of the CLI's own: a package name under it is reserved, and dispatch says so.
    const dispatched = Object.keys(flags).every(key => key === "office") && bound ? await dispatchCommand(bound, positionals) : { found: false as const, failures: [] };

    if (!dispatched.found) unknownCommand(dir, positionals, dispatched.failures);
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

async function checkStage(office: Office, reporter: Reporter, verbose: boolean, gathered?: Gathered) {
  const stage = reporter.stage("Health check", { key: "check" });
  const ok = await check(office, reporter.interactive ? stage : undefined, verbose, gathered);

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

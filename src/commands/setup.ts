import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { requireJobs } from "../../standard/cron/discovery.ts";
import { git } from "../git.ts";
import { githubStep, planGithub, unreachableSources } from "../github.ts";
import { installHook } from "../hook.ts";
import { envFilePath, sourceLine } from "../host-env.ts";
import { planServer, queueStaleRestart, restartStaleServer, staleServer } from "../host-server.ts";
import { hostTool, onboardHostTools, requireOfficeTool } from "../host-tools.ts";
import { installedPackages } from "../layout.ts";
import { claim, consentCommand, consentQuestion, grantConsent, ownedElsewhere } from "../machine.ts";
import { executorEnvFile, type Office, OfficeError, readEnvFile, updateConfig } from "../office.ts";
import { last, type NextStep, type Reporter, say, terminalAsk } from "../report/index.ts";
import { decrypt, encrypt, initializeIdentity, prepareSecrets, requireTool } from "../secrets.ts";
import { configureStartup, interactiveShell } from "../shell-startup.ts";
import { offerRestart, systemStep, verifySystems } from "../system-setup.ts";
import { deploy } from "./apps.ts";
import { check } from "./check.ts";
import { installingMise, ports, startExecutor, up } from "./compose.ts";
import { bootstrapExecutor } from "./executor.ts";
import { summarize, sync } from "./sync.ts";
import { runReader } from "../package-operation.ts";
import { checkAdoption } from "../package-generation.ts";

type SetupOptions = {
  ownerEmail?: string;
  generateAgeKey: boolean;
  installDeps?: boolean;
  manageMachine?: boolean;
  /** Plain output: print every subprocess line, and git's progress. */
  verbose?: boolean;
};

type Ask = (text: string) => Promise<string>;

/** A question setup can't go on without: on a terminal a prompt, otherwise setup stops, naming the options. */
async function question(ask: Ask | undefined, text: string): Promise<string> {
  if (ask === undefined) throw new OfficeError(`${text} Rerun interactively or supply the documented setup options; no prompt was opened`);

  return ask(text);
}

/**
 * No wizard completion marker: each run inspects files, API state and the real services. Each of
 * its stages reports through `reporter`; a stage that fails stops setup there.
 */
export async function setup(initial: Office, options: SetupOptions, reporter: Reporter): Promise<void> {
  checkAdoption(initial.dir);
  let office = initial;
  const ask = terminalAsk();

  // Tools: what setup needs on this machine, then the office's pinned tools.
  let stage = reporter.stage("Tools", { key: "tools" });

  stage.detail("checking docker, docker compose, docker buildx and git");
  requireTool("docker", ["info"]);
  requireTool("docker", ["compose", "version"]);
  requireTool("docker", ["buildx", "version"]);
  requireTool("git");

  stage.detail("checking the office's tools");
  await onboardHostTools(office, options.installDeps === true, ask, { installer: () => installingMise(office) });
  stage.done("docker, git and the office's tools");

  // Secrets: the age identity and the Executor owner secret.
  stage = reporter.stage("Secrets", { key: "secrets" });

  if (options.generateAgeKey) initializeIdentity(office);

  // Legacy offices with a token need no new secrets configuration. Bootstrap does need portable
  // owner persistence; opt in without replacing unrelated YAML or any existing source.
  const hasToken = readEnvFile(executorEnvFile(office)).EXECUTOR_TOKEN;

  if (office.secrets?.executor_owner === undefined && !hasToken) {
    if (!existsSync(join(office.dir, ".sops.yaml"))) {
      const answer = options.generateAgeKey ? "yes" : await question(ask, "Executor bootstrap needs SOPS/age. Generate a host age identity and public .sops.yaml? [yes/no]");

      if (answer !== "yes") throw new OfficeError("setup paused; configure .sops.yaml with authorized age recipients, then rerun (or use --generate-age-key to consent)");

      stage.detail("generating the age identity");
      initializeIdentity(office);
    }

    office = updateConfig(office, [[["secrets", "executor_owner"], "secrets/executor-owner.enc.json"]]);
  }

  const ownerFile = office.secrets?.executor_owner;

  if (ownerFile !== undefined && !existsSync(join(office.dir, ownerFile))) {
    stage.detail("checking this machine can encrypt and decrypt");

    // Prove both recipient encryption and this host's identity before starting any service.
    const probe = encrypt(office, ownerFile, '{"readiness":"office setup"}');

    // No temporary plaintext; SOPS decrypts the encrypted stdin directly.
    try {
      execFileSync(requireOfficeTool(office, "sops"), ["decrypt", "--input-type", "json", "--output-type", "json", "/dev/stdin"], {
        input: probe, stdio: ["pipe", "ignore", "pipe"], cwd: office.dir,
      });
    } catch {
      throw new OfficeError(`SOPS recovery is not ready for ${ownerFile}; enroll this host's public age recipient on an authorized host first`);
    }
  } else if (ownerFile !== undefined) {
    stage.detail(`decrypting ${ownerFile}`);
    decrypt(office, ownerFile);
  }

  prepareSecrets(office, { allowMissingOwner: true });
  stage.done(ownerFile === undefined ? "the office's Executor key" : `SOPS and age ready for ${ownerFile}`);

  // Git and GitHub: the commit identity, then a GitHub login only if sources need one.
  stage = reporter.stage("Git and GitHub", { key: "git" });
  // Anonymous reads of the sources, before any login: the GitHub step below asks for one only when needed.
  stage.detail("checking which sources read without a login");

  const github = await planGithub(office);

  office = await commitIdentity(office, ask);
  stage.detail("checking the GitHub login");
  office = await githubStep(office, github, ask);
  stage.done([office.git?.name === undefined ? "no commit identity" : `commits as ${office.git.name} <${office.git.email}>`, office.git?.credentials === "gh" ? "GitHub through gh" : "no GitHub login needed"].join(" · "));

  // This machine: host mode only, consent to write outside the office folder.
  let shell = false;

  if (office.opencode.mode === "host") {
    stage = reporter.stage("This machine", { key: "machine" });
    shell = await machineConsent(office, options.manageMachine === true, ask);
    const detected = interactiveShell();

    if (shell && detected) shell = await configureStartup(detected, hostTool("mise"), ask);
    stage.done(claim(office).kind === "ours" ? `managed by office ${office.name}` : "not managed by this office");
  }

  // Repositories and packages: the sources, skills and packages office.yaml declares.
  stage = reporter.stage("Repositories and packages", { key: "repos" });
  // A login alone proves nothing: read every source as sync will, before cloning starts.
  stage.detail("reading every source with this machine's git credentials");

  const unreachable = await unreachableSources(office);

  if (unreachable.length > 0) {
    throw new OfficeError(`these sources don't read on this host, so nothing was cloned:\n${unreachable.map((line) => `  - ${line}`).join("\n")}\nFix them or office.yaml, then rerun office setup`);
  }

  const changes = await sync(office, { stage, verbose: options.verbose === true });

  if (changes.some((line) => line.startsWith("FAILED"))) {
    stage.fail(summarize(changes));

    throw new OfficeError("sync failed; fix the reported source and rerun office setup");
  }

  stage.detail("installing the pre-commit hook");

  const hook = installHook(office);

  if (hook !== undefined) stage.note(hook);

  stage.done(summarize(changes));

  const status = await runReader(office.dir, ["--finish-setup", office.dir, shell ? "shell" : "", options.ownerEmail ?? "", options.verbose ? "verbose" : ""]);

  if (status !== 0) throw new OfficeError("setup did not complete with the published package generation");
}

export async function finishSetup(office: Office, shell: boolean, ownerEmail: string | undefined, reporter: Reporter) {
  const ask = terminalAsk();
  const hasToken = readEnvFile(executorEnvFile(office)).EXECUTOR_TOKEN;
  const ownerFile = office.secrets?.executor_owner;

  // System packages: before office up installs tools, some of which build against them.
  let stage = reporter.stage("System packages", { key: "system" });

  const outcome = await systemStep(office, installedPackages(office).installed, { mise: office.opencode.mode === "host" ? hostTool("mise") : "mise", ask });

  stage.done(outcome === "applied" ? "applied" : outcome === "deferred" ? "not applied" : undefined);

  // Services: Executor, then OpenCode (an image in container mode, the host server otherwise).
  stage = reporter.stage("Services", { key: "services" });

  let email = ownerEmail;

  if (!hasToken && ownerFile !== undefined && !existsSync(join(office.dir, ownerFile)) && email === undefined) {
    if (!reporter.interactive) throw new OfficeError("Executor owner email: Rerun interactively or supply the documented setup options; no prompt was opened");

    email = await reporter.ask({ kind: "text", message: "Executor owner email (it signs you in to the dashboard)", placeholder: "you@example.com", validate: (value) => (value.includes("@") ? undefined : "An email address, like you@example.com") });
  }

  if (requireJobs(office).length > 0) stage.note("Cron: applicable jobs are installed at startup. Review them with office cron list.");

  await startExecutor(office);
  await bootstrapExecutor(office, email);
  stage.done(await up(office));

  // Apps: the Executor apps the office deploys.
  stage = reporter.stage("Apps", { key: "apps" });

  const deployed = await deploy(office);

  stage.done(deployed.length === 0 ? "none to deploy" : `${deployed.length} deployed (${deployed.join(", ")})`);

  // Checks: package system checks, the OpenCode restart offer, then office check.
  stage = reporter.stage("Checks", { key: "checks" });
  stage.detail("running the packages' system checks");

  const verified = verifySystems(office, installedPackages(office).installed);

  for (const line of verified.lines) stage.note(`System check: ${line}`);

  const managed = office.opencode.mode === "host" && office.opencode.managed !== undefined;
  const plan = managed ? planServer(office) : undefined;
  const restart = plan === undefined ? undefined : await offerRestart(ask, { stale: () => staleServer(office, plan), restart: (stale) => restartStaleServer(office, plan, stale) });

  // Last, even when setup stops: from a terminal inside the server, the restart closes this terminal.
  if (restart === "queue" && plan !== undefined) {
    last(() => {
      console.log("OpenCode: restarting now in a job of its own; this terminal closes with the server. Reconnect, then run office check");
      queueStaleRestart(office, plan);
    });
  }

  // office check prints its own report; it gets the terminal as it is.
  const checked = await stage.inherit("office check", () => check(office));

  if (!verified.ok) {
    stage.fail("a package's system check failed");

    throw new OfficeError("a package's system check failed (above); fix it and rerun office setup");
  }

  if (!checked) {
    stage.fail("office check found problems");

    throw new OfficeError("setup checks need attention; fix the reported issues and rerun office setup");
  }

  stage.done("office check passed");
  reporter.finish(nextSteps(office, shell));
}

/** What setup says when everything checked out: what only the user can do next. */
function nextSteps(office: Office, shell: boolean): NextStep[] {
  const steps: NextStep[] = [
    {
      title: "Next steps",
      items: [
        { label: "Pair your browser or the OpenCode app with Executor", value: "office pair" },
        { label: "Executor dashboard", value: `http://localhost:${ports().executor}` },
        { label: "Connect a model provider in OpenCode (provider logins are yours)", value: "/connect, then /models" },
        ...(office.opencode.mode === "container" ? [{ label: "Log in to Claude Agent, then connect it in OpenCode", value: `docker exec -it office-${office.name}-opencode-1 claude auth login` }] : []),
      ],
    },
  ];

  if (shell) {
    steps.push({
      title: "Your shell",
      items: [
        { label: `For bash or zsh, enable mise in the interactive startup file (eval "$(mise activate bash)" or eval "$(mise activate zsh)"). Source ${envFilePath()} after activation so the office wrappers come first. Keep existing lines if already configured:` },
        { label: "", value: sourceLine() },
      ],
    });
  }

  return steps;
}

/**
 * A host-mode office manages its machine, writing files outside its folder (links in mise's global
 * conf.d), only once the user says yes: here, or with --manage-machine unattended. The yes is the
 * machine record itself, which names this office; without it sync writes nothing there and says
 * so. Refusing or skipping goes on with setup. Returns whether the office manages the machine, so
 * setup's closing steps include the shell line.
 */
async function machineConsent(office: Office, granted: boolean, ask: Ask | undefined): Promise<boolean> {
  const current = claim(office);

  if (current.kind === "other") {
    say(`${ownedElsewhere(current.record)}`, "Machine: ");

    return false;
  }

  if (current.kind === "ours" || granted) {
    say(grantConsent(office), "Machine: ");

    return true;
  }

  const answer = ask === undefined ? "unattended" : await ask(consentQuestion(office));

  if (answer === "yes") {
    say(grantConsent(office), "Machine: ");

    return true;
  }

  say(`office ${office.name} writes nothing outside its folder, so its tools apply only inside it; to allow it later, run ${consentCommand}`, "Machine: ");

  return false;
}

function globalGit(key: string): string | undefined {
  try {
    return git(["config", "--global", "--get", key]) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The office's commit identity, `git.name` and `git.email` in office.yaml: kept when set, else
 * offered from the host's global git identity when interactive and saved there. Never invented.
 */
async function commitIdentity(office: Office, ask: Ask | undefined): Promise<Office> {
  if (office.git?.name !== undefined) {
    say(`${office.git.name} <${office.git.email}> (office.yaml)`, "Git identity: ");

    return office;
  }

  let name: string | undefined;
  let email: string | undefined;

  if (ask !== undefined) {
    const [hostName, hostEmail] = [globalGit("user.name"), globalGit("user.email")];
    const answer = hostName !== undefined && hostEmail !== undefined ? await ask(`Commit as ${hostName} <${hostEmail}> (this host's git identity) in this office's container and jobs? It is saved to office.yaml. [yes/no/other]`) : "other";

    if (answer === "yes") [name, email] = [hostName, hostEmail];
    else if (answer === "other") {
      name = (await ask("Commit name for this office (blank to skip):")) || undefined;
      email = name === undefined ? undefined : (await ask("Commit email:")) || undefined;
    }
  }

  if (name === undefined || email === undefined) {
    say("none in office.yaml, so upgrade-tools commits as office cron and other commits use git's own config. To set one, add `name` and `email` under `git:` in office.yaml", "Git identity: ");

    return office;
  }

  const updated = updateConfig(office, [[["git", "name"], name], [["git", "email"], email]]);

  say(`saved ${name} <${email}> to office.yaml (review and commit it)`, "Git identity: ");

  return updated;
}

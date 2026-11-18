import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { git } from "../git.ts";
import { githubStep, planGithub, unreachableSources } from "../github.ts";
import { installHook } from "../hook.ts";
import { onboardHostTools, requireOfficeTool } from "../host-tools.ts";
import { envFilePath, sourceLine } from "../host-env.ts";
import { claim, consentCommand, consentQuestion, grantConsent, ownedElsewhere } from "../machine.ts";
import { executorEnvFile, type Office, OfficeError, readEnvFile, updateConfig } from "../office.ts";
import { decrypt, encrypt, initializeIdentity, prepareSecrets, requireTool } from "../secrets.ts";
import { deploy } from "./apps.ts";
import { check } from "./check.ts";
import { installingMise, ports, startExecutor, up } from "./compose.ts";
import { bootstrapExecutor } from "./executor.ts";
import { sync } from "./sync.ts";

type SetupOptions = {
  ownerEmail?: string;
  generateAgeKey: boolean;
  installDeps?: boolean;
  manageMachine?: boolean;
};

async function question(text: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new OfficeError(`${text} Rerun interactively or supply the documented setup options; no prompt was opened`);

  const terminal = createInterface({ input: process.stdin, output: process.stdout });

  try {
    return (await terminal.question(`${text} `)).trim();
  } finally {
    terminal.close();
  }
}

/** No wizard completion marker: each run inspects files, API state and the real services. */
export async function setup(initial: Office, options: SetupOptions): Promise<void> {
  let office = initial;

  requireTool("docker", ["info"]);
  requireTool("docker", ["compose", "version"]);
  requireTool("docker", ["buildx", "version"]);
  requireTool("git");

  const ask = process.stdin.isTTY && process.stdout.isTTY ? question : undefined;

  // Anonymous reads of the sources, before any login: the GitHub step below asks for one only when needed.
  const github = planGithub(office);

  await onboardHostTools(office, options.installDeps === true, ask, { installer: () => installingMise(office) });

  if (options.generateAgeKey) initializeIdentity(office);

  // Legacy offices with a token need no new secrets configuration. Bootstrap does need portable
  // owner persistence; opt in without replacing unrelated YAML or any existing source.
  const hasToken = readEnvFile(executorEnvFile(office)).EXECUTOR_TOKEN;

  if (office.secrets?.executor_owner === undefined && !hasToken) {
    if (!existsSync(join(office.dir, ".sops.yaml"))) {
      const answer = options.generateAgeKey ? "yes" : await question("Executor bootstrap needs SOPS/age. Generate a host age identity and public .sops.yaml? [yes/no]");

      if (answer !== "yes") throw new OfficeError("setup paused; configure .sops.yaml with authorized age recipients, then rerun (or use --generate-age-key to consent)");

      initializeIdentity(office);
    }

    office = updateConfig(office, [[["secrets", "executor_owner"], "secrets/executor-owner.enc.json"]]);
  }

  const ownerFile = office.secrets?.executor_owner;

  if (ownerFile !== undefined && !existsSync(join(office.dir, ownerFile))) {
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
    decrypt(office, ownerFile);
  }

  prepareSecrets(office, { allowMissingOwner: true });

  office = await commitIdentity(office, ask);
  office = await githubStep(office, github, ask);

  await machineConsent(office, options.manageMachine === true, ask);

  // A login alone proves nothing: read every source as sync will, before cloning starts.
  const unreachable = unreachableSources(office);

  if (unreachable.length > 0) {
    throw new OfficeError(`these sources don't read on this host, so nothing was cloned:\n${unreachable.map((line) => `  - ${line}`).join("\n")}\nFix them or office.yaml, then rerun office setup`);
  }

  const changes = await sync(office, { referencesOnly: false });

  for (const line of changes) console.log(line);

  if (changes.some((line) => line.startsWith("FAILED"))) throw new OfficeError("sync failed; fix the reported source and rerun office setup");

  const hook = installHook(office);

  if (hook !== undefined) console.log(hook);

  let email = options.ownerEmail;

  if (!hasToken && ownerFile !== undefined && !existsSync(join(office.dir, ownerFile)) && email === undefined) {
    email = await question("Executor owner email:");
  }

  const crontab = join(office.dir, "cron/crontab");
  const scheduled = existsSync(crontab) && readFileSync(crontab, "utf8").split("\n").some((line) => line.trim() !== "" && !line.trim().startsWith("#"));

  if (scheduled) console.log("Cron: startup keeps the existing catch-up behavior, including jobs that have never run.");

  await startExecutor(office);
  await bootstrapExecutor(office, email);
  await up(office);

  await deploy(office);

  if (!(await check(office))) throw new OfficeError("setup checks need attention; fix the reported issues and rerun office setup");

  console.log(`Services and apps are ready. Next: office pair (Executor dashboard: http://localhost:${ports().executor}).`);

  console.log(`Provider authentication remains human-controlled: use /connect in OpenCode and /models. For Claude Agent in container mode: docker exec -it office-${office.name}-opencode-1 claude auth login, then connect Claude Agent in OpenCode. Other provider logins are independent.`);
}

/**
 * A host-mode office manages its machine, writing files outside its folder (links in mise's global
 * conf.d), only once the user says yes: here, or with --manage-machine unattended. The yes is the
 * machine record itself, which names this office; without it sync writes nothing there and says
 * so. Refusing or skipping goes on with setup.
 */
async function machineConsent(office: Office, granted: boolean, ask: ((text: string) => Promise<string>) | undefined): Promise<void> {
  if (office.opencode.mode !== "host") return;

  const current = claim(office);

  if (current.kind === "other") {
    console.log(`Machine: ${ownedElsewhere(current.record)}`);

    return;
  }

  if (current.kind === "ours" || granted) {
    console.log(grantConsent(office));
    console.log(shellNote());

    return;
  }

  const answer = ask === undefined ? "unattended" : await ask(consentQuestion(office));

  if (answer === "yes") {
    console.log(grantConsent(office));
    console.log(shellNote());
  } else console.log(`Machine: office ${office.name} writes nothing outside its folder, so its tools apply only inside it; to allow it later, run ${consentCommand}`);
}

/** The one line the user adds to their shell's startup file; office never edits it. */
function shellNote(): string {
  return `Shell: office sync writes ${envFilePath()}, the environment agents and your terminal share (Socket Firewall's wrappers first on PATH, package release ages). Add this line to your ~/.zshrc (or ~/.bashrc), after mise activate; office check says whether your startup files source it:\n  ${sourceLine()}`;
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
async function commitIdentity(office: Office, ask: ((text: string) => Promise<string>) | undefined): Promise<Office> {
  if (office.git?.name !== undefined) {
    console.log(`Git identity: ${office.git.name} <${office.git.email}> (office.yaml)`);

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
    console.log("Git identity: none in office.yaml, so upgrade-tools commits as office cron and other commits use git's own config. To set one, add `name` and `email` under `git:` in office.yaml");

    return office;
  }

  const updated = updateConfig(office, [[["git", "name"], name], [["git", "email"], email]]);

  console.log(`Git identity: saved ${name} <${email}> to office.yaml (review and commit it)`);

  return updated;
}

// GitHub for an office, over HTTPS through gh: which declared sources are on a GitHub host and
// whether they read without a login, the host's gh login and git wiring, and the host's gh
// configuration shared read-only with the container. gh is one of the office package's tools, so
// the host's CLI and the container both run the version machine.packages.toml pins.
// One login, made on the host, serves host-side cloning, the container's agents and its cron jobs.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import * as v from "valibot";
import { parse } from "yaml";

import { git } from "./git.ts";
import { ghLink, type InstalledTool, officeTool } from "./host-tools.ts";
import { clones } from "./layout.ts";
import { type Office, OfficeError, type Repository, skillGroups, updateConfig } from "./office.ts";
import { check } from "./schema.ts";
import { compareVersions } from "./versions.ts";
import { inherit, progress, say, stream, warn } from "./report/index.ts";

/** A declared clone source: a reference, desk repository, plugin, copied skill or package. */
export type Source = { what: string; url: string; pushes: boolean };

/** The office's sources, with `references` the ones to clone: the applied ones in setup, the gathered ones in check. */
export function sources(office: Office, references: readonly Repository[]): Source[] {
  return [
    // Desk repositories are working clones that agents commit in and push from.
    ...clones(office, references).map((clone) => ({ what: `${clone.kind} ${clone.name}`, url: clone.url, pushes: clone.kind !== "reference" && clone.kind !== "plugin" })),
    ...skillGroups(office).map((group) => ({ what: group.grouped ? `copied skills ${group.skills.map((skill) => skill.name).join(", ")}` : `copied skill ${group.skills[0].name}`, url: group.repo, pushes: false })),
    ...office.packages.flatMap((entry) => (entry.source === undefined ? [] : [{ what: `package ${entry.name}`, url: entry.source.repo, pushes: false }])),
  ];
}

/** gh's configuration folder on this host, chosen as gh chooses it. */
export function ghConfigDir(): string {
  return process.env.GH_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "gh");
}

const hostsSchema = v.nullish(v.record(v.string(), v.nullish(v.looseObject({}))), {});

/** The hosts the host's gh has an account for, from the names in its hosts.yml. */
export function ghHosts(): string[] {
  const path = join(ghConfigDir(), "hosts.yml");

  if (!existsSync(path)) return [];

  let document;

  try {
    document = parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }

  const result = check(v.safeParse(hostsSchema, document));

  return result.ok ? Object.keys(result.value) : [];
}

/** The host of an HTTPS URL; undefined for SSH, local paths and other schemes. */
export function httpsHost(url: string): string | undefined {
  if (!/^https:\/\//i.test(url)) return undefined;

  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** A URL without any user name or password in it, for messages. */
function redact(url: string): string {
  try {
    const parsed = new URL(url);

    parsed.username = "";
    parsed.password = "";

    return parsed.toString();
  } catch {
    return url;
  }
}

/** Whether git reads `url`; with `anonymous`, without any credential helper. Never prompts. */
async function reach(url: string, { anonymous = false } = {}) {
  const result = await stream("git", [...(anonymous ? ["-c", "credential.helper="] : []), "ls-remote", url, "HEAD"], {
    timeout: 60_000,
    line: () => {},
    // No terminal prompt, and no Git Credential Manager window either.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
  });

  return { ok: result.status === 0, error: result.stderr };
}

/** Reads each source at once, without blocking; one result per source, in order. */
function reachAll(urls: string[], options: { anonymous?: boolean } = {}) {
  return Promise.all(urls.map((url) => reach(url, options)));
}

/** What the office needs from GitHub: from office.yaml, and anonymous reads of its sources. */
export type GithubPlan = {
  hosts: string[];
  /** Sources on a GitHub host that don't read without a login. */
  private: Source[];
  /** Desk repositories on a GitHub host, which agents push to. */
  pushes: Source[];
  /** A login is required: a private source, or office.yaml shares the host's login. */
  needed: boolean;
};

/** The sources on a GitHub host: github.com, or a host the host's gh has an account for. */
function githubSources(office: Office, references: readonly Repository[]): Source[] {
  const known = ghHosts();

  return sources(office, references).filter((source) => {
    const host = httpsHost(source.url);

    return host !== undefined && (host === "github.com" || known.includes(host));
  });
}

/**
 * The GitHub hosts the office uses: its sources' hosts. An office that shares the login without
 * such a source uses the hosts gh has accounts for, else github.com.
 */
export function githubHosts(office: Office, references: readonly Repository[]): string[] {
  const hosts = [...new Set(githubSources(office, references).map((source) => httpsHost(source.url) ?? ""))];

  if (office.git?.credentials !== "gh" || hosts.length > 0) return hosts;

  const known = ghHosts();

  return known.length > 0 ? known : ["github.com"];
}

export async function planGithub(office: Office, references: readonly Repository[]): Promise<GithubPlan> {
  const onGithub = githubSources(office, references);
  const reads = await reachAll(onGithub.map((source) => source.url), { anonymous: true });
  const unreadable = onGithub.filter((_, index) => !reads[index].ok);

  return { hosts: githubHosts(office, references), private: unreadable, pushes: onGithub.filter((source) => source.pushes), needed: office.git?.credentials === "gh" || unreadable.length > 0 };
}

const statusSchema = v.object({
  hosts: v.record(
    v.string(),
    v.array(v.object({ state: v.string(), error: v.optional(v.string()), active: v.boolean(), login: v.optional(v.string()), tokenSource: v.string(), refreshable: v.optional(v.boolean()) })),
  ),
});

/** The active account gh has for a host: whether it works (and gh's error), and where its token comes from. */
export type Login = { state: string; error?: string; account: string | undefined; tokenSource: string; refreshable: boolean };

/** gh's environment; prompts only for `gh auth login`, which the user answers. */
function ghEnvironment(gh: InstalledTool, { prompts = false } = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" };

  if (!prompts) env.GH_PROMPT_DISABLED = "1";

  // GH_PATH is the program `gh auth setup-git` names in git config: the stable link office keeps to
  // the office's gh, not the versioned install behind it, which an upgrade replaces.
  if (existsSync(ghLink())) env.GH_PATH = ghLink();
  else if (gh.path.includes("/")) env.GH_PATH = gh.path;

  return env;
}

/** The host's login for `host`; `--json` never includes the token and always exits 0. */
export function ghLogin(gh: InstalledTool, host: string): Login | undefined {
  let output;

  try {
    output = execFileSync(gh.path, ["auth", "status", "--json", "hosts", "--hostname", host], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"], env: ghEnvironment(gh) });
  } catch {
    return undefined;
  }

  let document;

  try {
    document = JSON.parse(output);
  } catch {
    return undefined;
  }

  const result = check(v.safeParse(statusSchema, document));
  const entry = result.ok ? result.value.hosts[host]?.find((candidate) => candidate.active) : undefined;

  return entry === undefined ? undefined : { state: entry.state, error: entry.error, account: entry.login, tokenSource: entry.tokenSource, refreshable: entry.refreshable === true };
}

/** Why the host's login for a host doesn't work, or undefined when it does. */
export function loginProblem(login: Login | undefined): string | undefined {
  if (login === undefined) return "not logged in";

  return login.state === "success" ? undefined : `gh can't use the login of ${login.account ?? "its account"} (${login.error ?? login.state})`;
}

/**
 * Why a login can't be shared with the container, or undefined when it can: the token must sit in
 * gh's hosts.yml, which the container mounts, and must not be an expiring one, whose refresh token
 * rotates, so two copies refreshing it would sign each other out.
 */
export function unshareable(login: Login): string | undefined {
  if (login.refreshable) return "it is an expiring token whose refresh token rotates, which two machines can't share";

  if (login.tokenSource === "keyring") return "gh keeps its token in the system keyring, which the container can't read";

  if (!isAbsolute(login.tokenSource)) return `its token comes from ${login.tokenSource}, which the container doesn't get`;

  return undefined;
}

/** The credential helper git on this host uses for https://<host>, the last one configured. */
export function gitHelper(host: string): string | undefined {
  try {
    return git(["config", "--get-urlmatch", "credential.helper", `https://${host}`]) || undefined;
  } catch {
    return undefined;
  }
}

/** Whether a credential helper is gh's, with an executable that runs. */
export function isGhHelper(helper: string | undefined): boolean {
  const match = /^!\s*(?:'([^']+)'|"([^"]+)"|(\S+))\s+auth\s+git-credential\s*$/.exec(helper ?? "");
  const executable = match?.[1] ?? match?.[2] ?? match?.[3];

  return executable !== undefined && spawnSync(executable, ["--version"], { stdio: "ignore", timeout: 30_000 }).status === 0;
}

function loginCommand(gh: InstalledTool, host: string, container: boolean): string[] {
  // The container reads the token from hosts.yml, and gh before 2.103 has no --expiring option.
  const extra = container ? ["--insecure-storage", ...(compareVersions(gh.version, "2.103.0") >= 0 ? ["--expiring=false"] : [])] : [];

  return ["auth", "login", "--hostname", host, "--git-protocol", "https", "--web", ...extra];
}

type Ask = ((text: string) => Promise<string>) | undefined;

/**
 * The GitHub step of `office setup`. office.yaml's `git.credentials: gh` declares that the office
 * uses the host's gh login and authorizes what that needs; without it, the step only asks to add
 * it, interactively, when a source doesn't read without a login. Resumable: it inspects gh, the
 * login and git's helper each run, and returns the office re-read.
 */
export async function githubStep(office: Office, plan: GithubPlan, ask: Ask): Promise<Office> {
  let current = office;

  if (office.git?.credentials !== "gh") {
    const readers = plan.pushes.filter((source) => !plan.private.includes(source));

    if (plan.private.length === 0) {
      if (readers.length > 0) say(`${readers.map((source) => source.what).join(", ")} reads without a login, but agents can't push to it without one; to use your gh login, add \`credentials: gh\` under \`git:\` in office.yaml and rerun office setup`, "GitHub: ");

      return office;
    }

    const reasons = plan.private.map((source) => `${source.what} doesn't read without a login`).join("; ");
    const guidance = `${reasons}. To use your GitHub login through gh, add \`credentials: gh\` under \`git:\` in office.yaml and rerun office setup, or list only sources that read without a login`;

    if (ask === undefined) throw new OfficeError(guidance);

    say(`GitHub (${plan.hosts.join(", ")}): ${reasons}`);
    say(`Setting up GitHub uses one gh login made on this host: gh as git's HTTPS credential helper (gh auth setup-git, which writes your global git config)${office.opencode.mode === "container" ? ", and the host's gh configuration shared read-only with the opencode container" : ""}.`);

    if ((await ask("Set up GitHub and record git.credentials: gh in office.yaml? [yes/no]")) !== "yes") throw new OfficeError(guidance);

    current = updateConfig(office, [[["git", "credentials"], "gh"]]);
    say("recorded git.credentials: gh in office.yaml (review and commit it)", "GitHub: ");
  }

  const container = current.opencode.mode === "container";
  const gh = officeTool(current, "gh");

  if (gh === undefined) throw new OfficeError("office.yaml uses GitHub through gh (git.credentials: gh), but gh isn't installed on this host: rerun office setup --install-deps, which installs the office package's gh, or install gh on PATH");

  if (container && process.getuid?.() !== 1000) warn(`the container user is uid 1000 and this host user is uid ${process.getuid?.()}, so the container can't read ${ghConfigDir()}`, `GitHub: warning: the container user is uid 1000 and this host user is uid ${process.getuid?.()}, so the container can't read ${ghConfigDir()}`);

  for (const host of plan.hosts) {
    const login = ghLogin(gh, host);
    const problem = login?.state !== "success" ? loginProblem(login) : container ? unshareable(login) : undefined;

    if (problem === undefined) {
      say(`logged in to ${host} as ${login?.account ?? "?"}`, "GitHub: ");
      continue;
    }

    const command = `gh ${loginCommand(gh, host, container).join(" ")}`;

    // A browser login needs a person: setup runs it in their terminal, or stops with the command.
    if (ask === undefined) throw new OfficeError(`GitHub: ${host}: ${problem}. Logging in needs you in a browser: run ${command} in a terminal, then rerun office setup`);

    const what = `${host}: ${problem}; logging in with ${command}${container ? ` (the token is stored in ${join(ghConfigDir(), "hosts.yml")}, mode 600, so the container can read it)` : ""}`;
    // A browser login is the user's: gh gets the terminal, with any live display paused.
    const result = await inherit(what, () => spawnSync(gh.path, loginCommand(gh, host, container), { stdio: "inherit", env: ghEnvironment(gh, { prompts: true }) }));
    const after = ghLogin(gh, host);

    if (result.status !== 0 || after?.state !== "success") throw new OfficeError(`gh auth login didn't complete for ${host}; rerun office setup`);

    if (container && unshareable(after) !== undefined) throw new OfficeError(`the new login for ${host} can't be shared with the container: ${unshareable(after)}. Run ${command} and rerun office setup`);
  }

  for (const host of plan.hosts.filter((candidate) => !isGhHelper(gitHelper(candidate)))) {
    say(`making git on this host use gh for https://${host} (gh auth setup-git, which writes your global git config)`, "GitHub: ");
    progress(`gh auth setup-git --hostname ${host}`);
    execFileSync(gh.path, ["auth", "setup-git", "--hostname", host], { stdio: ["ignore", "pipe", "pipe"], env: ghEnvironment(gh) });

    if (!isGhHelper(gitHelper(host))) throw new OfficeError(`gh auth setup-git ran, but git's helper for https://${host} is ${gitHelper(host) ?? "unset"}; fix your git config and rerun office setup`);

    say(`git uses ${gitHelper(host)} for https://${host}`, "GitHub: ");
  }

  if (container) say(`ready; office up shares ${ghConfigDir()} read-only with the opencode container`, "GitHub: ");
  else say("ready", "GitHub: ");

  return current;
}

/** Why git can't read a source, from its error and what is known of the host's login. */
function cause(error: string, loggedIn: boolean | undefined): string {
  const text = error.toLowerCase();
  const lines = error.split("\n").map((line) => line.replace(/^(fatal|remote|error):\s*/, "").trim()).filter((line) => line !== "");

  if (text.includes("saml") || text.includes(" sso")) return `the organization requires SSO authorization for gh's token (${lines.find((line) => /saml|sso/i.test(line)) ?? "SSO"}); authorize it in GitHub's settings, then rerun`;

  if (/could not read username|terminal prompts disabled|authentication failed|invalid username or (password|token)/.test(text)) {
    return loggedIn === true ? "the login was rejected, or git isn't using gh for this host" : "not logged in to this host";
  }

  if (/repository .*not found|not found/.test(text)) return "no access with this login, or it doesn't exist";

  return lines.at(-1) ?? "git ls-remote failed";
}

/**
 * Reads every declared source with this host's git credentials, as sync will; returns one line
 * per source that doesn't read, with the likely cause.
 */
export async function unreachableSources(office: Office, references: readonly Repository[]): Promise<string[]> {
  const gh = officeTool(office, "gh");
  const all = sources(office, references);
  const reads = await reachAll(all.map((source) => source.url));

  return all.flatMap((source, index) => {
    const result = reads[index];

    if (result.ok) return [];

    const host = httpsHost(source.url);
    const loggedIn = host === undefined || gh === undefined ? undefined : ghLogin(gh, host)?.state === "success";

    return [`${source.what} (${redact(source.url)}): ${cause(result.error, loggedIn)}`];
  });
}

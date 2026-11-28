import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describeIgnoredSkills, ignoredFolders, ignoredSkills } from "../../../packages/office/plugin/ignored-skills.ts";
import { hookNote, hookState } from "../../features/machine/hook.ts";
import { officePins, officeTool, type OfficeTool } from "../../features/tools/host-tools.ts";
import { packagesFile } from "../../features/mise-integration/delivery.ts";
import { describeOutside, type Loaded, type Provided, scanOutside, sessionPlaces, shadowing, withLoaded } from "../../features/opencode/outside.ts";
import { ghConfigDir, ghLogin, githubHosts, gitHelper, isGhHelper, loginProblem, unshareable } from "../../github.ts";
import { declaredAccess, type DeclaredAccess } from "../../loader/access.ts";
import { type Office, OfficeError, type Repository } from "../../office.ts";
import { changes, defaultPins, describeMove, isTested, readApplied, tested, toolsFor, wantedPins } from "../../versions.ts";
import { compose } from "../compose.ts";
import type { Context, Report, RootAnswer } from "./context.ts";

/** The versions office.yaml pins, whether office.lock matches, the tested range, and what is pending. */
export function versionChecks(office: Office, report: Report): void {
  const tools = toolsFor(office);
  const list = (pins: typeof defaultPins) => tools.map((tool) => `${tool} ${pins[tool].version}`).join(", ");
  let wanted;

  try {
    wanted = wantedPins(office);
  } catch (error) {
    report(false, "versions", error instanceof Error ? error.message : String(error));

    return;
  }

  report(true, "versions", office.tools.pinsVersions ? `${list(wanted)}, matching office.lock` : `office.yaml pins no versions, so the tool's defaults apply: ${list(wanted)}`);

  const untested = tools.flatMap((tool) => tool !== "executor" && !isTested(tool, wanted[tool].version) ? [`${tool} ${wanted[tool].version} is outside ${tested[tool].from}–${tested[tool].to}`] : []);

  if (untested.length > 0) {
    report("warn", "tested versions", `${untested.join("; ")}, the range this office tool was tested with`);
  }

  const applied = readApplied(office);
  const pending = applied === undefined ? [] : changes(office, applied.pins, wanted);

  if (pending.length > 0) report("warn", "pending upgrade", `${pending.map((move) => describeMove(office, move)).join(", ")}; office up --upgrade applies it`);
}

/** The repositories packages declare, each declaration that fails a failed check. */
export async function accessChecks(office: Office, report: Report): Promise<DeclaredAccess[]> {
  try {
    const { sources, problems } = await declaredAccess(office);

    for (const problem of problems) report(false, "package access", problem);

    return sources;
  } catch (error) {
    report(false, "package access", error instanceof Error ? error.message : String(error));

    return [];
  }
}

/**
 * The office's commit identity, and when office.yaml shares the host's gh login, whether it is
 * ready: on the host, and in a running opencode container. An office without it isn't failed.
 */
export function gitChecks(office: Office, report: Report, running: boolean, references: readonly Repository[], declared: readonly DeclaredAccess[]): void {
  report(
    true,
    "git identity",
    office.git?.name === undefined
      ? "none in office.yaml: upgrade-tools commits as office cron, other commits use git's own config"
      : `${office.git.name} <${office.git.email}>, the default for ${office.opencode.mode === "container" ? "the container's commits" : "the office's cron jobs (a host server's agents use the host's own git config)"}`,
  );

  const hook = hookNote(hookState(office));

  report(hook.warn ? "warn" : true, "pre-commit hook", hook.detail);

  if (office.git?.credentials !== "gh") {
    report(true, "GitHub", "office.yaml doesn't use the host's gh login; only sources that read without a login clone, and agents can't push over HTTPS (add credentials: gh under git: to use it)");

    return;
  }

  let gh: OfficeTool | undefined;

  try {
    gh = officeTool(office, "gh");
  } catch (error) {
    if (!(error instanceof OfficeError)) throw error;
    report(false, "GitHub", error.message);

    return;
  }

  if (gh === undefined) {
    report(false, "GitHub", "office.yaml shares the host's gh login, but gh isn't installed on this host (office setup --install-deps)");

    return;
  }

  const container = office.opencode.mode === "container";
  const hosts = githubHosts(office, references, declared);

  for (const host of hosts) {
    const login = ghLogin(gh, host);
    const problem = login?.state !== "success" ? `${loginProblem(login)} (office setup guides the login; gh auth status --hostname ${host} shows more)` : container ? unshareable(login) : undefined;

    report(problem === undefined, `GitHub ${host}`, problem ?? `logged in as ${login?.account ?? "?"} with gh ${gh.version}${container ? `, shared read-only from ${ghConfigDir()}` : ""}`);

    const helper = gitHelper(host);

    report(isGhHelper(helper), `GitHub ${host}: host git`, isGhHelper(helper) ? `uses ${helper}` : `doesn't use gh (${helper ?? "no helper"}): run gh auth setup-git --hostname ${host}`);
  }

  if (!container) return;

  const pin = officePins(office).gh;

  report(pin !== undefined, "GitHub: container gh", pin === undefined ? `${packagesFile} doesn't hold the office package's gh, so the container can't use the login (office sync writes it)` : `gh ${pin} from ${packagesFile}, the office package's tools`);

  if (!running) return;

  for (const host of hosts) {
    try {
      // `gh auth status` reads the mounted login and asks the host's API; it never prints the token.
      const helper = compose(office, ["exec", "-T", "opencode", "sh", "-c", `gh auth status --hostname "$1" >/dev/null 2>&1 && git config --get-urlmatch credential.helper "https://$1"`, "sh", host], { capture: true });

      report(helper.endsWith("gh auth git-credential"), `GitHub ${host}: container`, `gh is logged in and git uses ${helper}`);
    } catch {
      report(false, `GitHub ${host}: container`, "gh isn't logged in there, or git doesn't use it; run office up, then office check");
    }
  }
}

/** The skills in the office root's project skill folders, by ID, each labelled with its path; links included. */
function officeSkills(office: Office): Map<string, string> {
  const found = new Map<string, string>();

  for (const folder of [".agents/skills", ".opencode/skills"]) {
    const dir = join(office.dir, folder);

    if (!existsSync(dir)) continue;

    for (const id of readdirSync(dir).sort()) {
      if (!found.has(id) && existsSync(join(dir, id, "SKILL.md"))) found.set(id, `the office's skill ${folder}/${id}`);
    }
  }

  return found;
}

/**
 * What sessions load from outside the office, for information: never a failure. Skills and plugins
 * come from the server's answer when there is one, the rest from reading the session's home. The
 * one warning is an outside skill or plugin with the name of one the office provides.
 */
export function outsideSection(office: Office, report: Report, root: RootAnswer | undefined, info: (line: string) => void, { loaded: installed, applied }: Context): void {
  const places = sessionPlaces(office);
  const onHost = (path: string) => places.fromSession(path);

  const loaded: Loaded | undefined =
    root === undefined
      ? undefined
      : {
          // Built-in and plugin-embedded skills have skill:// paths.
          skills: new Map(
            root.skills.flatMap((skill) => {
              const path = skill.path.includes("://") ? undefined : onHost(skill.path);

              return path === undefined ? [] : [[skill.id, path] as const];
            }),
          ),
          plugins: root.plugins.flatMap(({ id, source, state }) => {
            const path = source.type === "local" && source.path !== undefined ? onHost(source.path) : undefined;

            return path === undefined ? [] : [{ id, path, active: state.status === "active" }];
          }),
        };

  const scanned = scanOutside(places);
  const items = loaded === undefined ? scanned : withLoaded(scanned, loaded, office.dir);
  const lines = describeOutside(items, places.home);
  const source = loaded === undefined ? "read from the folders" : "skills and plugins as the server reports loading them, the rest read from the folders";

  if (lines.length === 0) info(`info outside the office: nothing in ${places.label} or above the office that sessions here load`);
  else info(`info outside the office: sessions here also load these from ${places.label} or above the office (${source}); listed for information`);

  for (const line of lines) info(`     - ${line}`);

  const provided: Provided = {
    skills: officeSkills(office),
    plugins: new Map([...installed.plugins.keys()].map((name) => [name, `package ${name}'s plugin`])),
  };

  for (const warning of shadowing(items, provided, places.home, office.dir, loaded)) report("warn", "outside the office", warning);

  // What the office package's skill-folder settings hide from sessions, and what it can't: as
  // sync last applied them, which is what its plugin reads, with the plugin's default before then.
  const officePackage = installed.installed.find((item) => item.entry.name === "office");
  const ignored = officePackage === undefined ? [] : ignoredFolders(applied.ok ? applied.packages.get("office") : undefined);

  if (ignored.length === 0) return;

  for (const line of describeIgnoredSkills(ignoredSkills(office.dir, ignored, places.home), places.home)) report(true, "ignored skill folders", line);
}

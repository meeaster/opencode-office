// The office's guidance for a session, built from office.yaml and the folders. The office
// package's plugin adds it to each session; `office instructions [folder]` runs this same code to print it, so the
// text is never hidden. It looks downward from the session's folder: the root sees the whole
// office, a desk (or any folder inside it) sees that desk in detail and only a note of what is
// shared above it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import * as v from "valibot";

import { check, type OfficeConfig, officeSchema, type Parsed, resolveTools } from "../../../src/schema.ts";
import { type ClaimedReference, resolvedReferences } from "../../../src/reference-snapshot.ts";
import sessionScope from "../claude/session-scope.txt" with { type: "text" };

// What the text uses from office.yaml, read through the schema the CLI uses.
type DeskInfo = { name: string } & OfficeConfig["desks"][string];

type OfficeInfo = { name: string; desks: DeskInfo[]; references: ClaimedReference[]; referenceNotes: string[]; catalogApps: string[]; socketFirewall: boolean; minimumReleaseAge: string };

function readOffice(office: string): Parsed<OfficeInfo> {
  // The plugin and the compiled `office` both run on Bun, which parses YAML itself.
  const result = check(v.safeParse(officeSchema, Bun.YAML.parse(readFileSync(join(office, "office.yaml"), "utf8"))));

  if (!result.ok) return result;

  const config = result.value;
  const tools = resolveTools(config);
  const references = resolvedReferences(office, config);

  return {
    ok: true,
    value: {
      name: config.name,
      desks: Object.entries(config.desks).map(([name, desk]) => ({ name, ...desk })),
      references: references.ok ? references.value.entries : [],
      referenceNotes: references.ok ? references.value.notes : references.errors,
      catalogApps: config.executor?.catalog_apps ?? [],
      socketFirewall: tools.socketFirewall,
      minimumReleaseAge: tools.minimumReleaseAge,
    },
  };
}

/** What a session is told when office.yaml doesn't match the schema. */
function invalidText(errors: string[]): string {
  return [
    "# This office's office.yaml is not valid",
    "",
    "`office` commands refuse to run here until these fields are fixed:",
    "",
    ...errors.map((error) => `- ${error}`),
  ].join("\n");
}

/** The nearest folder at or above `folder` holding office.yaml. */
export function findOffice(folder: string): string | undefined {
  for (let dir = folder; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "office.yaml"))) return dir;

    if (dirname(dir) === dir) return undefined;
  }
}

function entry(path: string, description: string | undefined): string {
  return description === undefined ? `- \`${path}\`` : `- \`${path}\`: ${description}`;
}

const appManifest = v.object({ description: v.optional(v.string()), executor: v.optional(v.object({ title: v.optional(v.string()) })) });

function appDescription(path: string): string | undefined {
  // An unfinished manifest should not prevent the session from receiving its instructions.
  try {
    const manifest = check(v.safeParse(appManifest, JSON.parse(readFileSync(path, "utf8"))));

    return manifest.ok ? manifest.value.description?.trim() || manifest.value.executor?.title : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;

    throw error;
  }
}

/** Local source supplies the description; a catalog-only Executor app has just its slug. */
function executorAppLines(root: string, scope: string, catalog: string[] = []): string[] {
  const folder = join(scope, "executor-apps");
  const dir = join(root, folder);
  const lines = new Map(catalog.map(slug => [slug, `- \`${slug}\` (catalog)`]));

  if (existsSync(dir)) {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const source = join(folder, item.name);
      const path = join(root, source, "package.json");

      if (!item.isDirectory() || !existsSync(path)) continue;

      lines.set(item.name, entry(`${source}/`, appDescription(path)));
    }
  }

  return [...lines.values()];
}

// What every scope shares from the root, listed in full so a desk session can use it directly.
function sharedSections(office: OfficeInfo, apps: string[]): string[] {
  return [
    "## References (desired read-only checkouts; `office sync` updates them, `office check` verifies origins)",
    "",
    ...office.referenceNotes,
    ...(office.references.length === 0 ? ["None listed."] : office.references.map(reference => {
      const line = entry(`references/${reference.name}/`, reference.description);

      return reference.owner === "office.yaml" ? line : `${line} (${reference.owner}${reference.stale ? ", stale" : ""})`;
    })),
    "",
    "## Shared Executor apps",
    "",
    "Use Executor apps through `office-executor` by name (the last folder in each path). To change an Executor app, edit its source there and run `office apps deploy`.",
    "",
    ...(apps.length === 0 ? ["None."] : apps),
  ];
}

/**
 * What every session is told about package downloads while the office's Socket Firewall is on. It
 * holds wherever the office's environment is loaded: the container, and on the host a shell that
 * sources the environment file (`office setup` prints the line).
 */
function firewallLines(office: OfficeInfo): string[] {
  if (!office.socketFirewall) return [];

  const ages = /^0+[hdw]$/.test(office.minimumReleaseAge) ? "Package managers take new releases as soon as they're published." : `Package managers take only releases at least ${office.minimumReleaseAge} old (\`tools.minimum_release_age\` in \`office.yaml\`), so a just-published version isn't found yet.`;

  return [
    "- Package downloads go through Socket Firewall (`sfw`) wherever the office's environment is loaded (the container, the managed host OpenCode service, or a shell that sources `~/.local/share/office/env.sh`): `npm`, `npx`, `pnpm`, `pip`, `pip3`, `uv`, `uvx` and `cargo` are wrappers that run `sfw <command>`, and `mise install`, `use` and `upgrade` run behind it. A refused package fails the command with `=== Socket Firewall ===` and `blocked <ecosystem> package: name: …; reason: malware`: tell the user, and never route around the wrappers (a real binary by its path, another registry). " + ages + " A script that runs a mise-managed tool many times runs faster under `mise exec -- <script>`, which keeps the wrappers first.",
  ];
}

function repoLines(desk: DeskInfo, indent = ""): string[] {
  return desk.repos.map((repo) => `${indent}${entry(`${desk.name}/repos/${repo.name}/`, repo.description)}`);
}

function rootText(root: string, office: OfficeInfo, apps: string[]): string {
  return [
    `# The ${office.name} office`,
    "",
    "This session is at the root of an office: a source-controlled folder of desks. Paths below are relative to the office root.",
    "",
    "- Each desk is a top-level folder. A session in a desk loads the root's instructions, config and skills plus the desk's own; desks never load each other's.",
    sessionScope.trimEnd(),
    "- `office.yaml` declares the desks, their repositories, the references, which skills from `skills/` are enabled where, cloned plugins and packages: the office's own in `packages/<name>/`, and built-in and remote ones in `.office/packages/`, which are read-only. After changing it, run `office sync`. A package with a desktop app panel (`gui/`) gets it installed on the app's machine only when `office sync` runs on the host, not in the container.",
    "- For onboarding use `office setup`. Owner credentials are human-only: let the human run `office executor credentials` in their terminal, never capture its output in an agent transcript. Keep private age identities and decrypted runtime state outside the office repository.",
    "- `cron:` in `office.yaml` declares file-system jobs; `office cron list` shows which jobs apply in this mode.",
    "- `git` in `office.yaml` sets the commit identity of the container and the office's jobs; with `credentials: gh`, HTTPS remotes use the user's GitHub login, which the user manages on the host. Never run `gh auth login`, `logout` or `switch` for them.",
    ...firewallLines(office),
    "",
    "## Desks",
    "",
    ...(office.desks.length === 0 ? ["No desks yet."] : office.desks.flatMap((desk) => [entry(`${desk.name}/`, desk.description), ...repoLines(desk, "  "), ...executorAppLines(root, desk.name).map(line => `  ${line}`)])),
    "",
    ...sharedSections(office, apps),
  ].join("\n");
}

function deskText(root: string, office: OfficeInfo, desk: DeskInfo, apps: string[]): string {
  const repos = repoLines(desk);
  const deskApps = executorAppLines(root, desk.name);
  const others = office.desks.flatMap((other) => (other.name === desk.name ? [] : [other.name]));

  return [
    `# The ${desk.name} desk of the ${office.name} office`,
    "",
    `This session is at the ${desk.name} desk (\`${desk.name}/\`)${desk.description === undefined ? "." : `: ${desk.description}`} Paths below are relative to the office root.`,
    "",
    `- Keep this desk's work inside \`${desk.name}/\`: repositories under \`${desk.name}/repos/\` (declare new ones under \`desks.${desk.name}.repos\` in \`office.yaml\`, then run \`office sync\`), throwaway work in \`${desk.name}/scratch/\`.`,
    sessionScope.trimEnd(),
    ...firewallLines(office),
    "",
    "## Repositories",
    "",
    ...(repos.length === 0 ? ["None yet."] : repos),
    "",
    "## Desk Executor apps",
    "",
    ...(deskApps.length ? deskApps : ["None."]),
    ...(desk.app ? ["", `Use \`${desk.name}\` tools \`reports.save\` to save results and \`notifications.send\` to reach the user.`] : []),
    "",
    "Shared from the office root, for this desk to use directly:",
    "",
    ...sharedSections(office, apps),
    ...(others.length === 0 ? [] : ["", `Other desks (${others.join(", ")}) have their own folders; move the session there for their work.`]),
  ].join("\n");
}

/** What a session started in `folder` is told about its office, or "" outside an office. */
export function officeInstructions(folder: string): string {
  const dir = findOffice(folder);

  if (dir === undefined) return "";

  const read = readOffice(dir);

  if (!read.ok) return invalidText(read.errors);

  const office = read.value;
  const apps = executorAppLines(dir, "", office.catalogApps);
  const [first] = relative(dir, folder).split(sep);
  const desk = office.desks.find((candidate) => candidate.name === first);

  return desk === undefined ? rootText(dir, office, apps) : deskText(dir, office, desk, apps);
}

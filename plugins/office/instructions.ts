// The office's guidance for a session, built from office.yaml and the folders. The office plugin
// adds it to each session; `office instructions [folder]` runs this same code to print it, so the
// text is never hidden. It looks downward from the session's folder: the root sees the whole
// office, a desk (or any folder inside it) sees that desk in detail and only a note of what is
// shared above it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import * as v from "valibot";

import { check, type OfficeConfig, officeSchema, type Parsed } from "../../src/schema.ts";

// What the text uses from office.yaml, read through the schema the CLI uses.
type DeskInfo = { name: string } & OfficeConfig["desks"][string];

type OfficeInfo = { name: string; desks: DeskInfo[]; references: OfficeConfig["references"] };

function readOffice(office: string): Parsed<OfficeInfo> {
  // The plugin and the compiled `office` both run on Bun, which parses YAML itself.
  const result = check(v.safeParse(officeSchema, Bun.YAML.parse(readFileSync(join(office, "office.yaml"), "utf8"))));

  if (!result.ok) return result;

  const config = result.value;

  return { ok: true, value: { name: config.name, desks: Object.entries(config.desks).map(([name, desk]) => ({ name, ...desk })), references: config.references } };
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

function findOffice(folder: string): string | undefined {
  for (let dir = folder; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "office.yaml"))) return dir;

    if (dirname(dir) === dir) return undefined;
  }
}

function entry(path: string, description: string | undefined): string {
  return description === undefined ? `- \`${path}\`` : `- \`${path}\`: ${description}`;
}

// The office's shared Executor apps, each with the title from its package.json.
function sharedApps(office: string): string[] {
  const dir = join(office, "executor/apps");

  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true })
    .filter((item) => item.isDirectory() && existsSync(join(dir, item.name, "package.json")))
    .map((item) => {
      const manifest: { executor?: { title?: string } } = JSON.parse(readFileSync(join(dir, item.name, "package.json"), "utf8"));
      const title = manifest.executor?.title;

      return entry(`executor/apps/${item.name}/`, title === undefined ? undefined : `the \`${item.name}\` app (${title}) in the \`office-executor\` MCP server`);
    });
}

// What every scope shares from the root, listed in full so a desk session can use it directly.
function sharedSections(references: OfficeConfig["references"], apps: string[]): string[] {
  return [
    "## References (read-only clones; `office sync` updates them)",
    "",
    ...(references.length === 0 ? ["None."] : references.map((reference) => entry(`references/${reference.name}/`, reference.description))),
    "",
    "## Shared Executor apps",
    "",
    ...(apps.length === 0 ? ["None."] : apps),
  ];
}

function repoLines(desk: DeskInfo, indent = ""): string[] {
  return desk.repos.map((repo) => `${indent}${entry(`${desk.name}/repos/${repo.name}/`, repo.description)}`);
}

function rootText(office: OfficeInfo, apps: string[]): string {
  return [
    `# The ${office.name} office`,
    "",
    "This session is at the root of an office: a source-controlled folder of desks. Paths below are relative to the office root.",
    "",
    "- Each desk is a top-level folder. A session started in a desk loads the root's instructions, config and skills plus the desk's own; desks never load each other's. Do a desk's work in a session started there.",
    "- `office.yaml` declares the desks, their repositories, the references, which skills from `skills/` are enabled where, and cloned plugins. After changing it, run `office sync`.",
    "- Reach services through the `office-executor` MCP server. Each desk has an Executor app at `<desk>/executor/apps/<desk>/` with `reports.*`, `notifications.*` and `agent.ask`; after changing it, run `office apps deploy`. For onboarding use `office setup`. Owner credentials are human-only: let the human run `office executor credentials` in their terminal, never capture its output in an agent transcript. Keep private age identities and decrypted runtime state outside the office repository.",
    "- `knowledge/` holds articles every session sees listed; `cron/crontab` runs file-system jobs in the container.",
    "",
    "## Desks",
    "",
    ...(office.desks.length === 0 ? ["No desks yet."] : office.desks.flatMap((desk) => [entry(`${desk.name}/`, desk.description), ...repoLines(desk, "  ")])),
    "",
    ...sharedSections(office.references, apps),
  ].join("\n");
}

function deskText(office: OfficeInfo, desk: DeskInfo, apps: string[]): string {
  const repos = repoLines(desk);
  const others = office.desks.flatMap((other) => (other.name === desk.name ? [] : [other.name]));

  return [
    `# The ${desk.name} desk of the ${office.name} office`,
    "",
    `This session is at the ${desk.name} desk (\`${desk.name}/\`)${desk.description === undefined ? "." : `: ${desk.description}`} Paths below are relative to the office root.`,
    "",
    `- Keep this desk's work inside \`${desk.name}/\`: repositories under \`${desk.name}/repos/\` (declare new ones under \`desks.${desk.name}.repos\` in \`office.yaml\`, then run \`office sync\`), throwaway work in \`${desk.name}/scratch/\`.`,
    `- The desk's Executor app is \`${desk.name}/executor/apps/${desk.name}/\`, the \`${desk.name}\` app in the \`office-executor\` MCP server: save results with \`reports.save\`, reach the user with \`notifications.send\`. After changing it, run \`office apps deploy\`.`,
    "",
    "## Repositories",
    "",
    ...(repos.length === 0 ? ["None yet."] : repos),
    "",
    "Shared from the office root, for this desk to use directly:",
    "",
    ...sharedSections(office.references, apps),
    ...(others.length === 0 ? [] : ["", `Other desks (${others.join(", ")}) have their own folders; their work belongs to sessions started there.`]),
  ].join("\n");
}

/** What a session started in `folder` is told about its office, or "" outside an office. */
export function officeInstructions(folder: string): string {
  const dir = findOffice(folder);

  if (dir === undefined) return "";

  const read = readOffice(dir);

  if (!read.ok) return invalidText(read.errors);

  const office = read.value;
  const apps = sharedApps(dir);
  const [first] = relative(dir, folder).split(sep);
  const desk = office.desks.find((candidate) => candidate.name === first);

  return desk === undefined ? rootText(office, apps) : deskText(office, desk, apps);
}

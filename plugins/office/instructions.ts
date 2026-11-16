// The office's guidance for a session, built from office.yaml and the folders. The office plugin
// adds it to each session; `office instructions [folder]` runs this same code to print it, so the
// text is never hidden. It looks downward from the session's folder: the root sees the whole
// office, a desk (or any folder inside it) sees that desk in detail and only a note of what is
// shared above it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

// What the text uses from office.yaml. It is read leniently, since `office check` validates the
// file: a field that is missing or of another type is left out.
type Described = { name: string; description: string | undefined };

type DeskInfo = Described & { repos: Described[] };

type OfficeInfo = { name: string; desks: DeskInfo[]; references: Described[] };

/** A parsed YAML mapping's fields; any other value has none. */
function fields(value: unknown): Map<string, unknown> {
  return new Map(typeof value === "object" && value !== null && !Array.isArray(value) ? Object.entries(value) : []);
}

function described(name: string, value: unknown): Described {
  const description = fields(value).get("description");

  return { name, description: typeof description === "string" && description !== "" ? description : undefined };
}

function namedList(value: unknown): Described[] {
  return Array.isArray(value) ? value.map((item) => described(String(fields(item).get("name")), item)) : [];
}

function readOffice(office: string): OfficeInfo {
  // The plugin and the compiled `office` both run on Bun, which parses YAML itself.
  const config = fields(Bun.YAML.parse(readFileSync(join(office, "office.yaml"), "utf8")));
  const name = config.get("name");

  return {
    name: typeof name === "string" ? name : "unnamed",
    desks: [...fields(config.get("desks"))].map(([deskName, desk]) => ({ ...described(deskName, desk), repos: namedList(fields(desk).get("repos")) })),
    references: namedList(config.get("references")),
  };
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
function sharedSections(references: Described[], apps: string[]): string[] {
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
    "- Executor holds every service account: reach services through the `office-executor` MCP server. Each desk has an Executor app at `<desk>/executor/apps/<desk>/` with `reports.*`, `notifications.*` and `agent.ask`. After changing an app, run `office apps deploy`.",
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

  const office = readOffice(dir);
  const apps = sharedApps(dir);
  const [first] = relative(dir, folder).split(sep);
  const desk = office.desks.find((candidate) => candidate.name === first);

  return desk === undefined ? rootText(office, apps) : deskText(office, desk, apps);
}

// The office's guidance for a session, built from office.yaml and the folders. The office
// package's plugin adds it to each session; `office instructions [folder]` runs this same code to print it, so the
// text is never hidden. Every folder of the office gets the same text: a session started inside a
// working repository also loads that repository's own instructions, natively.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import * as v from "valibot";

import { check, officeSchema, type Parsed, resolveTools } from "../../../src/schema.ts";
import { type AppliedReference, appliedReferences } from "../../../src/features/references/applied-references.ts";
import sessionScope from "../claude/session-scope.txt" with { type: "text" };

// What the text uses from office.yaml, read through the schema the CLI uses.
type OfficeInfo = { name: string; references: AppliedReference[]; referenceNotes: string[]; socketFirewall: boolean; minimumReleaseAge: string };

function readOffice(office: string): Parsed<OfficeInfo> {
  // The plugin and the compiled `office` both run on Bun, which parses YAML itself.
  const result = check(v.safeParse(officeSchema, Bun.YAML.parse(readFileSync(join(office, "office.yaml"), "utf8"))));

  if (!result.ok) return result;

  const config = result.value;
  const tools = resolveTools(config);
  const references = appliedReferences(office, config);

  return {
    ok: true,
    value: {
      name: config.name,
      references: references.ok ? references.value : [],
      referenceNotes: references.ok ? [] : references.errors,
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

// What the office shares, listed in full so a session anywhere in it can use it directly.
function sharedSections(office: OfficeInfo): string[] {
  return [
    "## References (desired read-only checkouts; `office sync` updates them, `office check` verifies origins)",
    "",
    ...office.referenceNotes,
    ...(office.references.length === 0 ? ["None listed."] : office.references.map(reference => {
      const line = entry(`references/${reference.name}/`, reference.description);

      return reference.owner === "office.yaml" ? line : `${line} (package ${reference.owner})`;
    })),
  ];
}

/**
 * What every session is told about package downloads while the office's Socket Firewall is on. It
 * holds wherever the office's environment is loaded: the container, and on the host a shell that
 * sources the environment file (`office setup` prints the line).
 */
function firewallLines(office: OfficeInfo): string[] {
  if (!office.socketFirewall) return [];

  const ages = /^0+[hdw]$/.test(office.minimumReleaseAge) ? "Package managers take new releases as soon as they're published." : `Package managers take only releases at least ${office.minimumReleaseAge} old (\`minimum_release_age\` in \`office.yaml\`), so a just-published version isn't found yet.`;

  return [
    "- Package downloads go through Socket Firewall (`sfw`) wherever the office's environment is loaded (the container, the managed host OpenCode service, or a shell that sources `~/.local/share/office/env.sh`): `npm`, `npx`, `pnpm`, `pip`, `pip3`, `uv`, `uvx` and `cargo` are wrappers that run `sfw <command>`, and `mise install`, `use` and `upgrade` run behind it. A refused package fails the command with `=== Socket Firewall ===` and `blocked <ecosystem> package: name: …; reason: malware`: tell the user, and never route around the wrappers (a real binary by its path, another registry). " + ages + " A script that runs a mise-managed tool many times runs faster under `mise exec -- <script>`, which keeps the wrappers first.",
  ];
}

function officeText(office: OfficeInfo): string {
  return [
    `# The ${office.name} office`,
    "",
    "This session is in an office: a source-controlled folder of work. Paths below are relative to the office root.",
    "",
    "- Working repositories, when the office has them, are checkouts under `repos/`; read-only references are under `references/`; throwaway work and Git worktrees go in `scratch/`. The office's own repository keeps all three out of its commits.",
    sessionScope.trimEnd(),
    "- `office.yaml` declares the references, cloned plugins and packages: the office's own in `packages/<name>/`, and built-in and remote ones in `.office/packages/`, which are read-only. With the `repos` package, its settings declare the working repositories; with the `skills` package, its settings choose the standalone skills linked into the root's `.agents/skills/`. After changing it, run `office sync`. A package's desktop app panel gets installed on the app's machine only when `office sync` runs on the host, not in the container.",
    "- For onboarding use `office setup`. Owner credentials are human-only: let the human run `office executor credentials` in their terminal, never capture its output in an agent transcript. Keep private age identities and decrypted runtime state outside the office repository.",
    "- Scheduled jobs are the `cron` package's: the office's own go under its entry's `settings.jobs` in `office.yaml`, changes to packages' jobs under `settings.overrides`; `office cron list` shows which jobs apply in this mode, and `office up` applies a schedule change.",
    "- `git` in `office.yaml` sets the commit identity of the container and the office's jobs; with `credentials: gh`, HTTPS remotes use the user's GitHub login, which the user manages on the host. Never run `gh auth login`, `logout` or `switch` for them.",
    ...firewallLines(office),
    "",
    ...sharedSections(office),
  ].join("\n");
}

/** What a session started in `folder` is told about its office, or "" outside an office. */
export function officeInstructions(folder: string): string {
  const dir = findOffice(folder);

  if (dir === undefined) return "";

  const read = readOffice(dir);

  if (!read.ok) return invalidText(read.errors);

  const office = read.value;

  return officeText(office);
}

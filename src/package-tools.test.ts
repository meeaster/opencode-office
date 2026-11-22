import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import * as v from "valibot";

import { withVersion } from "./commands/upgrade.ts";
import { sync } from "./commands/sync.ts";
import { installedPackages } from "./layout.ts";
import { globalConfD, grantConsent, machineRecordPath } from "./machine.ts";
import { toolPins } from "./mise-toml.ts";
import { loadOffice } from "./office.ts";
import { localEdits, pulledDir, readRecord } from "./packages.ts";
import { check, packageManifestSchema } from "./schema.ts";
import { compareToolVersions, fragmentNotes, machineBelowFloors, machineFiles, moveFragmentTools, oldToolFragments, orphanFragments, packageLines, packagesFileProblems, strayFragments } from "./package-tools.ts";
import { writePackage } from "./test-package.ts";

let dir: string;

let office: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-package-tools-"));
  office = join(dir, "office");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A local package `name` declaring `tools`. */
function pkg(name: string, tools: string): void {
  writePackage(join(office, `packages/${name}/package.yaml`), `name: ${name}\ndescription: A ${name} package.\n${tools}`);
}

/** A local package `demo` declaring `tools`, listed in office.yaml. */
function demo(tools: string): void {
  pkg("demo", tools);
  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: demo\n");
}

const fragment = () => join(office, ".office/mise/demo.toml");

const packages = () => readFileSync(join(office, "machine.packages.toml"), "utf8");

/** The [tools] lines of machine.packages.toml other than the office package's. */
const lines = () => packages().split("\n").filter((line) => line.startsWith('"') && !line.endsWith("# office"));

/** Replaces a tool's version in machine.packages.toml, as office upgrade-tools or the owner would. */
function setVersion(tool: string, version: string): void {
  const text = packages().split("\n");
  const pin = toolPins(packages()).find((entry) => entry.tool === tool);

  if (pin === undefined) throw new Error(`${tool} isn't in machine.packages.toml`);

  text[pin.index] = withVersion(text[pin.index], version);
  writeFileSync(join(office, "machine.packages.toml"), text.join("\n"));
}

function loaded() {
  const config = loadOffice(office);

  return { config, installed: installedPackages(config).installed };
}

/** What `office check` says of `name`'s tools. */
function notes(name = "demo") {
  const { config, installed } = loaded();
  const item = installed.find((candidate) => candidate.entry.name === name);

  if (item === undefined) throw new Error(`${name} isn't installed`);

  return fragmentNotes(config, item);
}

/** What `office check` says of machine.packages.toml as a whole. */
function problems(declared = ["office", "demo"]) {
  const { config, installed } = loaded();

  return packagesFileProblems(config, installed, declared);
}

test("versions order SemVer-like, and office doesn't guess one it can't read", () => {
  expect(compareToolVersions("1.10.0", "1.9.0")).toBe(1);
  expect(compareToolVersions("v2.104.0", "2.105.0")).toBe(-1);
  expect(compareToolVersions("1.2", "1.2.1")).toBe(-1);
  expect(compareToolVersions("1.2.0", "1.2.0+build.5")).toBe(0);
  expect(compareToolVersions("1.2.0-rc.1", "1.2.0")).toBe(-1);
  expect(compareToolVersions("1.2.0-rc.10", "1.2.0-rc.9")).toBe(1);
  expect(compareToolVersions("latest", "1.0.0")).toBeUndefined();
  expect(compareToolVersions("1.0.0", "lts")).toBeUndefined();
});

test("upgrade-tools' line edit keeps a line's package comment", () => {
  expect(withVersion('"bun" = "1.4.4" # browser, shell', "1.4.5")).toBe('"bun" = "1.4.5" # browser, shell');
});

test("sync writes a package's tools to machine.packages.toml at the package's versions, naming the package, and no fragment", async () => {
  demo('tools:\n  "npm:agent-browser": "0.43.0"\n  jq: "1.7.1"\n');

  const changes = await sync(loadOffice(office));

  expect(changes).toEqual(expect.arrayContaining([expect.stringMatching(/^created machine\.packages\.toml, the packages' tools: sops \S+, age \S+, gh \S+, pre-commit \S+, npm:agent-browser 0\.43\.0, jq 1\.7\.1$/)]));

  const text = packages();

  expect(text).toStartWith("# The mise tools this office's packages need, one line per tool, naming the packages that need it.\n");
  expect(text).toContain("pin it in machine.toml\n# beside this file");
  expect(text).toMatch(/\n\[tools\]\n"sops" = "[^"]+" # office\n/);
  expect(lines()).toEqual(['"npm:agent-browser" = "0.43.0" # demo', '"jq" = "1.7.1" # demo']);
  expect(existsSync(fragment())).toBe(false);
  expect(existsSync(join(office, ".office/mise/office.toml"))).toBe(false);
  expect(notes()).toEqual({ ok: true, notes: ["tools npm:agent-browser, jq in machine.packages.toml"] });
  expect(problems()).toEqual([]);
  expect(await sync(loadOffice(office))).toEqual([]);
});

test("a package that now needs a newer version raises the office's line, and sync says so", async () => {
  demo('tools:\n  jq: "1.7.1"\n');
  await sync(loadOffice(office));
  demo('tools:\n  jq: "1.8.0"\n');

  expect(notes()).toEqual({ ok: false, notes: ["tools jq in machine.packages.toml", "machine.packages.toml holds jq 1.7.1, below the 1.8.0 this package needs; office sync raises it"] });
  expect(await sync(loadOffice(office))).toEqual(["raised jq from 1.7.1 to 1.8.0 in machine.packages.toml: package demo needs at least 1.8.0"]);
  expect(lines()).toEqual(['"jq" = "1.8.0" # demo']);
  expect(notes().ok).toBe(true);
});

test("two packages declaring one tool get one line at the higher version, naming both; the office's newer version stays", async () => {
  pkg("demo", 'tools:\n  bun: "1.4.4"\n');
  pkg("other", 'tools:\n  bun: "1.4.5"\n');
  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: demo\n  - name: other\n");

  expect(await sync(loadOffice(office))).toEqual(expect.arrayContaining([expect.stringMatching(/, bun 1\.4\.5$/)]));
  expect(lines()).toEqual(['"bun" = "1.4.5" # demo, other']);
  expect(notes("demo").ok).toBe(true);

  setVersion("bun", "1.5.0");
  pkg("other", 'tools:\n  bun: "1.4.9"\n');

  expect(await sync(loadOffice(office))).toEqual([]);
  expect(lines()).toEqual(['"bun" = "1.5.0" # demo, other']);

  // One package leaving keeps the line, naming the other.
  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: demo\n");

  expect(await sync(loadOffice(office))).toEqual(["rewrote the comments of machine.packages.toml, which say who changes what in it and which packages need each tool"]);
  expect(lines()).toEqual(['"bun" = "1.5.0" # demo']);
});

test("a tool no package declares any more goes; one a package adds comes at its version, and check names both first", async () => {
  demo('tools:\n  "npm:agent-browser": "0.43.0"\n  jq: "1.7.1"\n');
  await sync(loadOffice(office));
  setVersion("jq", "1.8.0");
  demo('tools:\n  jq: "1.7.1"\n  "npm:oxlint": "1.93.0"\n');

  expect(notes()).toEqual({ ok: false, notes: ["tools jq in machine.packages.toml", "machine.packages.toml lacks npm:oxlint; office sync adds it"] });
  expect(problems()).toEqual(["machine.packages.toml holds npm:agent-browser, which no package declares here; office sync removes it"]);

  const changes = await sync(loadOffice(office));

  expect(changes).toEqual(["added npm:oxlint 1.93.0 to machine.packages.toml, which package demo declares", "removed npm:agent-browser from machine.packages.toml, as no package declares it here any more"]);
  expect(lines()).toEqual(['"jq" = "1.8.0" # demo', '"npm:oxlint" = "1.93.0" # demo']);
  expect(notes().ok).toBe(true);
  expect(problems()).toEqual([]);
});

test("a version office can't order stays as the office wrote it, and check says why", async () => {
  demo('tools:\n  jq: "1.7.1"\n');
  await sync(loadOffice(office));
  setVersion("jq", "latest");

  expect(await sync(loadOffice(office))).toEqual([]);
  expect(lines()).toEqual(['"jq" = "latest" # demo']);
  expect(notes()).toEqual({ ok: true, notes: ["tools jq in machine.packages.toml", "machine.packages.toml holds jq latest, which office can't order against the 1.7.1 this package declares, so office sync leaves it"] });
});

test("a package that doesn't read, as package.yaml's tools take exact versions only, keeps its lines until it reads again", async () => {
  demo('tools:\n  jq: "1.7.1"\n');
  await sync(loadOffice(office));
  setVersion("jq", "1.8.0");
  pkg("demo", 'tools:\n  jq: latest\n  node: "26"\n');

  expect(await sync(loadOffice(office))).toEqual(
    expect.arrayContaining(["FAILED package demo: packages/demo/package.yaml: tools.jq: must be an exact version such as 0.43.0", "FAILED package demo: packages/demo/package.yaml: tools.node: must be an exact version such as 0.43.0"]),
  );
  expect(lines()).toEqual(['"jq" = "1.8.0" # demo']);
  expect(problems()).toEqual([]);
});

test("check reports a declared tool missing from machine.packages.toml, or the file itself, and comments that differ from what sync writes", async () => {
  demo('tools:\n  "npm:agent-browser": "0.43.0"\n');
  // A synced office (nothing loads before the first sync), whose machine.packages.toml was then removed.
  await sync(loadOffice(office));
  rmSync(join(office, "machine.packages.toml"));

  expect(notes()).toEqual({ ok: false, notes: ["tools npm:agent-browser are missing: machine.packages.toml doesn't exist; office sync writes it"] });

  await sync(loadOffice(office));
  writeFileSync(join(office, "machine.packages.toml"), packages().replace("# demo", "# someone"));

  expect(problems()).toEqual(["machine.packages.toml's comments differ from what office sync writes (which packages need each tool); office sync rewrites them"]);
  expect(packageLines(packages()).get("npm:agent-browser")).toEqual({ version: "0.43.0", packages: ["someone"], index: expect.any(Number) });

  writeFileSync(join(office, "machine.packages.toml"), packages().replace(/^"npm:agent-browser".*\n/m, ""));

  expect(notes()).toEqual({ ok: false, notes: ["tools none in machine.packages.toml", "machine.packages.toml lacks npm:agent-browser; office sync adds it"] });
});

test("machine.toml pinning a tool below a package's version is a warning naming both; at or above, nothing", async () => {
  demo('tools:\n  jq: "1.7.1"\n');
  await sync(loadOffice(office));
  write(join(office, "machine.toml"), '[tools]\njq = "1.6.0"\n');

  const { config, installed } = loaded();

  expect(machineBelowFloors(config, installed)).toEqual(["machine.toml pins jq 1.6.0, below the 1.7.1 package demo needs; it wins over machine.packages.toml, so the package runs an older jq than it was tested with"]);

  // machine.packages.toml stays as it was: machine.toml holds the tool back by winning.
  expect(await sync(loadOffice(office))).toEqual([]);
  expect(lines()).toEqual(['"jq" = "1.7.1" # demo']);

  write(join(office, "machine.toml"), '[tools]\njq = "1.7.1"\n');

  expect(machineBelowFloors(loadOffice(office), installed)).toEqual([]);
});

test("sync deletes the fragment of a package office.yaml no longer lists, and leaves a file it didn't write, which check reports", async () => {
  demo(hostManifest);
  mode("host");
  write(join(office, ".office/mise/own.toml"), '[tools]\njq = "1.7.1"\n');
  write(join(office, "machine.toml"), '[tools]\njq = "1.7.1"\n');
  await sync(loadOffice(office));

  expect(machineFiles(loadOffice(office)).map((path) => path.slice(office.length + 1))).toEqual(["machine.packages.toml", ".office/mise/demo.toml", "machine.toml"]);
  expect(strayFragments(loadOffice(office))).toEqual([".office/mise/own.toml isn't a fragment office sync wrote, and .office/ is the tool's, so nothing links it; move its tools to machine.toml"]);

  write(join(office, "office.yaml"), "name: t\nopencode:\n  mode: host\n  url: http://127.0.0.1:49999\n");

  expect(orphanFragments(loadOffice(office), ["office"])).toEqual([".office/mise/demo.toml holds the mise setup of package demo, which office.yaml no longer lists (office sync deletes it)"]);

  const changes = await sync(loadOffice(office));

  expect(changes).toContain("deleted .office/mise/demo.toml, the mise setup of package demo, which office.yaml no longer lists");
  expect(changes).toContain("removed jq from machine.packages.toml, as no package declares it here any more");
  expect(existsSync(fragment())).toBe(false);
  expect(existsSync(join(office, ".office/mise/own.toml"))).toBe(true);
});

test("sync refuses to write a package's setup over a fragment it didn't write", async () => {
  demo(hostManifest);
  mode("host");
  write(fragment(), '[hooks]\npostinstall = "true"\n');

  expect(await sync(loadOffice(office))).toContain("FAILED package demo: .office/mise/demo.toml is not the fragment office sync writes for it, so its mise setup isn't written; rename that file");
  expect(readFileSync(fragment(), "utf8")).toBe('[hooks]\npostinstall = "true"\n');
});

const hostManifest = `settings:
  extra:
    description: Whether host offices get the demo install
    default: true
tools:
  jq: "1.7.1"
host:
  setting: extra
  tools:
    bun: "1.4.4"
  install:
    description: Demo
    creates: ~/.local/bin/demo
    script: scripts/install.ts
`;

/** office.yaml for an office in `mode`, listing demo with `settings`. */
function mode(which: "host" | "container", settings = ""): void {
  const opencode = which === "host" ? "opencode:\n  mode: host\n  url: http://127.0.0.1:49999\n" : "opencode: container\n";

  write(join(office, "office.yaml"), `name: t\n${opencode}packages:\n  - name: demo\n${settings}`);
}

const section = `[hooks]
# Demo, in ~/.local/bin/demo: installed by mise install on this host-mode office's machine when it is missing; it updates itself.
postinstall = "test -x \\"$HOME/.local/bin/demo\\" || bun \\"{{ config_source | canonicalize | dirname }}/../../packages/demo/scripts/install.ts\\""

[tasks."demo:install"]
description = "Install or repair Demo in ~/.local/bin/demo"
env = { OFFICE_ROOT = "{{ config_source | canonicalize | dirname }}/../.." }
run = "bun \\"$OFFICE_ROOT/packages/demo/scripts/install.ts\\""
`;

const setupHeader = `# The mise setup of package demo. office sync writes this file and rewrites it on every sync, so
# change nothing here; the package's tools are in machine.packages.toml at the office root. mise
# doesn't load this file where it is: in a host-mode office, office sync links it into mise's global
# conf.d, and the container links it inside itself, so it applies in every folder.
`;

test("a host-mode office with the switch on gets the host tools, and a fragment with only the install hook and its task; check looks for what it creates", async () => {
  demo(hostManifest);
  mode("host");

  const home = process.env.HOME;

  process.env.HOME = join(dir, "home");

  try {
    const changes = await sync(loadOffice(office));

    expect(changes).toContain("wrote packages/demo/.office.json (opencode: host)");
    expect(changes).toContain("wrote package demo's install of Demo to .office/mise/demo.toml: mise install installs it once, through the link (or mise run demo:install)");
    expect(readFileSync(fragment(), "utf8")).toBe(`${setupHeader}\n${section}`);
    expect(toolPins(readFileSync(fragment(), "utf8"))).toEqual([]);
    expect(lines()).toEqual(['"jq" = "1.7.1" # demo', '"bun" = "1.4.4" # demo']);
    expect(notes()).toEqual({ ok: false, notes: ["tools jq, bun in machine.packages.toml", "mise setup in .office/mise/demo.toml", "Demo is missing from ~/.local/bin/demo; office up installs it (or mise install, or mise run demo:install, once the office's tools are linked)"] });

    write(join(dir, "home/.local/bin/demo"), "");

    // The hook's test -x would run the script again, so check doesn't call it installed either.
    expect(notes().notes[2]).toBe("Demo is not an executable file in ~/.local/bin/demo; office up installs it (or mise install, or mise run demo:install, once the office's tools are linked)");

    chmodSync(join(dir, "home/.local/bin/demo"), 0o755);

    expect(notes()).toEqual({ ok: true, notes: ["tools jq, bun in machine.packages.toml", "mise setup in .office/mise/demo.toml", "Demo installed in ~/.local/bin/demo; it updates itself"] });
    expect(await sync(loadOffice(office))).toEqual([expect.stringMatching(/^not linking machine.toml, machine.packages.toml and .office\/mise\//)]);
  } finally {
    process.env.HOME = home;
  }
});

test("an install with executable: false creates a regular file: the hook tests -f, and check accepts a file that isn't executable", async () => {
  demo(hostManifest.replace("    script: scripts/install.ts\n", "    script: scripts/install.ts\n    executable: false\n").replace("~/.local/bin/demo", "~/.local/share/demo/init.zsh"));
  mode("host");

  const home = process.env.HOME;

  process.env.HOME = join(dir, "home");

  try {
    await sync(loadOffice(office));

    const text = readFileSync(fragment(), "utf8");

    expect(text).toContain("# Demo, in ~/.local/share/demo/init.zsh: installed by mise install on this host-mode office's machine when it is missing; mise run demo:install repairs or updates it.\n");
    expect(text).toContain('postinstall = "test -f \\"$HOME/.local/share/demo/init.zsh\\" || bun ');
    expect(notes().ok).toBe(false);

    // A folder in its place is no regular file, as test -f says too.
    mkdirSync(join(dir, "home/.local/share/demo/init.zsh"), { recursive: true });

    expect(notes().ok).toBe(false);

    rmSync(join(dir, "home/.local/share/demo/init.zsh"), { recursive: true });
    write(join(dir, "home/.local/share/demo/init.zsh"), "");

    expect(notes()).toEqual({ ok: true, notes: ["tools jq, bun in machine.packages.toml", "mise setup in .office/mise/demo.toml", "Demo installed in ~/.local/share/demo/init.zsh; mise run demo:install repairs or updates it"] });
  } finally {
    process.env.HOME = home;
  }
});

/** What package.yaml's schema says of a demo manifest. */
function manifestErrors(manifest: string): string[] {
  const result = check(v.safeParse(packageManifestSchema, Bun.YAML.parse(`name: demo\ndescription: A demo package.\n${manifest}`)));

  return result.ok ? [] : result.errors;
}

test("host.install.executable must be true or false, and host.setting must name a true/false setting", () => {
  expect(manifestErrors(hostManifest)).toEqual([]);
  expect(manifestErrors(hostManifest.replace("    script: scripts/install.ts\n", "    script: scripts/install.ts\n    executable: maybe\n"))).toEqual(["host.install.executable: must be true or false"]);
  expect(manifestErrors(hostManifest.replace("setting: extra", "setting: missing"))).toEqual(["host.setting: must name one of the package's settings whose default is true or false"]);
});

test("switching to container mode or turning the setting off removes the host tools and the fragment, and keeps the office's versions", async () => {
  demo(hostManifest);
  mode("host");
  await sync(loadOffice(office));
  setVersion("jq", "1.8.0");

  // Only the note that the office may not write outside its folder yet: nothing changed.
  expect(await sync(loadOffice(office))).toEqual([expect.stringMatching(/^not linking /)]);

  mode("container");

  const changes = await sync(loadOffice(office));

  expect(changes).toContain("removed bun from machine.packages.toml, as no package declares it here any more");
  expect(changes).toContain("removed package demo's install of Demo from .office/mise/demo.toml: the office runs OpenCode in its container (opencode: container)");
  expect(changes).toContain("deleted .office/mise/demo.toml, as package demo has no mise setup here");
  // Sync removes the folder it emptied, too.
  expect(existsSync(join(office, ".office/mise"))).toBe(false);
  expect(lines()).toEqual(['"jq" = "1.8.0" # demo']);
  expect(notes()).toEqual({ ok: true, notes: ["tools jq in machine.packages.toml", "Demo is host-mode only, so this container-mode office doesn't have it"] });

  mode("host");
  await sync(loadOffice(office));

  expect(readFileSync(fragment(), "utf8")).toBe(`${setupHeader}\n${section}`);
  expect(lines()).toEqual(['"jq" = "1.8.0" # demo', '"bun" = "1.4.4" # demo']);

  mode("host", "    settings:\n      extra: false\n");

  expect(await sync(loadOffice(office))).toContain("removed package demo's install of Demo from .office/mise/demo.toml: its extra setting is off");
  expect(existsSync(fragment())).toBe(false);
  expect(notes()).toEqual({ ok: true, notes: ["tools jq in machine.packages.toml"] });
});

test("check reports a fragment sync would rewrite", async () => {
  demo(hostManifest);
  mode("host");
  await sync(loadOffice(office));
  writeFileSync(fragment(), readFileSync(fragment(), "utf8").replace("|| bun", "|| echo"));

  expect(notes().notes).toContain(".office/mise/demo.toml lacks or differs from the package's host install or system setup; office sync rewrites it");
  expect(await sync(loadOffice(office))).toContain("wrote package demo's install of Demo to .office/mise/demo.toml: mise install installs it once, through the link (or mise run demo:install)");
});

test("an earlier release's fragments move their tools to machine.packages.toml, highest version first, once", async () => {
  demo('tools:\n  jq: "1.7.1"\n  bun: "1.4.4"\n');
  pkg("other", 'tools:\n  bun: "1.4.4"\n');
  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: demo\n  - name: other\n");
  await sync(loadOffice(office));

  const officeLines = packages().split("\n").filter((line) => line.endsWith("# office")).map((line) => line.replace(/ #.*$/, ""));

  rmSync(join(office, "machine.packages.toml"));
  // demo's fragment holds a bumped bun and its own comment; other's an older bun, and a system part after it.
  write(fragment(), '# The mise tools of package demo. office sync owns which tools are here.\n\n[tools]\n# ours\n"jq" = "1.7.1"\n"bun" = "1.5.0"\n');
  write(join(office, ".office/mise/other.toml"), '# The mise tools of package other. office sync owns which tools are here.\n\n[tools]\n"bun" = "1.4.4"\n\n# Its setup.\n[vars]\nx = "y"\n');
  write(join(office, ".office/mise/office.toml"), `# The mise tools of package office. office sync owns which tools are here.\n\n[tools]\n${officeLines.join("\n")}\n`);

  expect(oldToolFragments(loadOffice(office))).toEqual([
    ".office/mise/demo.toml holds its package's tools in a [tools] table, as earlier releases wrote it (office sync moves them to machine.packages.toml)",
    ".office/mise/office.toml holds its package's tools in a [tools] table, as earlier releases wrote it (office sync moves them to machine.packages.toml)",
    ".office/mise/other.toml holds its package's tools in a [tools] table, as earlier releases wrote it (office sync moves them to machine.packages.toml)",
  ]);

  const moved = moveFragmentTools(loadOffice(office));

  expect(moved).toEqual([
    expect.stringMatching(/^moved package office's tools \(sops .*\) from \.office\/mise\/office\.toml to machine\.packages\.toml, where office sync keeps every package's tools$/),
    "moved package demo's tools (jq 1.7.1, bun 1.5.0) from .office/mise/demo.toml to machine.packages.toml, where office sync keeps every package's tools",
    "moved package other's tools (bun 1.4.4) from .office/mise/other.toml to machine.packages.toml, where office sync keeps every package's tools",
    "deleted .office/mise/office.toml, which held only package office's tools",
    "deleted .office/mise/demo.toml, which held only package demo's tools",
    ".office/mise/other.toml now holds only package other's mise setup",
  ]);
  expect(lines()).toEqual(['"jq" = "1.7.1" # demo', '"bun" = "1.5.0" # demo, other']);
  expect(readFileSync(join(office, ".office/mise/other.toml"), "utf8")).toEndWith('so it applies in every folder.\n\n# Its setup.\n[vars]\nx = "y"\n');
  expect(moveFragmentTools(loadOffice(office))).toEqual([]);
  expect(oldToolFragments(loadOffice(office))).toEqual([]);

  // other declares no setup, so sync deletes what was left of its fragment.
  expect(await sync(loadOffice(office))).toEqual([
    "rewrote the comments of machine.packages.toml, which say who changes what in it and which packages need each tool",
    "deleted .office/mise/other.toml, as package other has no mise setup here",
  ]);
  expect(packages()).toContain("# Projected for container mode.");
  expect(await sync(loadOffice(office))).toEqual([]);
});

test("the move keeps a version the office bumped, and sync then raises one below a package's", async () => {
  demo('tools:\n  jq: "1.7.1"\n');
  await sync(loadOffice(office));
  rmSync(join(office, "machine.packages.toml"));
  write(fragment(), '# The mise tools of package demo. x\n\n[tools]\n"jq" = "1.6.0"\n');
  demo('tools:\n  jq: "1.7.1"\n  bun: "1.4.4"\n');

  const changes = await sync(loadOffice(office));

  expect(changes).toContain("raised jq from 1.6.0 to 1.7.1 in machine.packages.toml: package demo needs at least 1.7.1");
  expect(changes).toContain("added bun 1.4.4 to machine.packages.toml, which package demo declares");
  expect(lines()).toEqual(['"jq" = "1.7.1" # demo', '"bun" = "1.4.4" # demo']);
  expect(existsSync(fragment())).toBe(false);
});

test("the required office package, which office.yaml never lists, gets its tools like any package; .office.json is the office's record, so the pulled-in package isn't edited", async () => {
  write(join(office, "office.yaml"), "name: t\n");

  expect(await sync(loadOffice(office))).toEqual(expect.arrayContaining([expect.stringMatching(/^created machine\.packages\.toml, the packages' tools: sops \S+, age \S+, gh \S+, pre-commit \S+$/)]));
  expect(toolPins(packages()).map((pin) => pin.tool)).toEqual(["sops", "age", "gh", "pre-commit"]);
  expect(orphanFragments(loadOffice(office), ["office"])).toEqual([]);

  const dir = pulledDir(loadOffice(office), "office");
  const record = readRecord(dir);

  expect(JSON.parse(readFileSync(join(dir, ".office.json"), "utf8"))).toEqual({ opencode: "container" });
  expect(record !== undefined && localEdits(dir, record)).toEqual([]);
});

test("setup requirements share a floor with external manifests; failed collection retains machine outputs", async () => {
  pkg("external", 'tools: {bun: "1.5.0"}');
  const author = join(office, "packages/author/office.ts");

  const code = `import { requirements } from "@office/tooling/requirements";
  export default { name: "author", description: "Uses Bun", settings:{ floor:{ description:"Tool floor",default:"1.4.4" } }, setup(ctx) {
    ctx.add(requirements, {name:"bun", minimumVersion:ctx.settings.floor});
  }};`;

  const run = () => sync(loadOffice(office), { scope: "packages" });
  // From source, a local package resolves its @office imports through the published set.
  write(join(office, "office.yaml"), "name: t\npackages: [{name: external}]\n");
  await run();
  writePackage(author, code, { dependencies: ["tooling"] });
  write(join(office, "office.yaml"), "name: t\npackages: [{name: external}, {name: author}]\n");
  expect((await run()).join("\n")).not.toContain("FAILED");
  expect(lines()).toEqual(['"bun" = "1.5.0" # author, external']);
  const good = packages();
  write(join(office, "office.yaml"), "name: t\npackages: [{name: external}, {name: author, settings: {floor: not-a-floor}}]\n");
  expect((await run()).join("\n")).toContain("invalid exact tool requirement");
  expect(packages()).toBe(good);
});

test("exclusive install roots are independent of task and readiness names", async () => {
  const config = join(office, "office.yaml");

  const host = "name: t\nopencode: {mode: host, url: 'http://127.0.0.1:49999'}\n";
  const run = () => sync(loadOffice(office), { scope: "packages" });

  for (const name of ["first", "second"]) {
    writePackage(join(office, `packages/${name}/office.ts`), `import { installs } from "@office/mise-integration/claims";
    export default {name:"${name}", description:"Install", setup(ctx){
      ctx.add(installs,{name:"${name}", description:"Install", script:"run.ts", destination:"~/.local/share/release", ready:"~/.local/share/${name}.json", executable:false});
    }}`, { dependencies: ["mise-integration"] });
    write(join(office, `packages/${name}/run.ts`), 'throw Error("setup must not execute me")');
  }

  // From source, a local package resolves its @office imports through the published set.
  write(config, `${host}packages: []\n`);
  await run();
  write(config, `${host}packages: [{name: first}]\n`);
  expect((await run()).join("\n")).not.toContain("FAILED");
  const first = join(office, ".office/mise/first.toml");
  const before = readFileSync(first, "utf8");
  expect(before).toContain('[tasks."first:first"]');
  write(config, `${host}packages: [{name: first}, {name: second}]\n`);
  expect((await run()).join("\n")).toContain("~/.local/share/release claimed by both package first and package second");
  expect(readFileSync(first, "utf8")).toBe(before);
  expect(existsSync(join(office, ".office/mise/second.toml"))).toBe(false);
});

test("a rejected publication cannot retain host consent or a deselected plugin", async () => {
  const config = join(office, "office.yaml");
  const writeConfig = (mode: string, selected: string) => write(config, `name: test\nopencode: ${mode}\npackages: [{name: browser}, {name: first}, {name: ${selected}}]\n`);

  const run = () => sync(loadOffice(office), { scope: "packages" });

  for (const name of ["first", "second"]) {
    writePackage(join(office, `packages/${name}/office.ts`), `import {repositories} from "@office/references/repositories";
    export default {name:"${name}",description:"Reference",setup(c){
      c.add(repositories,{name:"guide",url:"https://example.invalid/guide"})
    }}`, { dependencies: ["references"] });
  }

  // From source, a local package resolves its @office imports through the published set.
  write(config, "name: test\npackages: []\n");
  await run();

  pkg("editor", "");
  write(join(office, "packages/editor/plugin/index.ts"), "// fixture");
  writeConfig("{mode: host, url: 'http://127.0.0.1:49999'}", "editor");
  grantConsent(loadOffice(office));
  expect((await run()).join("\n")).not.toContain("FAILED");
  const link = join(globalConfD(), "office-test-1-browser.toml");
  const plugin = join(office, ".opencode/plugins/editor");
  const generation = join(office, ".office/resolved/references.json");
  const before = readFileSync(generation);
  expect(readFileSync(link, "utf8")).toContain("postinstall =");
  expect(existsSync(plugin)).toBe(true);
  writeConfig("container", "second");
  expect((await run()).join("\n")).toContain("claimed by both");
  expect(readFileSync(generation)).toEqual(before);
  expect(existsSync(machineRecordPath())).toBe(false);
  expect(existsSync(link)).toBe(false);
  expect(existsSync(plugin)).toBe(false);
  expect(packages()).not.toContain("# Projected for container mode.");
});

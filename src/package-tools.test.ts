import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { sync } from "./commands/sync.ts";
import { installedPackages } from "./layout.ts";
import { toolPins } from "./mise-toml.ts";
import { loadOffice } from "./office.ts";
import { localEdits, pulledDir, readRecord } from "./packages.ts";
import { fragmentFiles, fragmentNotes, orphanFragments, updateFragment } from "./package-tools.ts";

let dir: string;

let office: string;

const miseState = process.env.MISE_STATE_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-package-tools-"));
  office = join(dir, "office");
  // Sync trusts a fragment with a hook through this machine's mise: keep that out of its real state.
  process.env.MISE_STATE_DIR = join(dir, "mise-state");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });

  if (miseState === undefined) delete process.env.MISE_STATE_DIR;
  else process.env.MISE_STATE_DIR = miseState;
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A local package `demo` declaring `tools`, listed in office.yaml. */
function demo(tools: string): void {
  write(join(office, "packages/demo/package.yaml"), `name: demo\ndescription: A demo package.\n${tools}`);
  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: demo\n");
}

const fragment = () => join(office, ".mise/conf.d/demo.toml");

/** What `office check` says of demo's tools. */
function notes() {
  const loaded = loadOffice(office);
  const item = installedPackages(loaded).installed.find((candidate) => candidate.entry.name === "demo");

  if (item === undefined) throw new Error("demo isn't installed");

  return fragmentNotes(loaded, item);
}

test("sync writes a package's tools to its fragment at the package's versions, naming the package", async () => {
  demo('tools:\n  "npm:agent-browser": "0.43.0"\n  jq: "1.7.1"\n');

  const changes = await sync(loadOffice(office));

  expect(changes).toContain("created .mise/conf.d/demo.toml with package demo's tools: npm:agent-browser 0.43.0, jq 1.7.1");

  const text = readFileSync(fragment(), "utf8");

  expect(text.split("\n")[0]).toStartWith("# The mise tools of package demo.");
  expect(text).toEndWith('[tools]\n"npm:agent-browser" = "0.43.0"\n"jq" = "1.7.1"\n');
  expect(notes()).toEqual({ ok: true, notes: ["tools npm:agent-browser, jq in .mise/conf.d/demo.toml"] });
  expect(await sync(loadOffice(office))).not.toContain(expect.stringContaining(".mise"));
});

test("sync keeps a version the office changed, and check doesn't count it as drift", async () => {
  demo('tools:\n  "npm:agent-browser": "0.43.0"\n');
  await sync(loadOffice(office));

  const bumped = readFileSync(fragment(), "utf8").replace('"0.43.0"', '"0.44.1" # bumped by upgrade-tools');

  writeFileSync(fragment(), bumped);

  const changes = await sync(loadOffice(office));

  expect(changes.filter((change) => change.includes(".mise"))).toEqual([]);
  expect(readFileSync(fragment(), "utf8")).toBe(bumped);
  expect(notes().ok).toBe(true);
});

test("sync removes a tool the package no longer declares and adds a new one, keeping the rest", async () => {
  demo('tools:\n  "npm:agent-browser": "0.43.0"\n  jq: "1.7.1"\n');
  await sync(loadOffice(office));
  writeFileSync(fragment(), readFileSync(fragment(), "utf8").replace('"1.7.1"', '"1.8.0"'));
  demo('tools:\n  jq: "1.7.1"\n  "npm:oxlint": "1.93.0"\n');

  expect(notes()).toEqual({
    ok: false,
    notes: ["tools jq in .mise/conf.d/demo.toml", ".mise/conf.d/demo.toml lacks npm:oxlint; office sync adds it", ".mise/conf.d/demo.toml holds npm:agent-browser, which the package no longer declares here; office sync removes it"],
  });

  const changes = await sync(loadOffice(office));

  expect(changes).toContain("added npm:oxlint 1.93.0 to .mise/conf.d/demo.toml, which package demo declares");
  expect(changes).toContain("removed npm:agent-browser from .mise/conf.d/demo.toml, as package demo no longer declares it here");
  expect(readFileSync(fragment(), "utf8")).toEndWith('[tools]\n"jq" = "1.8.0"\n"npm:oxlint" = "1.93.0"\n');
  expect(notes().ok).toBe(true);
});

test("check reports a declared tool missing from the fragment", async () => {
  demo('tools:\n  "npm:agent-browser": "0.43.0"\n');

  expect(notes()).toEqual({ ok: false, notes: ["tools npm:agent-browser are missing: .mise/conf.d/demo.toml doesn't exist; office sync writes it"] });

  await sync(loadOffice(office));
  writeFileSync(fragment(), readFileSync(fragment(), "utf8").replace(/^"npm:agent-browser".*\n/m, ""));

  expect(notes()).toEqual({ ok: false, notes: ["tools none in .mise/conf.d/demo.toml", ".mise/conf.d/demo.toml lacks npm:agent-browser; office sync adds it"] });
});

test("sync deletes the fragment when the package leaves office.yaml or declares no tools, and leaves the office's own fragments alone", async () => {
  demo('tools:\n  "npm:agent-browser": "0.43.0"\n');
  write(join(office, ".mise/conf.d/own.toml"), '[tools]\njq = "1.7.1"\n');
  await sync(loadOffice(office));

  expect(fragmentFiles(loadOffice(office)).map((path) => path.slice(office.length + 1))).toEqual([".mise/conf.d/demo.toml", ".mise/conf.d/own.toml"]);

  write(join(office, "office.yaml"), "name: t\n");

  expect(orphanFragments(loadOffice(office), [])).toEqual([".mise/conf.d/demo.toml holds the tools of package demo, which office.yaml no longer lists (office sync deletes it)"]);
  expect(await sync(loadOffice(office))).toContain("deleted .mise/conf.d/demo.toml, the tools of package demo, which office.yaml no longer lists");
  expect(existsSync(fragment())).toBe(false);
  expect(existsSync(join(office, ".mise/conf.d/own.toml"))).toBe(true);

  rmSync(join(office, ".mise"), { recursive: true });
  demo('tools:\n  "npm:agent-browser": "0.43.0"\n');
  await sync(loadOffice(office));
  demo("");

  expect(await sync(loadOffice(office))).toContain("deleted .mise/conf.d/demo.toml, as package demo declares no tools");
  expect(existsSync(join(office, ".mise"))).toBe(false);
});

test("sync refuses to write a package's tools over a fragment it didn't write", async () => {
  demo('tools:\n  "npm:agent-browser": "0.43.0"\n');
  write(fragment(), '[tools]\njq = "1.7.1"\n');

  expect(await sync(loadOffice(office))).toContain("FAILED package demo: .mise/conf.d/demo.toml is not the fragment office sync writes for it, so its tools aren't written; rename that file");
  expect(readFileSync(fragment(), "utf8")).toBe('[tools]\njq = "1.7.1"\n');
});

test("a fragment whose [tools] table was removed gets one back", () => {
  expect(updateFragment("# The mise tools of package demo. x\n", "demo", { jq: "1.7.1" }).text).toEndWith('office sync\'s, rewritten on every sync.\n[tools]\n"jq" = "1.7.1"\n');
});

test("sync rewrites an earlier release's header, keeping the office's versions and comments below it", async () => {
  demo('tools:\n  jq: "1.7.1"\n');
  write(fragment(), '# The mise tools of package demo. office sync adds a tool the package declares, at the version\n# it starts at.\n\n[tools]\n# ours\n"jq" = "1.8.0"\n');

  expect(await sync(loadOffice(office))).toContain("rewrote the header comment of .mise/conf.d/demo.toml, which says who changes what in it");

  const text = readFileSync(fragment(), "utf8");

  expect(text).toStartWith("# The mise tools of package demo. office sync owns which tools are here");
  expect(text).toEndWith('\n\n[tools]\n# ours\n"jq" = "1.8.0"\n');
  expect(await sync(loadOffice(office))).not.toContain(expect.stringContaining(".mise"));
});

test("package.yaml's tools take exact versions only", async () => {
  demo('tools:\n  jq: latest\n  node: "26"\n');

  expect(await sync(loadOffice(office))).toEqual(
    expect.arrayContaining(["FAILED package demo: packages/demo/package.yaml: tools.jq: must be an exact version such as 0.43.0", "FAILED package demo: packages/demo/package.yaml: tools.node: must be an exact version such as 0.43.0"]),
  );
  expect(existsSync(fragment())).toBe(false);
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
# Demo, in ~/.local/bin/demo: installed by mise install in this host-mode office when it is missing; it updates itself.
postinstall = "test -x \\"$HOME/.local/bin/demo\\" || bun \\"{{ config_source | canonicalize | dirname }}/../../packages/demo/scripts/install.ts\\""

[tasks."demo:install"]
description = "Install or repair Demo in ~/.local/bin/demo"
env = { OFFICE_ROOT = "{{ config_source | canonicalize | dirname }}/../.." }
run = "bun \\"$OFFICE_ROOT/packages/demo/scripts/install.ts\\""
`;

test("a host-mode office with the switch on gets the host tools, the install hook and its task, and check looks for what it creates", async () => {
  demo(hostManifest);
  mode("host");

  const home = process.env.HOME;

  process.env.HOME = join(dir, "home");

  try {
    const changes = await sync(loadOffice(office));

    expect(changes).toContain("wrote packages/demo/.office.json (opencode: host)");
    expect(changes).toContain("wrote package demo's install of Demo to .mise/conf.d/demo.toml: mise install in the office installs it once (or mise run demo:install)");
    expect(changes).toContain("trusted .mise/conf.d/demo.toml with this machine's mise, which runs and loads a fragment's hook only once it is trusted");
    expect(readdirSync(join(dir, "mise-state/trusted-configs")).length).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(join(office, "packages/demo/.office.json"), "utf8"))).toEqual({ opencode: "host" });
    expect(readFileSync(fragment(), "utf8")).toEndWith(`[tools]\n"jq" = "1.7.1"\n"bun" = "1.4.4"\n\n${section}`);
    expect(toolPins(readFileSync(fragment(), "utf8")).map((pin) => pin.tool)).toEqual(["jq", "bun"]);
    expect(notes()).toEqual({ ok: false, notes: ["tools jq, bun in .mise/conf.d/demo.toml", "Demo is missing from ~/.local/bin/demo; mise install in the office installs it (or mise run demo:install)"] });

    write(join(dir, "home/.local/bin/demo"), "");

    expect(notes()).toEqual({ ok: true, notes: ["tools jq, bun in .mise/conf.d/demo.toml", "Demo installed in ~/.local/bin/demo; it updates itself"] });
    expect(await sync(loadOffice(office))).toEqual([]);
  } finally {
    process.env.HOME = home;
  }
});

test("switching to container mode or turning the setting off removes the host part and keeps the office's versions", async () => {
  demo(hostManifest);
  mode("host");
  await sync(loadOffice(office));
  writeFileSync(fragment(), readFileSync(fragment(), "utf8").replace('"jq" = "1.7.1"', '"jq" = "1.8.0"'));

  expect(await sync(loadOffice(office))).toEqual([]);

  mode("container");

  const changes = await sync(loadOffice(office));

  expect(changes).toContain("removed bun from .mise/conf.d/demo.toml, as package demo no longer declares it here");
  expect(changes).toContain("removed package demo's install of Demo from .mise/conf.d/demo.toml: the office runs OpenCode in its container (opencode: container)");
  expect(readFileSync(fragment(), "utf8")).toEndWith('[tools]\n"jq" = "1.8.0"\n');
  expect(notes()).toEqual({ ok: true, notes: ["tools jq in .mise/conf.d/demo.toml", "Demo is host-mode only, so this container-mode office doesn't have it"] });

  mode("host");
  await sync(loadOffice(office));

  expect(readFileSync(fragment(), "utf8")).toEndWith(`[tools]\n"jq" = "1.8.0"\n"bun" = "1.4.4"\n\n${section}`);

  mode("host", "    settings:\n      extra: false\n");

  expect(await sync(loadOffice(office))).toContain("removed package demo's install of Demo from .mise/conf.d/demo.toml: its extra setting is off");
  expect(readFileSync(fragment(), "utf8")).toEndWith('[tools]\n"jq" = "1.8.0"\n');
  expect(notes()).toEqual({ ok: true, notes: ["tools jq in .mise/conf.d/demo.toml"] });
});

test("check reports a host part sync would rewrite, and removing the package deletes the fragment with it", async () => {
  demo(hostManifest);
  mode("host");
  await sync(loadOffice(office));
  writeFileSync(fragment(), readFileSync(fragment(), "utf8").replace("|| bun", "|| echo"));

  expect(notes().notes).toContain(".mise/conf.d/demo.toml lacks or differs from the package's host install; office sync rewrites it");

  write(join(office, "office.yaml"), "name: t\nopencode:\n  mode: host\n  url: http://127.0.0.1:49999\n");

  expect(await sync(loadOffice(office))).toContain("deleted .mise/conf.d/demo.toml, the tools of package demo, which office.yaml no longer lists");
  expect(existsSync(join(office, ".mise"))).toBe(false);
});

test("host: setting must name a true/false setting", async () => {
  demo(hostManifest.replace("setting: extra", "setting: missing"));
  mode("host");

  expect(await sync(loadOffice(office))).toContain("FAILED package demo: packages/demo/package.yaml: host.setting: must name one of the package's settings whose default is true or false");
});

test(".office.json is the office's record, so a pulled-in package with it isn't edited", async () => {
  write(join(office, "office.yaml"), "name: t\n");
  await sync(loadOffice(office));

  const dir = pulledDir(loadOffice(office), "office");
  const record = readRecord(dir);

  expect(JSON.parse(readFileSync(join(dir, ".office.json"), "utf8"))).toEqual({ opencode: "container" });
  expect(record !== undefined && localEdits(dir, record)).toEqual([]);
});

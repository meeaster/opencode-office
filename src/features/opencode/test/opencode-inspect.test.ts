import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { configDirVariable, installPanel, locate, panelsDirVariable } from "../desktop.ts";
import { inspect } from "../inspect.ts";
import { packageJsonText, writePackage } from "../../../../test/support/test-package.ts";

let root: string;
const saved = { config: process.env[configDirVariable], panels: process.env[panelsDirVariable] };

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "office-inspect-")));
  process.env[configDirVariable] = join(root, "app");
  process.env[panelsDirVariable] = join(root, "panels");
});

afterEach(() => {
  for (const [name, value] of [[configDirVariable, saved.config], [panelsDirVariable, saved.panels]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  rmSync(root, { recursive: true, force: true });
});

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

test("inspect lists a desktop panel only by this office's own record, and a bundle that isn't a regular file as missing", () => {
  const office = join(root, "office");
  const bundle = join(office, "packages/common/gui/dist/gui-experimental.cjs");
  write(join(office, "office.yaml"), "name: sample\npackages: [{name: common}]\n");
  writePackage(join(office, "packages/common/package.yaml"), "# Inspect fixture\n{}\n");
  write(bundle, "module.exports = {}");
  const where = locate();

  if (where.kind !== "app") throw new Error("the app machine variables should locate a local app machine");
  installPanel(where.machine, { name: "sample", dir: office }, { name: "common", bundle });
  const desktop = () => inspect(office, undefined).filter(line => line.startsWith("desktop: "));
  // No sync recorded the package declaring it, so it is only retained.
  expect(desktop()).toEqual(["desktop: retained panel, not declared by its package (bundle present; listed in app-machine opencode.json)"]);

  // A record that is a link, or another office's record, is not this office's panel.
  const record = join(root, "panels/common/office-panel.json");
  const backup = `${record}.original`;
  renameSync(record, backup);
  symlinkSync(backup, record);
  expect(desktop()).toEqual(["desktop: no panel installation recorded here for this office"]);
  rmSync(record);
  write(record, readFileSync(backup, "utf8").replace('"sample"', '"another-office"'));
  expect(desktop()).toEqual(["desktop: no panel installation recorded here for this office"]);
  renameSync(backup, record);

  const installed = join(root, "panels/common/gui-experimental.cjs");
  rmSync(installed);
  mkdirSync(installed);
  expect(desktop()).toEqual(["desktop: retained panel, not declared by its package (bundle missing or not a regular file; listed in app-machine opencode.json)"]);
});

test("inspect names a package's OpenCode registration at the definition its package.json declares", () => {
  const office = join(root, "office");
  write(join(office, "office.yaml"), "name: sample\npackages: [{name: common}]\n");
  write(join(office, "packages/common/src/definition.ts"), 'throw new Error("inspect must not import the definition")');
  write(join(office, "packages/common/package.json"), packageJsonText("common", "src/definition.ts"));
  write(join(office, ".office/resolved/opencode-assets.json"), JSON.stringify({ common: { state: "unavailable" } }));

  expect(inspect(office, undefined)).toContain("[office] OpenCode registration unavailable at last sync: packages/common/src/definition.ts#setup");
});

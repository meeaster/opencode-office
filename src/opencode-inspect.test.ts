import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { configDirVariable, installPanel, locate, panelsDirVariable } from "./desktop.ts";
import { inspect } from "../standard/opencode/inspect.ts";

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
  write(join(office, "packages/common/package.yaml"), "name: common\ndescription: Inspect fixture\n");
  write(bundle, "module.exports = {}");
  const where = locate();

  if (where.kind !== "app") throw new Error("the app machine variables should locate a local app machine");
  installPanel(where.machine, { name: "sample", dir: office }, { name: "common", bundle });
  const desktop = () => inspect(office, undefined).filter(line => line.startsWith("desktop: "));
  expect(desktop()).toEqual(["desktop: common (bundle present; listed in app-machine opencode.json)"]);

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
  expect(desktop()).toEqual(["desktop: common (bundle missing or not a regular file; listed in app-machine opencode.json)"]);
});

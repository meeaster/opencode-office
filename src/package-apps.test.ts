import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { appFolders } from "./commands/apps.ts";
import { sync } from "./commands/sync.ts";
import { loadOffice } from "./office.ts";
import { writePackage } from "./test-package.ts";

let dir: string;

let office: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-package-apps-"));
  office = join(dir, "office");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const manifest = "namespace: widget\nsettings: {type: object, additionalProperties: false, properties: {app: {type: boolean, default: false}}}\nexecutor_app:\n  setting: app\n";

/** A local package `demo` shipping an Executor app, listed in office.yaml with `entry` appended. */
function demo(entry = "", packageYaml = manifest): void {
  writePackage(join(office, "packages/demo/package.yaml"), packageYaml);
  write(join(office, "packages/demo/executor-app/package.json"), '{ "dependencies": { "apps": "0.0.1" } }\n');
  write(join(office, "office.yaml"), `name: t\ndesks: { work: { app: false } }\npackages:\n  - name: demo\n${entry}`);
}

test("a package's Executor app is deployed under its namespace only while its setting is on", async () => {
  demo();
  await sync(loadOffice(office));

  expect(appFolders(loadOffice(office)).filter((folder) => folder.fromPackage !== undefined)).toEqual([]);

  demo("    settings:\n      app: true\n");
  await sync(loadOffice(office));

  const [folder] = appFolders(loadOffice(office)).filter((candidate) => candidate.fromPackage !== undefined);

  expect(folder?.slug).toBe("widget");
  expect(folder?.dir).toBe(join(office, "packages/demo/executor-app"));
  expect(folder?.adopted).toBe(false);
});

test("a package's app can't share a slug with one of the office's own", async () => {
  demo("    settings:\n      app: true\n");
  await sync(loadOffice(office));
  write(join(office, "executor-apps/widget/package.json"), "{}\n");

  expect(() => appFolders(loadOffice(office))).toThrow("packages/demo/executor-app and executor-apps/widget both deploy the Executor app widget; rename one of them");
});

test("executor_app.setting must name a true/false setting", async () => {
  demo("", manifest.replace("setting: app", "setting: missing"));

  expect(await sync(loadOffice(office))).toContain("FAILED package demo: packages/demo/package.yaml: executor_app.setting: must name one of the package's settings declared type: boolean");
});

// The inventory, read from files only: the office's root apps and the folders packages contribute,
// rejected before any request when a contribution leaves its package, lacks package.json, or
// shares a slug.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Entry } from "@office/sdk";
import type { App } from "../apps.ts";
import { appFolders } from "../inventory.ts";
import { recordContributed, sessionText } from "../session.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-executor-inventory-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Package `demo`'s contribution of `directory`, as office attaches it: namespace `widget` and its settings. */
const contribution = (directory = "executor-app"): Entry<App> => ({
  value: { directory }, owner: "demo", namespace: "widget", settings: { app: true },
  folder: join(dir, "packages/demo"), root: join(dir, "packages/demo"),
});

test("the office's apps are root executor-apps/<slug>/ by folder name, beside contributed ones under their package's namespace and settings; an app in a top-level folder's executor-apps/ is not the office's", () => {
  for (const slug of ["assistant", "builder"]) write(join(dir, `executor-apps/${slug}/package.json`), "{}\n");
  write(join(dir, "executor-apps/notes/README.md"), "no package.json: not an app\n");
  write(join(dir, "work/executor-apps/stale/package.json"), "{}\n");
  write(join(dir, "packages/demo/executor-app/package.json"), "{}\n");

  expect(appFolders(dir, [], [contribution()]).map(({ slug, where, contributor }) => [slug, where, contributor])).toEqual([
    ["assistant", "executor-apps/assistant", undefined],
    ["builder", "executor-apps/builder", undefined],
    ["widget", "packages/demo/executor-app", { name: "demo", settings: { app: true } }],
  ]);
});

test("a contributed app can't share a slug with one of the office's own, and two sources are both named", () => {
  write(join(dir, "packages/demo/executor-app/package.json"), "{}\n");
  write(join(dir, "executor-apps/widget/package.json"), "{}\n");

  expect(() => appFolders(dir, [], [contribution()])).toThrow("packages/demo/executor-app and executor-apps/widget both deploy the Executor app widget; rename one of them");
});

test("a contribution outside its package, through a path or a link, or without package.json names the package and the path", () => {
  write(join(dir, "packages/elsewhere/package.json"), "{}\n");
  expect(() => appFolders(dir, [], [contribution("../elsewhere")])).toThrow("package demo: its Executor app ../elsewhere is outside the package");
  expect(() => appFolders(dir, [], [contribution(join(dir, "packages/elsewhere"))])).toThrow("is outside the package");

  mkdirSync(join(dir, "packages/demo"), { recursive: true });
  symlinkSync(join(dir, "packages/elsewhere"), join(dir, "packages/demo/linked"));
  expect(() => appFolders(dir, [], [contribution("linked")])).toThrow("package demo: its Executor app linked is outside the package");

  expect(() => appFolders(dir, [], [contribution("missing")])).toThrow("package demo: its Executor app missing has no package.json");
});

test("an adoption marker needs its folder's catalog ID, listed in catalog_apps", () => {
  write(join(dir, "executor-apps/github/package.json"), "{}\n");
  write(join(dir, "executor-apps/github/.office-catalog"), "github\n");

  expect(appFolders(dir, ["github"], []).map(folder => folder.adopted)).toEqual([true]);
  expect(() => appFolders(dir, [], [])).toThrow("an adopted Executor app must be in executor-apps/<catalog-id> and listed in the executor package's catalog_apps setting");
});

test("a session lists the office's apps as they are now, the contributed apps the last sync recorded inside their package with a package.json, and catalog-only apps", () => {
  expect(sessionText(dir, [])).toBe("");

  write(join(dir, "executor-apps/assistant/package.json"), '{"description":"Briefs and reports."}');
  write(join(dir, "packages/demo/executor-app/package.json"), '{"executor":{"title":"Widget"}}');
  write(join(dir, "packages/elsewhere/package.json"), '{"description":"Not the package\'s."}');
  recordContributed(dir, [contribution(), { ...contribution("../elsewhere"), namespace: "outside" }, { ...contribution("missing"), namespace: "unfinished" }]);

  expect(sessionText(dir, ["github", "assistant"]).split("\n").filter(line => line.startsWith("- "))).toEqual([
    "- `github` (catalog)",
    "- `executor-apps/assistant/`: Briefs and reports.",
    "- `widget` (package demo): Widget",
  ]);
});

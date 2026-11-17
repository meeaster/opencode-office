import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { sync } from "./commands/sync.ts";
import { git } from "./git.ts";
import { loadOffice } from "./office.ts";
import { fetchPackage, installPackage, readPackage } from "./packages.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-packages-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const manifest = "name: demo\ndescription: A demo package.\nsettings:\n  url:\n    description: Where it publishes\n    required: true\n  title:\n    description: The index title\n    default: Shared\n";

test("settings the package doesn't declare, and required ones left out, are named; defaults fill the rest", () => {
  const office = join(dir, "office");

  write(join(office, "packages/demo/package.yaml"), manifest);
  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: demo\n    settings:\n      colour: blue\n");

  const invalid = readPackage(loadOffice(office), loadOffice(office).packages[0]);

  expect(invalid).toEqual({
    ok: false,
    errors: ["settings.colour: demo has no such setting (it accepts url, title); remove it from the entry in office.yaml", "settings.url is required; add it to the entry in office.yaml: Where it publishes"],
  });

  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: demo\n    settings:\n      url: https://example.com/site\n");

  const valid = readPackage(loadOffice(office), loadOffice(office).packages[0]);

  expect(valid.ok && valid.value.settings).toEqual({ url: "https://example.com/site", title: "Shared" });
});

test("an install ignores the source office's records, and an update by full commit SHA replaces the package, refuses over local edits, and leaves template copies alone", () => {
  const repo = join(dir, "repo");
  const office = join(dir, "office");

  const commit = (message: string) => {
    git(["add", "-A"], repo);
    git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", message], repo);

    return git(["rev-parse", "HEAD"], repo);
  };

  write(join(repo, "pkgs/demo/package.yaml"), manifest);
  write(join(repo, "pkgs/demo/scripts/run.sh"), "echo one\n");
  write(join(repo, "pkgs/demo/template/out/AGENTS.md"), "from the package\n");
  // Committed by the office that authored the package, as when sharing from its packages/.
  write(join(repo, "pkgs/demo/.template.json"), '["out/AGENTS.md"]\n');
  write(join(repo, "pkgs/demo/.settings.json"), '{"url":"https://example.com","title":"Shared"}\n');
  git(["init", "--quiet", repo]);

  const first = commit("one");

  write(join(repo, "pkgs/demo/scripts/run.sh"), "echo two\n");

  const second = commit("two");
  const entry = (ref: string) => `name: t\npackages:\n  - name: demo\n    repo: ${repo}\n    path: pkgs/demo\n    ref: ${ref}\n    settings: { url: https://example.com }\n`;

  write(join(office, "office.yaml"), entry(first));

  let loaded = loadOffice(office);

  expect(fetchPackage(loaded, "demo", { repo, path: "pkgs/demo", ref: first })).toEqual([`installed packages/demo from ${repo} at ${first}`]);

  const installed = readPackage(loaded, loaded.packages[0]);

  if (!installed.ok) throw new Error(installed.errors.join("\n"));

  expect(installPackage(loaded, installed.value)).toEqual(["wrote packages/demo/.settings.json", "created out/AGENTS.md from package demo"]);
  write(join(office, "out/AGENTS.md"), "the office's own\n");
  write(join(office, "packages/demo/scripts/run.sh"), "echo edited\n");
  write(join(office, "office.yaml"), entry(second));
  loaded = loadOffice(office);

  const [refusal] = fetchPackage(loaded, "demo", { repo, path: "pkgs/demo", ref: second });

  expect(refusal).toStartWith(`FAILED packages/demo: not updated to ${second}, because package files differ from the copy of ${first}: scripts/run.sh (edited).`);
  expect(readFileSync(join(office, "packages/demo/scripts/run.sh"), "utf8")).toBe("echo edited\n");

  write(join(office, "packages/demo/scripts/run.sh"), "echo one\n");
  expect(fetchPackage(loaded, "demo", { repo, path: "pkgs/demo", ref: second })).toEqual([`updated packages/demo from ${first} to ${second} (${second})`]);
  expect(readFileSync(join(office, "packages/demo/scripts/run.sh"), "utf8")).toBe("echo two\n");

  const updated = readPackage(loaded, loaded.packages[0]);

  if (!updated.ok) throw new Error(updated.errors.join("\n"));

  expect(installPackage(loaded, updated.value)).toEqual([]);
  expect(readFileSync(join(office, "out/AGENTS.md"), "utf8")).toBe("the office's own\n");
});

test("a package plugin is linked while declared, gives way to a plugins: entry of its name without git running through the link, and is unlinked when the entry goes", async () => {
  const office = join(dir, "office");
  const cloned = join(dir, "cloned");
  const link = join(office, ".opencode/plugins/demo");
  const declared = "name: t\npackages:\n  - name: demo\n";

  write(join(office, "packages/demo/package.yaml"), "name: demo\ndescription: A demo package.\n");
  write(join(office, "packages/demo/plugin/index.ts"), "export default { id: \"demo\", async setup() {} };\n");
  write(join(office, "office.yaml"), declared);
  git(["init", "--quiet", office]);

  expect(await sync(loadOffice(office))).toContain("linked .opencode/plugins/demo");
  expect(readlinkSync(link)).toBe("../../packages/demo/plugin");

  write(join(cloned, "index.ts"), "export default { id: \"cloned\", async setup() {} };\n");
  git(["init", "--quiet", cloned]);
  git(["add", "-A"], cloned);
  git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "plugin"], cloned);
  write(join(office, "office.yaml"), `${declared}plugins:\n  - name: demo\n    repo: ${cloned}\n`);

  const changes = await sync(loadOffice(office));

  expect(changes).toContain("cloned plugin .opencode/plugins/demo");
  expect(changes).toContain("FAILED package demo: its plugin would be .opencode/plugins/demo, where the plugins: entry demo is cloned, so it isn't linked; rename one of them");
  expect(git(["rev-parse", "--show-toplevel"], link)).toBe(realpathSync(link));

  rmSync(link, { recursive: true });
  write(join(office, "office.yaml"), declared);
  await sync(loadOffice(office));
  write(join(office, "office.yaml"), "name: t\n");

  expect(await sync(loadOffice(office))).toContain("unlinked .opencode/plugins/demo");
  expect(existsSync(link)).toBe(false);
});

test("a template file is copied once: one the office deletes stays deleted, one already there is kept, and one the package adds later is created", () => {
  const office = join(dir, "office");

  const install = () => {
    const loaded = loadOffice(office);
    const read = readPackage(loaded, loaded.packages[0]);

    if (!read.ok) throw new Error(read.errors.join("\n"));

    return installPackage(loaded, read.value);
  };

  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: demo\n");
  write(join(office, "packages/demo/package.yaml"), "name: demo\ndescription: A demo package.\n");
  write(join(office, "packages/demo/template/notes/README.md"), "from the package\n");
  write(join(office, "packages/demo/template/notes/AGENTS.md"), "from the package\n");
  write(join(office, "notes/AGENTS.md"), "the office's own\n");

  expect(install()).toEqual(["wrote packages/demo/.settings.json", "kept notes/AGENTS.md, which was already there, instead of package demo's copy", "created notes/README.md from package demo"]);

  rmSync(join(office, "notes"), { recursive: true });
  write(join(office, "packages/demo/template/notes/later.md"), "added by a later version\n");

  expect(install()).toEqual(["created notes/later.md from package demo"]);
  expect(existsSync(join(office, "notes/README.md"))).toBe(false);
  expect(existsSync(join(office, "notes/AGENTS.md"))).toBe(false);
  expect(install()).toEqual([]);
});

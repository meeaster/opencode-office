// Packages' access declarations in the compiled office's own setup, on a fresh clone of an office:
// nothing is applied and no package set exists. Setup plans GitHub access and reads every
// source from the shipped skills package's and a local package's declarations before it clones
// anything; a read-write remote is planned as one agents push to; a local-only entry asks for nothing.
import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.ts";
import { definitionFixture } from "./package-definition.fixture.ts";
import { fakeRegistry } from "./test-package.ts";
import { toolPath } from "./tool.ts";

const { root, bin, write, commit, fixture } = definitionFixture({ second: false });
const miseVersion = "2026.11.11";
const example = toolPath("examples/package-work/packages/mirrors");

/** A bare repository with one commit. */
function bare(name: string) {
  const work = join(root, `${name}-work`);
  const path = join(root, "github", `${name}.git`);

  mkdirSync(work, { recursive: true });
  git(["init", "-q", "-b", "main", work]);
  writeFileSync(join(work, "README.md"), `${name}\n`);
  commit(work);
  git(["clone", "-q", "--bare", work, path]);
}

test("fresh setup reads shipped and local access declarations before any clone; read-write is planned for pushing, local-only asks nothing", () => {
  const f = fixture("fresh-access");
  const log = join(f.home, "git.log");

  for (const name of ["handbook", "notes"]) bare(name);
  cpSync(example, join(f.dir, "packages/mirrors"), { recursive: true });
  // GitHub URLs read from local bare repositories: offline, and still on the GitHub host for planning.
  write(join(f.home, ".gitconfig"), `[url "file://${root}/github/"]\n\tinsteadOf = https://github.com/example/\n`);
  write(join(f.home, "bin/git"), `#!/bin/sh\necho "$*" >> "${log}"\nexec "${bin}/git" "$@"\n`, 0o755);
  // Setup's tool checks pass; the services it would start later don't.
  write(join(f.home, "bin/docker"), "#!/bin/sh\nexit 0\n", 0o755);
  write(join(f.home, "bin/mise"), `#!/bin/sh\n${fakeRegistry}if [ "$1" = --version ]; then echo "${miseVersion} linux-x64 (2026-01-01)"; exit 0; fi\nexit 1\n`, 0o755);
  // An office with an Executor key needs no new secrets configuration.
  write(join(f.home, "state/office-executor.env"), "EXECUTOR_TOKEN=test\n");
  writeFileSync(join(f.dir, "office.yaml"), `name: fresh-access
state: ${join(f.home, "state")}
opencode: {mode: host, url: 'http://127.0.0.1:1'}
tools: {sfw: {enabled: false}, mise: ${miseVersion}}
git: {name: Test, email: test@example.com}
packages:
  - name: skills
    settings:
      sources:
        - {repo: 'https://github.com/example/handbook.git', ref: '${"0".repeat(40)}', skills: [{name: review, path: review}]}
  - name: mirrors
    settings:
      mirrors:
        - {name: notes, description: Shared notes, url: 'https://github.com/example/notes.git', push: true}
        - {name: diary, description: Local only}
`);
  // As a fresh clone of the office has it: no package set, applied settings or pulled-in packages.
  rmSync(join(f.dir, ".office"), { recursive: true });
  expect(existsSync(join(f.dir, ".office/runtime/settings.json"))).toBe(false);
  expect(existsSync(join(f.dir, ".office/current"))).toBe(false);

  const result = Bun.spawnSync([join(bin, "office"), "--office", f.dir, "setup"], { cwd: root, env: f.env });
  const output = result.stdout.toString() + result.stderr.toString();

  // The read-write remote reads without a login, and setup says agents can't push to it without one.
  expect(output).toContain("mirrors notes reads without a login, but agents can't push to it without one");
  expect(output).not.toContain("diary");

  const calls = readFileSync(log, "utf8").trim().split("\n");
  const firstClone = calls.findIndex(call => /^(clone|fetch)\b/.test(call));
  const reads = (url: string) => calls.flatMap((call, index) => call.endsWith(`ls-remote ${url} HEAD`) ? [index] : []);

  // Each declared remote is read anonymously and then with credentials, all before anything is cloned or fetched.
  for (const url of ["https://github.com/example/handbook.git", "https://github.com/example/notes.git"]) {
    expect(reads(url).length, url).toBeGreaterThanOrEqual(2);
    expect(firstClone === -1 || reads(url).slice(0, 2).every(index => index < firstClone), calls.join("\n")).toBe(true);
  }
});

test("a local package.json that names an access declaration that doesn't read stops setup before any read or clone", () => {
  const f = fixture("broken-access");
  const log = join(f.home, "git.log");

  bare("broken-notes");
  cpSync(example, join(f.dir, "packages/mirrors"), { recursive: true });
  const json = join(f.dir, "packages/mirrors/package.json");

  // The declaration's module is gone: no proof that the package needs no access.
  writeFileSync(json, readFileSync(json, "utf8").replace('"./access.ts"', '"./missing.ts"'));
  write(join(f.home, ".gitconfig"), `[url "file://${root}/github/"]\n\tinsteadOf = https://github.com/example/\n`);
  write(join(f.home, "bin/git"), `#!/bin/sh\necho "$*" >> "${log}"\nexec "${bin}/git" "$@"\n`, 0o755);
  write(join(f.home, "bin/docker"), "#!/bin/sh\nexit 0\n", 0o755);
  write(join(f.home, "bin/mise"), `#!/bin/sh\n${fakeRegistry}if [ "$1" = --version ]; then echo "${miseVersion} linux-x64 (2026-01-01)"; exit 0; fi\nexit 1\n`, 0o755);
  write(join(f.home, "state/office-executor.env"), "EXECUTOR_TOKEN=test\n");
  writeFileSync(join(f.dir, "office.yaml"), `name: broken-access
state: ${join(f.home, "state")}
opencode: {mode: host, url: 'http://127.0.0.1:1'}
tools: {sfw: {enabled: false}, mise: ${miseVersion}}
git: {name: Test, email: test@example.com}
packages:
  - name: mirrors
    settings:
      mirrors:
        - {name: notes, description: Shared notes, url: 'https://github.com/example/broken-notes.git', push: true}
`);
  rmSync(join(f.dir, ".office"), { recursive: true });

  const result = Bun.spawnSync([join(bin, "office"), "--office", f.dir, "setup"], { cwd: root, env: f.env });
  const output = result.stdout.toString() + result.stderr.toString();

  expect(result.exitCode, output).toBe(1);
  expect(output).toContain("package mirrors: its access declaration can't be read: office.access");
  expect(output).toContain("so nothing was cloned");
  const calls = existsSync(log) ? readFileSync(log, "utf8") : "";

  expect(calls).not.toMatch(/\b(ls-remote|clone|fetch)\b/);
});

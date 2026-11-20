import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compile } from "./build.ts";
import { git } from "./git.ts";
import { loadOffice } from "./office.ts";
import { preparePackageServices } from "./package-services.ts";

const root = mkdtempSync(join(tmpdir(), "office-definition-"));
const bin = join(root, "bin");
const exe = join(bin, "office");
const variant = join(root, "distribution/target/office");
const marker = `import {appendFileSync} from "node:fs"; appendFileSync(process.env.PROBE, "imported\\n");`;

function write(path: string, text: string, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode });
}

const read = (path: string) => readFileSync(path, "utf8");

function commit(repo: string) {
  git(["add", "-A"], repo);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"], repo);

  return git(["rev-parse", "HEAD"], repo);
}

beforeAll(async () => {
  mkdirSync(bin);
  await compile(exe);
  const gitPath = Bun.which("git");

  if (!gitPath) throw new Error("git required for the pinned package fixture");

  symlinkSync(gitPath, join(bin, "git"));
  // Only the unrelated health checks get stand-ins: an empty list of containers and tool versions.
  write(join(bin, "docker"), '#!/bin/sh\ncase "$*" in "compose "*" ps --status running --format {{.Service}}") exit 0;; *) exit 1;; esac\n', 0o755);

  for (const name of ["sops", "age", "age-keygen"]) write(join(bin, name), '#!/bin/sh\n[ "$1" = --version ] && echo 1.0.0\n', 0o755);

  // Build a second distribution, without modifying the checkout's packages or template.
  const dist = join(root, "distribution");
  const checkout = dirname(import.meta.dir);
  git(["init", "-q", dist]);

  for (const path of ["src", "packages", "template", "image", "compose.yaml", "LICENSE", "package.json"]) cpSync(join(checkout, path), join(dist, path), { recursive: true });
  write(join(dist, "packages/arrival/office.ts"), `${marker} export default { name: "arrival", description: "Newly shipped" }`);
  const changed = join(dist, "packages/artifact-share");
  rmSync(join(changed, "package.yaml"));
  write(join(changed, "office.ts"), 'import title from "./missing.ts"; export default {name:"artifact-share", description:title}');
  write(join(changed, "plugin/index.ts"), "// replacement");
  const template = join(dist, "template/office/office.yaml");
  write(template, `${read(template)}  - name: artifact-share\n`);
  commit(dist);
  symlinkSync(join(checkout, "node_modules"), join(dist, "node_modules"));
  const built = Bun.spawnSync([process.execPath, "src/build.ts"], { cwd: dist, env: { ...process.env, HOME: root } });
  expect(built.exitCode, built.stderr.toString()).toBe(0);
}, 60_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

function fixture(name: string) {
  const dir = join(root, name);
  const home = join(root, `${name}-home`);
  mkdirSync(home);

  const probe = join(home, "imports");

  const env = {
    HOME: home, PATH: `${home}/bin:${bin}`, NO_COLOR: "1", TMPDIR: root, GIT_ALLOW_PROTOCOL: "file",
    DOCKER_HOST: `unix://${home}/absent.sock`, DBUS_SESSION_BUS_ADDRESS: `unix:path=${home}/absent-bus`,
    OFFICE_MACHINE_RECORD: join(home, "record.json"), OFFICE_MISE_CONFIG_DIR: join(home, "mise"), OFFICE_MACHINE_DIR: join(home, "machine"),
    OFFICE_APP_CONFIG_DIR: join(home, "app"), OFFICE_APP_PANELS_DIR: join(home, "panels"), OFFICE_SYSTEMD_USER_DIR: join(home, "units"), PROBE: probe,
  };

  const run = (binary: string, status: number, ...args: string[]) => {
    const result = Bun.spawnSync([binary, ...args], { cwd: root, env });
    const output = result.stdout.toString() + result.stderr.toString();

    expect(result.exitCode, output).toBe(status);

    return output;
  };

  run(exe, 0, "init", dir);
  const config = join(dir, "office.yaml");
  const initial = read(config);
  const cli = (status: number, ...args: string[]) => run(exe, status, "--office", dir, ...args);
  const newer = (status: number, ...args: string[]) => run(variant, status, "--office", dir, ...args);

  return { dir, home, probe, cli, newer, select: (entries: string) => write(config, initial + entries) };
}

test("the executable syncs mixed definitions and keeps applied state when a selected definition cannot be read", () => {
  const { dir, cli, select } = fixture("mixed");
  const pkg = join(dir, "packages/notes");
  const link = join(dir, ".opencode/plugins/notes");
  const pins = join(dir, "machine.packages.toml");
  const module = 'import { count } from "./defaults.ts"; export default { name: "notes", description: "Notes", settings: { count: { description: "Count", default: count } }, tools: { jq: "1.7.1" } }';

  select("  - name: legacy\n  - name: notes\n");
  write(join(dir, "packages/legacy/package.yaml"), "name: legacy\ndescription: Legacy\nsettings: { label: { description: Label, default: old } }\n");
  write(join(pkg, "office.ts"), module);
  write(join(pkg, "defaults.ts"), "export const count: number = 3;");
  write(join(pkg, "plugin/index.ts"), 'export default { id: "notes", setup() {} }');
  write(join(pkg, "compose.yaml"), "services:\n  notes:\n    image: example/notes\n");
  write(join(pkg, "template/notes/example"), "seed");
  cli(0, "sync");
  expect(read(join(dir, "notes/example"))).toBe("seed");
  expect(JSON.parse(read(join(dir, "packages/legacy/.settings.json")))).toEqual({ label: "old" });
  expect(JSON.parse(read(join(pkg, ".settings.json")))).toEqual({ count: 3 });
  expect(cli(0, "check")).toMatch(/ok   package notes: .*compose.yaml contributes services notes/);
  write(join(pkg, "defaults.ts"), "export const count: number = 7;");
  write(join(dir, "notes/example"), "owner");
  cli(0, "sync", "--packages");
  const applied = read(pins);

  expect(applied).toContain('"jq" = "1.7.1" # notes');

  const preserved = (reason: string) => {
    expect(cli(1, "sync", "--packages")).toContain(reason);
    expect(cli(1, "check")).toContain(reason);
    expect(readlinkSync(link)).toBe("../../packages/notes/plugin");
    expect(read(pins)).toBe(applied);
    expect(JSON.parse(read(join(pkg, ".settings.json")))).toEqual({ count: 7 });
    expect(read(join(dir, "notes/example"))).toBe("owner");
  };

  write(join(pkg, "office.ts"), 'throw new Error("bad notes import")');
  preserved("packages/notes/office.ts: bad notes import");
  write(join(pkg, "package.yaml"), "name: notes\ndescription: otherwise valid\n");
  preserved("packages/notes has both office.ts and package.yaml");
  rmSync(join(pkg, "package.yaml"));
  write(join(pkg, "office.ts"), 'export default { name: "notes", description: "Notes", setup() {} }');
  preserved("packages/notes/office.ts: setup:");

  select("  - name: legacy\n");
  cli(0, "sync", "--packages");
  expect(existsSync(link)).toBe(false);
  expect(read(pins)).not.toContain('"jq"');
  expect(read(join(dir, "notes/example"))).toBe("owner");
  expect(existsSync(join(dir, "node_modules"))).toBe(false);
}, 60_000);

for (const kind of ["local", "tracked"]) {
  test(`a newly shipped built-in cannot claim the ${kind} source during sync, update or refresh`, () => {
    const { dir, probe, select, cli, newer } = fixture(`collision-${kind}`);
    const repo = join(root, `collision-source-${kind}`);
    const pkg = kind === "local" ? join(dir, "packages/arrival") : join(repo, "arrival");
    const installed = kind === "local" ? pkg : join(dir, ".office/packages/arrival");
    const link = join(dir, ".opencode/plugins/arrival");
    write(join(pkg, "office.ts"), `${marker} export default {name:"arrival",description:"Original"}`);
    write(join(pkg, "plugin/index.ts"), "// original plugin");
    write(join(pkg, "template/arrival.md"), "seed");
    let identity = "packages/arrival";

    if (kind === "local") select("  - name: arrival\n");
    else {
      git(["init", "-q", "-b", "main", repo]);
      const first = commit(repo);
      identity = `${repo}@${first}:arrival`;
      select(`  - {name: arrival, repo: ${repo}, path: arrival, ref: ${first}, track: main}\n`);
      write(join(pkg, "plugin/index.ts"), "// new plugin");
      commit(repo);
    }

    cli(0, "sync", "--packages");
    const paths = [join(dir, "office.yaml"), join(installed, ".template.json"), join(installed, "office.ts"), join(link, "index.ts"), join(dir, "arrival.md")];

    if (kind === "tracked") paths.push(join(installed, ".source.json"));
    const old = paths.map(read);
    const target = readlinkSync(link);
    rmSync(probe);

    for (const args of [["sync"], ["sync", "--packages"], ["packages", "update"], ["refresh"]]) {
      const output = newer(1, ...args);
      expect(output).toContain("built-in package arrival");
      expect(output).toContain(identity);
      expect(existsSync(probe)).toBe(false);
      expect(readlinkSync(link)).toBe(target);
      expect(paths.map(read)).toEqual(old);

      if (kind === "local") expect(existsSync(join(dir, ".office/packages/arrival"))).toBe(false);
    }
  }, 60_000);
}

test("tracked updates validate the consuming settings and staged assets before publishing", () => {
  const { dir, cli, select } = fixture("tracked");
  const repo = join(root, "tracked-source");
  const source = join(repo, "shared");
  const installed = join(dir, ".office/packages/shared");
  const link = join(dir, ".opencode/plugins/shared");
  git(["init", "-q", "-b", "main", repo]);
  const definition = 'export default {name:"shared",description:"Shared",settings:{title:{description:"Title",required:true}}}';
  write(join(source, "office.ts"), definition);
  write(join(source, "compose.yaml"), "services:\n  shared:\n    image: example/shared\n    env_file: ./base.env\n");
  write(join(source, "base.env"), "FEATURE=original\n");
  write(join(source, "plugin/index.ts"), "// original");
  write(join(source, "template/shared.md"), "seed");
  const first = commit(repo);
  select(`  - {name: shared, repo: ${repo}, ref: ${first}, path: shared, track: main, settings: {title: Mine}}\nstate: ./state\n`);
  cli(0, "sync", "--packages");
  preparePackageServices(loadOffice(dir), false).apply();
  const paths = ["office.yaml", "shared.md", ".opencode/plugins/shared/index.ts", "state/packages/shared/compose.yaml", "state/packages/shared/settings.env", "state/packages/shared/include.yaml"].map(path => join(dir, path));
  paths.push(...[".source.json", ".settings.json", ".template.json", "base.env", "compose.yaml", "office.ts"].map(file => join(installed, file)));
  const before = paths.map(read);
  write(join(source, "template/extra.md"), "new seed");
  write(join(source, "plugin/index.ts"), "// rejected");
  rmSync(join(source, "base.env"));

  for (const [candidate, reason] of [
    ['export default {name:"shared",description:"New"}', "settings.title"],
    [definition.replace("settings:", 'cron:{job:{script:"missing.sh",schedule:"@daily"}},settings:'), "missing.sh"],
  ]) {
    write(join(source, "office.ts"), candidate);
    commit(repo);
    expect(cli(1, "packages", "update")).toContain(reason);
    expect(readlinkSync(link)).toBe("../../.office/packages/shared/plugin");
    expect(paths.map(read)).toEqual(before);
    expect(existsSync(join(dir, "extra.md"))).toBe(false);
  }
}, 60_000);

test("a broken embedded replacement leaves the installed package usable and fails a new init", () => {
  const { dir, cli, newer, select } = fixture("embedded");
  select("  - name: artifact-share\n    settings: {url: https://example.org}\n");
  cli(0, "sync", "--packages");
  const pkg = join(dir, ".office/packages/artifact-share");
  const paths = [join(dir, ".opencode/plugins/artifact-share/index.ts"), join(dir, "artifacts/README.md"), ...[".source.json", ".settings.json", ".template.json", "package.yaml", "scripts/build-site.ts"].map(file => join(pkg, file))];
  const before = paths.map(read);
  expect(newer(1, "sync", "--packages")).toContain("missing.ts");
  expect(paths.map(read)).toEqual(before);
  const fresh = join(root, "failed-init");
  const output = newer(1, "init", fresh);
  expect(output).toContain("Initial sync failed");
  expect(output).not.toContain("created the office in");
  expect(existsSync(join(fresh, ".office/packages/artifact-share"))).toBe(false);
}, 60_000);

test("built-in YAML and TS enforce the same record and bootstrap repair rules", () => {
  const { dir, newer, select } = fixture("integrity");
  select("  - name: arrival\n");
  newer(0, "sync", "--packages");

  for (const [name, file] of [["arrival", "office.ts"], ["knowledge", "package.yaml"]]) {
    const pkg = join(dir, ".office/packages", name);
    const path = join(pkg, file);
    const original = read(path);
    newer(0, "cron", "list");
    write(path, original + "\n");
    expect(newer(1, "cron", "list")).toContain(`${file} (edited)`);
    newer(0, "sync", "--packages");
    expect(read(path)).toBe(original);
    rmSync(join(pkg, ".source.json"));
    expect(newer(1, "cron", "list")).toContain("no readable .source.json");
    newer(0, "sync", "--packages");
    newer(0, "cron", "list");
  }
}, 60_000);

test("down uses the applied Compose inputs and marked unit without importing the selected owner", () => {
  const { dir, home, probe, cli, select } = fixture("teardown");
  select("  - name: notes\nstate: ./state\n");
  const pkg = join(dir, "packages/notes");
  write(join(pkg, "office.ts"), 'export default { name:"notes",description:"Notes",spawns:{label:"test=notes-${OFFICE_NAME}"}}');
  write(join(pkg, "compose.yaml"), "services: {notes: {image: example/notes}}\n");
  cli(0, "sync", "--packages");
  preparePackageServices(loadOffice(dir), false).apply();
  write(join(pkg, "office.ts"), `${marker} throw Error("unread")`);
  const unit = "office-teardown-pkg-notes.bridge.service";
  write(join(home, "units", unit), `# office package services: ${dir}\n`);
  write(join(home, "bin/systemctl"), '#!/bin/sh\necho "$*" >> "$HOME/service.calls"\n', 0o755);
  write(join(home, "bin/docker"), '#!/bin/sh\necho "$*" >> "$HOME/docker.calls"\ncase "$1" in ps) echo fixture-container;; esac\n', 0o755);
  cli(0, "down");
  expect(existsSync(probe)).toBe(false);
  expect(read(join(home, "service.calls"))).toContain(`disable --now ${unit}`);
  expect(existsSync(join(home, "units", unit))).toBe(false);
  const calls = read(join(home, "docker.calls"));
  expect(calls).toContain("--filter label=test=notes-teardown");
  expect(calls).toContain("rm --force fixture-container");
  expect(calls).toMatch(/state\/packages\/notes\/include.yaml .*down/);
}, 60_000);

test("the executable installs a TS-only Git package and repairs it from the recorded commit after its tag moves", () => {
  const { dir, cli, select } = fixture("pinned");
  const repo = join(root, "upstream");
  const dest = join(dir, ".office/packages/shared");
  const sibling = "export const title: string = 'original';";
  const source = (ref: string) => `  - { name: shared, repo: ${repo}, path: packages/shared, ref: ${ref} }\n`;

  git(["init", "-q", repo]);
  write(join(repo, "packages/shared/title.ts"), sibling);
  write(join(repo, "packages/shared/office.ts"), 'import { title } from "./title.ts"; export default { name: "shared", description: "Shared", settings: { title: { description: "Title", default: title } } }');
  const first = commit(repo);

  git(["tag", "v1"], repo);
  select(source("v1"));
  cli(0, "sync", "--packages");
  const settings = join(dest, ".settings.json");
  const record = join(dest, ".source.json");

  expect(JSON.parse(read(settings))).toEqual({ title: "original" });
  expect(JSON.parse(read(record))).toMatchObject({ ref: "v1", commit: first });
  // An unchanged copy works offline, including check.
  renameSync(repo, `${repo}-offline`);
  cli(0, "sync", "--packages");
  expect(cli(0, "check")).toContain("ok   package shared:");
  write(join(dest, "title.ts"), 'export const title = "damaged";');
  expect(cli(1, "check")).toContain("title.ts (edited)");
  expect(cli(1, "sync", "--packages")).toContain(first);
  expect(JSON.parse(read(settings))).toEqual({ title: "original" });
  renameSync(`${repo}-offline`, repo);
  write(join(repo, "packages/shared/title.ts"), 'export const title = "later";');
  const second = commit(repo);
  git(["tag", "-f", "v1"], repo);
  rmSync(join(dest, "office.ts"));
  write(join(dest, "title.ts"), "damaged");
  expect(cli(0, "sync", "--packages")).toContain("restored .office/packages/shared");
  expect(read(join(dest, "title.ts"))).toBe(sibling);
  expect(JSON.parse(read(record))).toMatchObject({ ref: "v1", commit: first });
  expect(JSON.parse(read(settings))).toEqual({ title: "original" });
  expect(cli(0, "check")).toContain("ok   package shared:");

  // With no usable record, a moving ref cannot identify the commit to restore.
  const lastGood = read(record);

  write(record, "{");
  expect(cli(1, "sync", "--packages")).toContain("cannot repair from v1 without the recorded commit");
  expect(read(join(dest, "title.ts"))).toBe(sibling);
  write(record, lastGood);

  // A bad candidate must not replace the installed copy or apply its templates/settings.
  write(join(repo, "packages/shared/package.yaml"), "name: shared\ndescription: Ambiguous\n");
  select(source(commit(repo)));
  expect(cli(1, "sync", "--packages")).toContain("has both office.ts and package.yaml");
  expect(read(record)).toBe(lastGood);
  rmSync(join(repo, "packages/shared/package.yaml"));
  write(join(repo, "packages/shared/office.ts"), 'throw new Error("bad candidate");');
  select(source(commit(repo)));
  expect(cli(1, "sync", "--packages")).toContain("office.ts: bad candidate");
  expect(read(record)).toBe(lastGood);
  expect(JSON.parse(read(settings))).toEqual({ title: "original" });

  select(source(first));
  cli(0, "sync", "--packages");
  const contradiction = JSON.stringify({ ...JSON.parse(read(record)), commit: second });

  for (const damaged of [false, true]) {
    write(record, contradiction);

    if (damaged) write(join(dest, "title.ts"), "damaged");
    expect(cli(1, "cron", "list")).toContain(`invalid recorded commit ${second} for ${first}`);
    cli(0, "sync", "--packages");
    expect(JSON.parse(read(record))).toMatchObject({ ref: first, commit: first });
    expect(read(join(dest, "title.ts"))).toBe(sibling);
  }
}, 60_000);

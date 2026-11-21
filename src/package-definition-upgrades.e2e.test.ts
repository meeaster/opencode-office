import { expect, test } from "bun:test";
import { existsSync, readlinkSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.ts";
import { loadOffice } from "./office.ts";
import { preparePackageServices } from "./package-services.ts";
import { definitionFixture } from "./package-definition.fixture.ts";

const { root, bin, marker, write, read, commit, fixture, collector } = definitionFixture();

test("tracked updates validate the consuming settings and staged assets before publishing", async () => {
  const { dir, cli, select } = fixture("tracked");
  const repo = join(root, "tracked-source");
  const source = join(repo, "shared");
  const installed = join(dir, ".office/packages/shared");
  const link = join(dir, ".opencode/plugins/shared");
  git(["init", "-q", "-b", "main", repo]);
  const definition = 'export default {name:"shared",description:"Shared",setup(ctx){ctx.command({name:"edition",summary:"Current edition",run(){console.log("original edition")}})},settings:{title:{description:"Title",required:true}}}';
  write(join(source, "office.ts"), definition);
  write(join(source, "compose.yaml"), "services:\n  shared:\n    image: example/shared\n    env_file: ./base.env\n");
  write(join(source, "base.env"), "FEATURE=original\n");
  write(join(source, "plugin/index.ts"), "// original");
  write(join(source, "seed/shared.md"), "seed");
  const first = commit(repo);
  select(`  - {name: shared, repo: ${repo}, ref: ${first}, path: shared, track: main, settings: {title: Mine}}\nstate: ./state\n`);
  cli(0, "sync", "--packages");
  (await preparePackageServices(loadOffice(dir), false)).apply();
  const paths = ["office.yaml", ".office/resolved/references.json", "shared.md", ".opencode/plugins/shared/index.ts", "state/packages/shared/compose.yaml", "state/packages/shared/settings.env", "state/packages/shared/include.yaml"].map(path => join(dir, path));
  paths.push(join(dir, "office.lock"), ...[".source.json", ".settings.json", "base.env", "compose.yaml", "office.ts"].map(file => join(installed, file)));
  const before = paths.map(read);
  write(join(source, "seed/extra.md"), "new seed");
  write(join(source, "plugin/index.ts"), "// rejected");
  rmSync(join(source, "base.env"));

  for (const [candidate, reason] of [
    ['export default {name:"shared",description:"New"}', "settings.title"],
    ['export default {name:"shared",description:"New",setup(c){c.booleanSetting("active",{default:true,description:"Active"})}}', "settings.title"],
    ['export default {name:"shared",description:"New",setup(c){c.booleanSetting("title",{default:true,description:"Title"})}}', "settings.title: must be true or false"],
    ['export default {name:"shared",description:"New",setup(c){c.scalarSetting("title",{default:"ok",description:"Title"});c.scalarSetting("new_key",{default:"can\'t",description:"Not an env literal"})}}', "setting new_key holds a quote"],
    ['export default {name:"shared",description:"New",setup(c){c.scalarSetting("title",{default:"fallback",description:"Title"})},opencode(c){if(c.settings.title==="Mine")c.serverPlugin("missing")}}', "existing directory"],
    [definition.replace("settings:", 'cron:{job:{script:"missing.sh",schedule:"@daily"}},settings:'), "missing.sh"],
    [definition.replace("settings:", 'registerCron(ctx){ctx.cron.job("job",{script:"missing.sh",schedule:"@daily"})},settings:'), "missing.sh"],
    [definition.replace("settings:", 'registerCron(ctx){ctx.cron.job("job",false);throw Error("interrupted replacement")},settings:'), "interrupted replacement"],
  ]) {
    write(join(source, "office.ts"), candidate);
    commit(repo);
    expect(cli(1, "packages", "update")).toContain(reason);
    expect(readlinkSync(link)).toBe("../../.office/packages/shared/plugin");
    expect(paths.map(read)).toEqual(before);
    expect(cli(0, "edition")).toContain("original edition");
    expect(existsSync(join(dir, "extra.md"))).toBe(false);
  }

  // Only the new revision declares `enabled`; staging setup also needs a published sibling.
  write(join(source, "base.env"), "FEATURE=updated\n");
  write(join(source, "office.ts"), `export default {name:"shared",description:"New",async setup(c){
    if(c.booleanSetting("enabled",{default:false,description:"Enabled"})){
      const {repositories}=await import("../references/repositories.ts");
      c.add(repositories,{name:"enabled",url:"new-revision"});
    }
  }}`);
  const next = commit(repo);
  select(`  - {name: shared, repo: ${repo}, ref: ${first}, path: shared, track: main, settings: {enabled: true}}\nstate: ./state\n`);
  cli(0, "packages", "update");
  expect(read(paths[0])).toContain(next);
  expect(cli(0, "references", "list")).toContain("enabled\tnew-revision\tpackage shared");
}, 60_000);

test("a broken embedded replacement leaves the installed package usable and fails a new init", () => {
  const { dir, cli, newer, select } = fixture("embedded");
  select("  - name: artifact-share\n    settings: {url: https://example.org}\n");
  cli(0, "sync", "--packages");
  const pkg = join(dir, ".office/packages/artifact-share");
  const paths = [join(dir, ".opencode/plugins/artifact-share/index.ts"), join(dir, "artifacts/README.md"), join(dir, "office.lock"), ...[".source.json", ".settings.json", "office.ts", "scripts/build-site.ts"].map(file => join(pkg, file))];
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
  select("  - name: arrival\n  - name: legacy\n");
  newer(0, "sync", "--packages");

  for (const [name, file] of [["arrival", "office.ts"], ["legacy", "package.yaml"]]) {
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

test("down uses the applied Compose inputs and marked unit without importing the selected owner", async () => {
  const { dir, home, probe, cli, select } = fixture("teardown");
  select("  - name: notes\nstate: ./state\n");
  const pkg = join(dir, "packages/notes");
  write(join(pkg, "office.ts"), 'export default { name:"notes",description:"Notes",spawns:{label:"test=notes-${OFFICE_NAME}"}}');
  write(join(pkg, "compose.yaml"), "services: {notes: {image: example/notes}}\n");
  cli(0, "sync", "--packages");
  (await preparePackageServices(loadOffice(dir), false)).apply();
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

test("a Doop upgrade requires the exact old volume names; a partial backup cannot advance applied state", () => {
  const { dir, home, cli, select } = fixture("backup");
  const pg = "office-backup_doop-pg";
  const assets = "office-backup_doop-assets";
  const calls = join(home, "docker.calls");
  const mode = join(home, "inspect-mode");
  const installed = join(dir, ".office/packages/design/compose.yaml");
  const applied = join(dir, "state/packages/design/compose.yaml");
  const record = join(dir, "state/applied.json");

  select("  - name: design\nstate: ./state\n");
  cli(0, "sync", "--packages");
  write(join(home, "bin/docker"), `#!/bin/sh
echo "$*" >> "$HOME/docker.calls"
case "$1 $2" in
  "volume inspect")
    [ "$3 $4" = '--format {{.Name}}' ] || exit 2
    case "$5" in
      ${pg}) echo "$5";;
      ${assets})
        IFS= read -r mode < "$HOME/inspect-mode"
        case "$mode" in
          denied) echo "$5"; echo PRIVATE_DIAGNOSTIC >&2; exit 1;;
          similar) echo "$5-extra";;
          extra) printf '%s\\nPRIVATE_DIAGNOSTIC\\n' "$5";;
          ok) echo "$5";;
          *) exit 2;;
        esac;;
      *) exit 3;;
    esac;;
  "run --rm"|"build -t"|"compose -p") ;;
  *) exit 3;;
esac\n`, 0o755);
  cli(0, "up");
  // Model an older applied release, retaining exactly its real volume names and mounts.
  const old = read(applied).replace("restart: unless-stopped", "restart: always");
  const oldRecord = `${read(record)}\n`;

  write(applied, old);
  write(record, oldRecord);

  for (const answer of ["denied", "similar", "extra"]) {
    write(mode, `${answer}\n`);
    write(calls, "");
    const output = cli(1, "up", "--upgrade");

    expect(output).toContain(`docker volume inspect ${assets}: ${answer === "denied" ? "exit 1" : "unexpected name"}`);
    expect(output).not.toContain("PRIVATE_DIAGNOSTIC");
    const trace = read(calls);

    expect(trace).not.toMatch(/volume ls|dial-stdio/);
    expect(trace).toContain("stop doop doop-db");
    expect(trace).toContain(`${pg}:/data:ro`);
    expect(trace).not.toContain(`${assets}:/data:ro`);
    expect(trace).not.toContain("up -d");
    expect(read(applied)).toBe(old);
    expect(read(record)).toBe(oldRecord);
  }

  write(mode, "ok\n");
  write(calls, "");
  cli(0, "up", "--upgrade");
  expect(read(calls)).toContain(`${pg}:/data:ro`);
  expect(read(calls)).toContain(`${assets}:/data:ro`);
  expect(read(calls)).toContain("up -d");
  expect(read(applied)).toBe(read(installed));
  expect(read(record)).not.toBe(oldRecord);
}, 60_000);

test("the executable installs a TS-only Git package at its locked commit, repairs it there after its tag moves, and packages update moves the lock", () => {
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
  // An unchanged copy works offline, including check; a repair that can't fetch leaves the lock.
  const lock = join(dir, "office.lock");
  const lockedText = read(lock);

  renameSync(repo, `${repo}-offline`);
  cli(0, "sync", "--packages");
  expect(cli(0, "check")).toContain("ok   package shared:");
  write(join(dest, "title.ts"), 'export const title = "damaged";');
  expect(cli(1, "check")).toContain("title.ts (edited)");
  expect(cli(1, "sync", "--packages")).toContain(first);
  expect(JSON.parse(read(settings))).toEqual({ title: "original" });
  expect(read(lock)).toBe(lockedText);
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

  // A fresh clone has office.lock but no .office/: sync installs the locked commit, not the tag's.
  expect(read(lock)).toContain(`    ref: v1\n    commit: ${first}\n`);
  rmSync(join(dir, ".office"), { recursive: true });
  cli(0, "sync", "--packages");
  expect(JSON.parse(read(record))).toMatchObject({ ref: "v1", commit: first });
  expect(read(join(dest, "title.ts"))).toBe(sibling);

  // The lock names the commit to restore when the record is unreadable; without it, a moving ref can't.
  const lastGood = read(record);

  write(record, "{");
  cli(0, "sync", "--packages");
  expect(JSON.parse(read(record))).toMatchObject({ ref: "v1", commit: first });
  renameSync(lock, `${lock}.saved`);
  write(record, "{");
  expect(cli(1, "sync", "--packages")).toContain("cannot repair from v1 without the recorded commit");
  expect(read(join(dest, "title.ts"))).toBe(sibling);
  write(record, lastGood);
  renameSync(`${lock}.saved`, lock);

  // packages update moves the lock to where the tag points now, and leaves office.yaml.
  const yaml = read(join(dir, "office.yaml"));

  expect(cli(0, "packages", "update")).toContain(`package shared: locked ${first.slice(0, 12)} → ${second} (tag v1; office.yaml unchanged)`);
  expect(read(join(dir, "office.yaml"))).toBe(yaml);
  expect(read(lock)).toContain(`    ref: v1\n    commit: ${second}\n`);
  expect(JSON.parse(read(record))).toMatchObject({ ref: "v1", commit: second });
  expect(JSON.parse(read(settings))).toEqual({ title: "later" });
  const updated = read(record);

  // A candidate whose definition throws must not replace the installed copy, apply its settings or
  // move the lock (an invalid one is a unit test in packages.test.ts).
  const locked = read(lock);

  write(join(repo, "packages/shared/office.ts"), 'throw new Error("bad candidate");');
  select(source(commit(repo)));
  expect(cli(1, "sync", "--packages")).toContain("office.ts: bad candidate");
  expect(read(record)).toBe(updated);
  expect(read(lock)).toBe(locked);
  expect(JSON.parse(read(settings))).toEqual({ title: "later" });

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

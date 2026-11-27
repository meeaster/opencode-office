import { expect, test } from "bun:test";
import { existsSync, readlinkSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../src/git.ts";
import { loadOffice } from "../../src/office.ts";
import { preparePackageServices } from "../../src/features/compose/package-services.ts";
import { definitionFixture } from "../support/package-definition.fixture.ts";
import { definitionText, writePackage } from "../support/test-package.ts";

const { root, bin, marker, write, read, commit, fixture, collector } = definitionFixture();

test("tracked updates validate the consuming settings and staged assets before publishing", async () => {
  const { dir, cli, select } = fixture("tracked");
  const repo = join(root, "tracked-source");
  const source = join(repo, "shared");
  const installed = join(dir, ".office/packages/shared");
  const link = join(dir, ".opencode/plugins/shared");
  git(["init", "-q", "-b", "main", repo]);
  // Its seeds are a folder: a file added there would be laid down by any revision that publishes.
  const seeded = 'setup(c){seeds.add(c,{destination:"seeded",source:"seed"});opencode.plugins.add(c,{directory:"plugin"})},';
  const withSeeds = (body: string) => definitionText(body, 'import {seeds} from "@office/seeds"; import {opencode} from "@office/opencode";');
  const definition = withSeeds(`{${seeded}commands:{edition:{summary:"Current edition",run(){console.log("original edition")}}},settings:{type:"object",additionalProperties:false,required:["title"],properties:{title:{type:"string"}}}}`);
  const uses = { dependencies: ["seeds", "opencode"] };
  writePackage(join(source, "office.ts"), definition, uses);
  write(join(source, "compose.yaml"), "services:\n  shared:\n    image: example/shared\n    env_file: ./base.env\n");
  write(join(source, "base.env"), "FEATURE=original\n");
  write(join(source, "plugin/index.ts"), "// original");
  write(join(source, "seed/shared.md"), "seed");
  write(join(source, "seed/edited.md"), "seed\n");
  const first = commit(repo);
  select(`  - {name: shared, repo: ${repo}, ref: ${first}, path: shared, track: main, settings: {title: Mine}}\nstate: ./state\n`);
  cli(0, "sync", "--packages");
  (await preparePackageServices(loadOffice(dir), false)).apply();
  const paths = ["office.yaml", ".office/resolved/references.json", "seeded/shared.md", ".office/seeds/receipts.json", ".opencode/plugins/shared/index.ts", "state/packages/shared/compose.yaml", "state/packages/shared/settings.env", "state/packages/shared/include.yaml"].map(path => join(dir, path));
  paths.push(join(dir, "office.lock"), join(dir, ".office/runtime/settings.json"), ...[".source.json", "base.env", "compose.yaml", "office.ts"].map(file => join(installed, file)));
  const before = paths.map(read);
  write(join(source, "seed/extra.md"), "new seed");
  write(join(source, "plugin/index.ts"), "// rejected");
  rmSync(join(source, "base.env"));

  for (const [candidate, reason] of [
    [definitionText('{}'), "settings.title"],
    [definitionText('{settings:{type:"object",additionalProperties:false,properties:{active:{type:"boolean",default:true}}}}'), "settings.title"],
    [definitionText('{settings:{type:"object",additionalProperties:false,properties:{title:{type:"boolean",default:true}}}}'), "settings.title: must be boolean"],
    [definitionText('{settings:{type:"object",additionalProperties:false,properties:{title:{type:"string",default:"ok"},new_key:{type:"string",default:"can\'t"}}}}'), "setting new_key holds a quote"],
    [withSeeds('{settings:{type:"object",additionalProperties:false,properties:{title:{type:"string",default:"fallback"}}},setup(c){if(c.settings.title==="Mine")opencode.plugins.add(c,{directory:"missing"})}}'), "existing directory"],
    // The callback that registered OpenCode assets before is an unknown key.
    [definition.replace("settings:", 'opencode(){},settings:'), "office.ts: opencode: must be a mapping of"],
    // A removed setup call is a call to something that isn't there.
    [definitionText('{settings:{type:"object",additionalProperties:false,properties:{title:{type:"string"}}},setup(c){c.booleanSetting("active",{default:true,description:"Active"})}}'), "booleanSetting"],
    // The ways jobs were declared before cron was a package are unknown keys.
    [definition.replace("settings:", 'cron:{job:{script:"job.sh",schedule:"@daily"}},settings:'), "office.ts: cron: must be a mapping of"],
    [definition.replace("settings:", 'registerCron(){},settings:'), "office.ts: registerCron: must be a mapping of"],
    // A job the cron registry's parser refuses (handles match by id, so no import is needed).
    [definition.replace(seeded, `setup(c){seeds.add(c,{destination:"seeded",source:"seed"});opencode.plugins.add(c,{directory:"plugin"});c.add({id:"cron.jobs",parse:v=>v},{name:"job",schedule:"every tuesday",script:"job.sh"})},`), "cron job job: schedule must be"],
    [definition.replace(seeded, `setup(c){seeds.add(c,{destination:"seeded",source:"seed"});opencode.plugins.add(c,{directory:"plugin"});throw Error("interrupted replacement")},`), "interrupted replacement"],
  ]) {
    writePackage(join(source, "office.ts"), candidate, uses);
    commit(repo);
    expect(cli(1, "packages", "update")).toContain(reason);
    expect(readlinkSync(link)).toBe("../../.office/packages/shared/plugin");
    expect(paths.map(read)).toEqual(before);
    expect(cli(0, "edition")).toContain("original edition");
    expect(existsSync(join(dir, "seeded/extra.md"))).toBe(false);
  }

  // Only the new revision declares `enabled`; staging setup also needs a published sibling.
  write(join(source, "base.env"), "FEATURE=updated\n");
  writePackage(join(source, "office.ts"), withSeeds(`{settings:{type:"object",additionalProperties:false,properties:{enabled:{type:"boolean",default:false}}},async setup(c){
    seeds.add(c,{destination:"seeded",source:"seed"});
    if(c.settings.enabled){
      const {repositories}=await import("@office/references/repositories");
      c.add(repositories,{name:"enabled",url:"new-revision"});
    }
  }}`), uses);
  // The new revision also changes both seeds' source files: the unchanged file is replaced, the edited one offered, each against the new bytes.
  write(join(source, "seed/shared.md"), "updated seed");
  write(join(source, "seed/edited.md"), "updated seed\n");
  write(join(dir, "seeded/edited.md"), "the owner's edit\n");
  const next = commit(repo);
  select(`  - {name: shared, repo: ${repo}, ref: ${first}, path: shared, track: main, settings: {enabled: true}}\nstate: ./state\n`);
  const updated = cli(0, "packages", "update");
  expect(updated).toContain("package seeds: pending seeded/edited.md: package shared changed its seed");
  expect(updated).toContain("package seeds: created seeded/extra.md from package shared");
  expect(read(paths[0])).toContain(next);
  expect(cli(0, "references", "list")).toContain("enabled\tnew-revision\tpackage shared");
  expect(read(join(dir, "seeded/shared.md"))).toBe("updated seed");
  expect(read(join(dir, "seeded/edited.md"))).toBe("the owner's edit\n");
  const shown = cli(0, "seeds", "diff", "seeded/edited.md");
  expect(shown).toContain("+updated seed");
  expect(shown).toContain("+the owner's edit");
  expect(shown).toContain("Keep owner deletions deleted, including package rewrites of deleted rules or sections.");
  expect(shown).toContain("office seeds settle seeded/edited.md");
  expect(cli(0, "seeds", "settle", "seeded/edited.md")).toContain("settled seeded/edited.md");
  expect(cli(0, "seeds", "diff")).toContain("No seeds are pending.");
  expect(read(join(dir, "seeded/edited.md"))).toBe("the owner's edit\n");
  expect(cli(0, "--help")).toContain("seeds settle <path>");

  // A job whose script the new commit lacks passes the parser: the set is published, then the cron
  // package's sync, and every command after it, names the job.
  writePackage(join(source, "office.ts"), withSeeds(`{settings:{type:"object",additionalProperties:false,properties:{enabled:{type:"boolean",default:false}}},setup(c){
    seeds.add(c,{destination:"seeded",source:"seed"});
    c.add({id:"cron.jobs",parse:v=>v},{name:"digest",schedule:"@daily",script:"digest.sh"});
  }}`), uses);
  const lacking = commit(repo);
  const missing = "cron package.shared.digest: digest.sh must be an existing regular script inside package shared's folder";
  expect(cli(1, "packages", "update")).toContain(missing);
  expect(read(paths[0])).toContain(lacking);
  expect(cli(1, "cron", "list")).toContain(missing);
}, 60_000);

test("a broken embedded replacement leaves the installed package usable and fails a new init", () => {
  const { dir, cli, newer, select } = fixture("embedded");
  select("  - name: artifact-share\n    settings: {url: https://example.org}\n");
  cli(0, "sync", "--packages");
  const pkg = join(dir, ".office/packages/artifact-share");
  const paths = [join(dir, ".opencode/plugins/artifact-share/index.ts"), join(dir, "artifacts/README.md"), join(dir, "office.lock"), join(dir, ".office/runtime/settings.json"), ...[".source.json", "office.ts", "scripts/build-site.ts"].map(file => join(pkg, file))];
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

test("down tears down from the applied Compose inputs and marked unit when the owner's definition throws on import, naming it", async () => {
  const { dir, home, probe, cli, select } = fixture("teardown");
  select("  - name: notes\nstate: ./state\n");
  const pkg = join(dir, "packages/notes");
  writePackage(join(pkg, "office.ts"), definitionText('{ spawns:{label:"test=notes-${OFFICE_NAME}"}}'));
  write(join(pkg, "compose.yaml"), "services: {notes: {image: example/notes}}\n");
  cli(0, "sync", "--packages");
  (await preparePackageServices(loadOffice(dir), false)).apply();
  writePackage(join(pkg, "office.ts"), `${marker} throw Error("unread")`);
  const unit = "office-teardown-pkg-notes.bridge.service";
  write(join(home, "units", unit), `# office package services: ${dir}\n`);
  write(join(home, "bin/systemctl"), '#!/bin/sh\necho "$*" >> "$HOME/service.calls"\n', 0o755);
  write(join(home, "bin/docker"), '#!/bin/sh\necho "$*" >> "$HOME/docker.calls"\ncase "$1" in ps) echo fixture-container;; esac\n', 0o755);
  // The shutdown reader imports the owner for its `down` and names it; the office's own teardown doesn't need it.
  expect(cli(1, "down")).toContain("package notes: left out of shutdown, so what it installed, such as its timers, stays installed: packages/notes/office.ts: unread");
  expect(read(probe)).toBe("imported\n");
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
  writePackage(join(repo, "packages/shared/office.ts"), definitionText('{ settings: { type: "object", additionalProperties: false, properties: { title: { type: "string", default: title } } } }', 'import { title } from "./title.ts";'));
  const first = commit(repo);

  git(["tag", "v1"], repo);
  select(source("v1"));
  cli(0, "sync", "--packages");
  const settings = join(dir, ".office/runtime/settings.json");
  const record = join(dest, ".source.json");

  expect(JSON.parse(read(settings)).packages.shared).toEqual({ title: "original" });
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
  expect(JSON.parse(read(settings)).packages.shared).toEqual({ title: "original" });
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
  expect(JSON.parse(read(settings)).packages.shared).toEqual({ title: "original" });
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
  expect(JSON.parse(read(settings)).packages.shared).toEqual({ title: "later" });
  const updated = read(record);

  // A candidate whose definition throws must not replace the installed copy, apply its settings or
  // move the lock (an invalid one is a unit test in packages.test.ts).
  const locked = read(lock);

  writePackage(join(repo, "packages/shared/office.ts"), 'throw new Error("bad candidate");');
  select(source(commit(repo)));
  expect(cli(1, "sync", "--packages")).toContain("office.ts: bad candidate");
  expect(read(record)).toBe(updated);
  expect(read(lock)).toBe(locked);
  expect(JSON.parse(read(settings)).packages.shared).toEqual({ title: "later" });

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

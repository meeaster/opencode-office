// The applied settings snapshot in the compiled office: when sync publishes it, what keeps it out of
// commits, and `office settings get`, which reads it without loading packages or office.yaml.
import { expect, test } from "bun:test";
import { existsSync, lstatSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppliedSettings } from "../../sdk/applied-settings.ts";
import { git } from "../../src/git.ts";
import { definitionFixture } from "../support/package-definition.fixture.ts";
import { definitionText, settingsSchema, writePackage } from "../support/test-package.ts";

const { root, exe, marker, write, read, commit, fixture } = definitionFixture({ second: false });

const snapshotPath = ".office/runtime/settings.json";

/** A local package whose sync records the snapshot it sees and throws while `fail` is on. */
const notes = definitionText(`{
  settings: ${settingsSchema({ count: 3, label: "notes", fail: false })},
  sync({ office, settings }) {
    writeFileSync(join(office.dir, "seen.json"), readFileSync(join(office.dir, ${JSON.stringify(snapshotPath)}), "utf8"));
    if (settings.fail) throw new Error("late hook failure");
  },
}`, 'import { readFileSync, writeFileSync } from "node:fs"; import { dirname, join } from "node:path";');

test("sync publishes every selected package's settings, defaults included, before hooks, only when complete, and never into package sources", () => {
  const { dir, cli, select } = fixture("publication");
  const snapshot = join(dir, snapshotPath);
  const applied = () => JSON.parse(read(snapshot)).packages;

  // A fresh init ignores it through the template's .gitignore, before any exclude block exists.
  expect(git(["check-ignore", "-v", snapshotPath], dir)).toStartWith(".gitignore:");
  expect(applied().office).toEqual({ ignore_claude_synced_skills: true, ignore_skill_folders: [] });
  // A package without settings has an entry too.
  expect(applied().tools).toEqual({});

  writePackage(join(dir, "packages/notes/office.ts"), notes);
  write(join(dir, "packages/notes/README.md"), "notes\n");
  select("  - name: notes\n    settings: {count: 5}\n");
  cli(0, "sync", "--packages");
  expect(applied().notes).toEqual({ count: 5, label: "notes", fail: false });
  // The hook saw the settings it was applied with.
  expect(read(join(dir, "seen.json"))).toBe(read(snapshot));
  expect(existsSync(join(dir, "packages/notes/.settings.json"))).toBe(false);
  expect(git(["status", "--porcelain", "--untracked-files=all", "packages"], dir)).not.toContain(".settings.json");

  // An unchanged sync leaves the file alone: same bytes, same inode.
  const before = { text: read(snapshot), inode: statSync(snapshot).ino };
  expect(cli(0, "sync", "--packages")).not.toContain(`wrote ${snapshotPath}`);
  expect({ text: read(snapshot), inode: statSync(snapshot).ino }).toEqual(before);

  // A rejected candidate leaves the previous values.
  select('  - name: notes\n    settings: {count: "many"}\n');
  expect(cli(1, "sync", "--packages")).toContain("packages.notes.settings.count");
  expect({ text: read(snapshot), inode: statSync(snapshot).ino }).toEqual(before);

  // A hook that throws after publication leaves the new values published.
  select("  - name: notes\n    settings: {count: 6, fail: true}\n");
  expect(cli(1, "sync", "--packages")).toContain("late hook failure");
  expect(applied().notes).toEqual({ count: 6, label: "notes", fail: true });
  expect(read(join(dir, "seen.json"))).toBe(read(snapshot));

  // Without the template's line, sync's exclude block keeps it out of commits.
  write(join(dir, ".gitignore"), read(join(dir, ".gitignore")).replace("/.office/runtime/\n", ""));
  select("  - name: notes\n    settings: {count: 7}\n");
  cli(0, "sync", "--packages");
  expect(git(["check-ignore", "-v", snapshotPath], dir)).toContain("info/exclude:");

  // Deselected, its entry goes.
  select("");
  cli(0, "sync", "--packages");
  expect(applied().notes).toBeUndefined();
});

test("a sync that couldn't fetch a selected package switches the set but doesn't publish settings", () => {
  const { dir, cli, select } = fixture("partial");
  const repo = join(root, "partial-source");
  const snapshot = join(dir, snapshotPath);

  git(["init", "-q", "-b", "main", repo]);
  writePackage(join(repo, "shared/office.ts"), definitionText("{}"));
  const first = commit(repo);
  write(join(repo, "shared/README.md"), "second\n");
  const second = commit(repo);
  writePackage(join(dir, "packages/notes/office.ts"), notes);
  const entries = (ref: string, count: number) => `  - {name: shared, repo: ${repo}, path: shared, ref: ${ref}}\n  - {name: notes, settings: {count: ${count}}}\n`;

  select(entries(first, 4));
  cli(0, "sync", "--packages");
  const published = read(snapshot);

  renameSync(repo, `${repo}-offline`);
  select(entries(second, 9));
  const output = cli(1, "sync", "--packages");

  expect(output).toContain("FAILED .office/packages/shared");
  expect(output).toContain("not publishing the applied settings: package shared is selected but unread");
  expect(read(snapshot)).toBe(published);
  renameSync(`${repo}-offline`, repo);
  cli(0, "sync", "--packages");
  expect(JSON.parse(read(snapshot)).packages.notes.count).toBe(9);
});

test("office settings get reads one package's applied settings from --office alone, whatever the folder, definitions and office.yaml", () => {
  const { dir, env, probe, cli, select } = fixture("reader");
  const other = fixture("reader-other");
  const nested = join(dir, "repos/work/nested");

  writePackage(join(dir, "packages/notes/office.ts"), notes);
  select("  - name: notes\n    settings: {count: 1}\n");
  cli(0, "sync", "--packages");
  writePackage(join(other.dir, "packages/notes/office.ts"), notes);
  other.select("  - name: notes\n    settings: {count: 2}\n");
  other.cli(0, "sync", "--packages");
  // A folder inside the office that is another office's: the working folder never chooses.
  write(join(nested, "office.yaml"), read(join(other.dir, "office.yaml")));

  const get = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync([exe, "settings", "get", ...args], { cwd, env });

    return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  };

  expect(get(nested, "notes", "--office", dir)).toEqual({ status: 0, stdout: `${JSON.stringify({ count: 1, fail: false, label: "notes" }, null, 2)}\n`, stderr: "" });
  expect(JSON.parse(get(nested, "notes", "--office", other.dir).stdout).count).toBe(2);

  // No package is loaded, office.yaml isn't parsed and discovery isn't repaired.
  writePackage(join(dir, "packages/notes/office.ts"), `${marker}\nthrow new Error("unloadable");\n`);
  write(join(dir, "office.yaml"), "name: [unclosed\n");
  rmSync(join(dir, ".office/packages"), { recursive: true });
  expect(get(root, "notes", `--office=${dir}`)).toMatchObject({ status: 0, stderr: "" });
  expect(existsSync(probe)).toBe(false);
  expect(lstatSync(join(dir, ".office/packages"), { throwIfNoEntry: false })).toBeUndefined();

  const failed = (result: ReturnType<typeof get>, message: string) => {
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
  };

  failed(get(root, "absent", "--office", dir), "has no settings for package absent");
  failed(get(dir, "notes"), "usage: office settings get <package> --office <dir>");

  // The established leading form, with a space or =, reads the same way, before any discovery.
  for (const leading of [["--office", dir], [`--office=${dir}`]]) {
    const result = Bun.spawnSync([exe, ...leading, "settings", "get", "notes"], { cwd: nested, env });

    expect({ status: result.exitCode, stdout: JSON.parse(result.stdout.toString()).count, stderr: result.stderr.toString() }).toEqual({ status: 0, stdout: 1, stderr: "" });
  }

  expect(existsSync(probe)).toBe(false);
  expect(lstatSync(join(dir, ".office/packages"), { throwIfNoEntry: false })).toBeUndefined();

  // A malformed file is named, without quoting another package's bytes.
  write(join(dir, snapshotPath), '{"packages": {"other": {"token": "sentinel-bytes"}, "notes": {,}}}');
  failed(get(root, "notes", "--office", dir), `${join(dir, snapshotPath)} is malformed: it isn't JSON`);
  expect(get(root, "notes", "--office", dir).stderr).not.toContain("sentinel-bytes");
  write(join(dir, snapshotPath), '{"packages": {"notes": {"count": 1e999}}}');
  failed(get(root, "notes", "--office", dir), "too large for JSON");
  write(join(dir, snapshotPath), '{"packages": []}');
  failed(get(root, "notes", "--office", dir), `${join(dir, snapshotPath)} is malformed`);
  rmSync(join(dir, snapshotPath));
  failed(get(root, "notes", "--office", dir), `no applied settings at ${join(dir, snapshotPath)}`);
});

test("an office's runtime folder leading to another office's is refused by sync and by readers, and the other office's file is untouched", () => {
  const a = fixture("redirected-a");
  const b = fixture("redirected-b");

  b.cli(0, "sync", "--packages");
  const theirs = read(join(b.dir, snapshotPath));

  rmSync(join(a.dir, ".office/runtime"), { recursive: true, force: true });
  symlinkSync(join(b.dir, ".office/runtime"), join(a.dir, ".office/runtime"));
  a.select("  - name: office\n    settings: {ignore_claude_synced_skills: false}\n");
  expect(a.cli(1, "sync", "--packages")).toContain(`${join(a.dir, ".office/runtime")} is a link or not a folder`);
  expect(a.cli(1, "settings", "get", "office")).toContain("is a link or not a folder");
  expect(read(join(b.dir, snapshotPath))).toBe(theirs);
});

test("a first sync in a Git office made by hand keeps the snapshot out of commits though a package's sync function throws, leaving the owner's files", () => {
  const source = fixture("hand-made-source");
  const dir = join(root, "hand-made");
  const exclude = join(dir, ".git/info/exclude");

  write(join(dir, "office.yaml"), `${read(join(source.dir, "office.yaml"))}  - name: notes\n    settings: {fail: true}\n`);
  writePackage(join(dir, "packages/notes/office.ts"), notes);
  write(join(dir, ".gitignore"), "/owner-ignored\n");
  git(["init", "-q", dir]);
  write(exclude, "# mine\n/owner-excluded\n");

  expect(source.run(exe, 1, "--office", dir, "sync", "--packages")).toContain("late hook failure");
  expect(JSON.parse(read(join(dir, snapshotPath))).packages.notes.fail).toBe(true);
  expect(git(["check-ignore", "-v", snapshotPath], dir)).toStartWith(".git/info/exclude:");
  expect(git(["status", "--porcelain", "--untracked-files=all"], dir)).not.toContain(".office/runtime");
  expect(read(join(dir, ".gitignore"))).toBe("/owner-ignored\n");
  expect(read(exclude)).toStartWith("# mine\n/owner-excluded\n");
  expect(existsSync(join(dir, "packages/notes/.settings.json"))).toBe(false);

  // A block whose markers the owner broke is left as it is, and the sync says so and fails without
  // publishing the new settings: the earlier snapshot stays.
  const broken = `# mine\n${read(exclude).split("\n").find(line => line.startsWith("# office sync"))}\n`;
  const prior = read(join(dir, snapshotPath));

  write(exclude, broken);
  write(join(dir, "office.yaml"), read(join(dir, "office.yaml")).replace("{fail: true}", "{fail: true, count: 9}"));
  expect(source.run(exe, 1, "--office", dir, "sync", "--packages")).toContain("not one block");
  expect(read(exclude)).toBe(broken);
  expect(read(join(dir, snapshotPath))).toBe(prior);
});

test("a first sync in a Git office whose exclude block is broken publishes no snapshot for Git to see", () => {
  const source = fixture("broken-block-source");
  const dir = join(root, "broken-block");
  const exclude = join(dir, ".git/info/exclude");
  const broken = "# mine\n# office sync: its plumbing, rewritten on each sync. Add your own lines outside this block.\n/owner-excluded\n";

  write(join(dir, "office.yaml"), read(join(source.dir, "office.yaml")));
  git(["init", "-q", dir]);
  write(exclude, broken);

  const output = source.run(exe, 1, "--office", dir, "sync", "--packages");

  expect(output).toContain("not one block");
  expect(output).toContain("not publishing the applied settings");
  expect(existsSync(join(dir, snapshotPath))).toBe(false);
  expect(git(["status", "--porcelain", "--untracked-files=all"], dir)).not.toContain(".office/runtime");
  expect(read(exclude)).toBe(broken);
});

test("sync publishes only a snapshot Git ignores: an owner's re-including rule or a tracked snapshot stops it, owner files, index and earlier snapshot kept", () => {
  const source = fixture("visible-source");
  const dir = join(root, "visible");
  const snapshot = join(dir, snapshotPath);
  const negation = "/owner-ignored\n!/.office/runtime/\n";
  const owner = () => ({ gitignore: read(join(dir, ".gitignore")), exclude: read(join(dir, ".git/info/exclude")), index: git(["ls-files", "--stage"], dir), yaml: read(join(dir, "office.yaml")) });
  const sync = (status: number) => source.run(exe, status, "--office", dir, "sync", "--packages");

  write(join(dir, "office.yaml"), read(join(source.dir, "office.yaml")));
  write(join(dir, ".gitignore"), negation);
  git(["init", "-q", dir]);

  // A first sync: the owner's rule outranks Office's exclude block.
  let output = sync(1);

  expect(output).toContain(`Git doesn't ignore ${snapshotPath}: .gitignore:2:!/.office/runtime/ re-includes .office/runtime, so it would be committed`);
  expect(output).toContain("not publishing the applied settings");
  expect(existsSync(snapshot)).toBe(false);
  expect(read(join(dir, ".gitignore"))).toBe(negation);

  // A rule naming the file alone can't re-include it from an excluded folder: Git ignores it, so the same sync publishes.
  write(join(dir, ".gitignore"), `/owner-ignored\n!/${snapshotPath}\n`);
  sync(0);
  expect(git(["check-ignore", "-v", snapshotPath], dir)).toContain("info/exclude:");
  const prior = { text: read(snapshot), inode: statSync(snapshot).ino };

  // A repeat under the rule leaves the earlier snapshot, though the settings changed.
  write(join(dir, ".gitignore"), negation);
  write(join(dir, "office.yaml"), `${read(join(dir, "office.yaml"))}  - name: office\n    settings: {ignore_claude_synced_skills: false}\n`);
  let before = owner();

  expect(sync(1)).toContain(`Git doesn't ignore ${snapshotPath}: .gitignore:2:!/.office/runtime/ re-includes`);
  expect({ text: read(snapshot), inode: statSync(snapshot).ino }).toEqual(prior);
  expect(owner()).toEqual(before);

  // Tracked, it is committable whatever rule matches it.
  write(join(dir, ".gitignore"), "/owner-ignored\n");
  git(["add", "--force", snapshotPath], dir);
  expect(git(["check-ignore", "--no-index", "-q", snapshotPath], dir)).toBe("");
  before = owner();
  output = sync(1);
  expect(output).toContain(`${snapshotPath} is tracked in Git's index`);
  expect({ text: read(snapshot), inode: statSync(snapshot).ino }).toEqual(prior);
  expect(owner()).toEqual(before);
});

test("an office inside another repository's worktree publishes only when that repository ignores the snapshot, and its exclude file is left alone", () => {
  const source = fixture("enclosed-source");
  const enclosing = join(root, "enclosing");
  const dir = join(enclosing, "nested-office");
  const exclude = join(enclosing, ".git/info/exclude");
  const sync = (status: number) => source.run(exe, status, "--office", dir, "sync", "--packages");

  git(["init", "-q", enclosing]);
  write(join(dir, "office.yaml"), read(join(source.dir, "office.yaml")));
  const excluded = read(exclude);

  expect(sync(1)).toContain(`Git doesn't ignore ${snapshotPath}, so it would be committed`);
  expect(existsSync(join(dir, snapshotPath))).toBe(false);
  expect(read(exclude)).toBe(excluded);

  write(join(enclosing, ".gitignore"), "/nested-office/.office/\n");
  expect(sync(1)).toContain("Git doesn't ignore .opencode/plugins/office/");
  expect(existsSync(join(dir, ".opencode/plugins/office"))).toBe(false);
  expect(read(exclude)).toBe(excluded);
  write(join(enclosing, ".gitignore"), "/nested-office/.office/\n/nested-office/.opencode/plugins/office/\n/nested-office/.opencode/plugins/knowledge/\n/nested-office/.opencode/plugins/browser/\n");
  sync(0);
  expect(existsSync(join(dir, snapshotPath))).toBe(true);
  expect(read(exclude)).toBe(excluded);
});

test("an office in a repository's folder or a linked worktree publishes nothing when Git can't be asked, first sync or repeat; an office outside Git publishes without Git", () => {
  const source = fixture("unasked-source");
  const noGit = join(root, "unasked-no-git-bin");
  const main = join(root, "unasked-main");
  const linked = join(root, "unasked-linked");

  for (const name of ["docker", "sops", "age", "age-keygen"]) {
    write(join(noGit, name), read(join(dirname(exe), name)), 0o755);
  }

  const withoutGit = (dir: string) => {
    const result = Bun.spawnSync([exe, "--office", dir, "sync", "--packages"], { cwd: root, env: { ...source.env, PATH: noGit } });

    return { status: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
  };

  git(["init", "-q", "-b", "main", main]);
  write(join(main, ".gitignore"), "/office/.office/\n/office/.opencode/plugins/office/\n/office/.opencode/plugins/knowledge/\n/office/.opencode/plugins/browser/\n");
  commit(main);
  git(["worktree", "add", "-q", "--detach", linked], main);
  // A linked worktree's .git is a file naming its folder in the main repository.
  expect(statSync(join(linked, ".git")).isFile()).toBe(true);

  for (const top of [main, linked]) {
    const dir = join(top, "office");
    const snapshot = join(dir, snapshotPath);
    const owner = () => ({ gitignore: read(join(top, ".gitignore")), exclude: read(join(main, ".git/info/exclude")), index: git(["ls-files", "--stage"], top), status: git(["status", "--porcelain", "--untracked-files=all"], top) });

    const refused = (before: ReturnType<typeof owner>) => {
      const { status, output } = withoutGit(dir);

      expect(status, output).toBe(1);
      expect(output).toContain(`cannot inspect Git's index for installed package files at ${join(realpathSync(top), ".git")}`);
      expect(owner()).toEqual(before);
    };

    write(join(dir, "office.yaml"), read(join(source.dir, "office.yaml")));

    // A first sync without Git publishes nothing.
    refused(owner());
    expect(existsSync(snapshot)).toBe(false);

    // With Git, the repository ignores it, so it is published; then Git goes and the settings change.
    source.run(exe, 0, "--office", dir, "sync", "--packages");
    const prior = { text: read(snapshot), inode: statSync(snapshot).ino };

    write(join(dir, "office.yaml"), `${read(join(dir, "office.yaml"))}  - name: office\n    settings: {ignore_claude_synced_skills: false}\n`);
    refused(owner());
    expect({ text: read(snapshot), inode: statSync(snapshot).ino }).toEqual(prior);
  }

  // Outside any repository, with the same executable and no Git, it is published as before.
  const outside = join(root, "outside-git");

  write(join(outside, "office.yaml"), read(join(source.dir, "office.yaml")));
  expect(withoutGit(outside).status).toBe(0);
  expect(JSON.parse(read(join(outside, snapshotPath))).packages.office).toEqual({ ignore_claude_synced_skills: true, ignore_skill_folders: [] });
});

test("check reports what sessions hide from the applied settings, and compares them by value", () => {
  const { dir, cli, select } = fixture("check-applied");
  const snapshot = join(dir, snapshotPath);

  cli(0, "sync", "--packages");
  // The same settings with the packages' and their settings' keys reversed are still the applied ones.
  const { packages }: { packages: Record<string, AppliedSettings> } = JSON.parse(read(snapshot));
  const reversed = Object.entries(packages).reverse().map(([name, settings]) => [name, Object.fromEntries(Object.entries(settings).reverse())] as const);

  write(snapshot, JSON.stringify({ packages: Object.fromEntries(reversed) }));
  expect(cli(0, "check")).toMatch(/^ok\s+package office: .*settings valid and applied/m);

  // Edited, not yet applied: the report is of what the plugin still hides.
  select("  - name: office\n    settings: {ignore_claude_synced_skills: false, ignore_skill_folders: [unapplied/skills]}\n");
  let checked = cli(1, "check");

  expect(checked).toMatch(/^FAIL\s+package office: .*settings valid, but .* holds other settings for it/m);
  expect(checked).toContain("ignored skill folders: ~/.claude/skills/synced");
  expect(checked).not.toContain("unapplied/skills");

  cli(0, "sync", "--packages");
  checked = cli(0, "check");
  expect(checked).toContain("unapplied/skills");
  expect(checked).not.toContain("ignored skill folders: ~/.claude/skills/synced");
});

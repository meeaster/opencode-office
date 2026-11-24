// The repos package in the compiled office, with local bare upstreams. A wrong declaration is
// named before any Git; full sync clones at the declared ref and afterwards only fetches; a wrong
// origin or an unreachable remote fails its checkout alone; local-only checkouts and package-only
// operations run no Git on checkouts; withdrawal keeps every checkout; the office's own repository
// never takes nested checkouts or scratch work; sessions get the inventory.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.ts";
import { definitionFixture } from "./package-definition.fixture.ts";

const { root, bin, write, commit, fixture, promptEntries } = definitionFixture({ second: false });

/** A bare upstream with a commit on main and, when asked, a `release` branch one commit ahead; its work tree pushes to it. */
function upstream(name: string, release = false) {
  const work = join(root, `${name}-work`);
  const bare = join(root, `${name}.git`);

  mkdirSync(work, { recursive: true });
  git(["init", "-q", "-b", "main", work]);
  writeFileSync(join(work, "README.md"), `${name}\n`);
  commit(work);

  if (release) {
    git(["checkout", "-q", "-b", "release"], work);
    writeFileSync(join(work, "RELEASE.md"), "release\n");
    commit(work);
  }

  git(["clone", "-q", "--bare", work, bare]);
  git(["remote", "add", "origin", bare], work);

  return { url: `file://${bare}`, work };
}

/** A host-mode office selecting repos with `entries`, beside a reference; every Git command is logged with its folder. */
function office(name: string) {
  const f = fixture(name);
  const log = join(f.home, "git.log");
  const manual = upstream(`${name}-manual`);

  write(join(f.home, "bin/git"), `#!/bin/sh\necho "$PWD $*" >> "${log}"\nexec "${bin}/git" "$@"\n`, 0o755);

  const yaml = (entries: string | undefined) => writeFileSync(join(f.dir, "office.yaml"), [
    `name: ${name}`, "opencode: {mode: host, url: 'http://127.0.0.1:1'}", "tools: {sfw: {enabled: false}}",
    "references:", `  - {name: manual, url: '${manual.url}', ref: main, description: A reference}`,
    ...(entries === undefined ? [] : ["packages:", "  - name: repos", "    settings:", "      entries:", entries]), "",
  ].join("\n"));

  /** The Git commands since the last call, each `<folder> <args>`. */
  const calls = () => {
    const lines = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];

    rmSync(log, { force: true });

    return lines;
  };

  /** Commands run in `folder` or naming it. */
  const touching = (lines: string[], folder: string) => lines.filter(line => line.startsWith(`${folder} `) || line.startsWith(`${folder}/`) || line.includes(` ${folder}`));

  return { ...f, manual, yaml, calls, touching, path: (relative: string) => join(f.dir, relative) };
}

/** Everything Git records about a checkout's local state: HEAD, branch, index, changes and file contents. */
function state(dir: string) {
  return {
    head: git(["rev-parse", "HEAD"], dir),
    branch: git(["symbolic-ref", "--short", "HEAD"], dir),
    index: git(["ls-files", "--stage"], dir),
    status: git(["status", "--porcelain", "--untracked-files=all"], dir),
    files: Object.fromEntries(["README.md", "RELEASE.md", "local.txt"].map(file => [file, existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8") : null])),
  };
}

test("a wrong declaration is named and stops the checkouts before any Git runs", () => {
  const o = office("invalid");
  const good = upstream("invalid-good");
  const entry = (text: string) => `        - ${text}\n`;
  const valid = entry(`{name: good, description: Fine, url: '${good.url}'}`);

  // What the settings schema states fails the sync's admission, naming the entry; no set is published.
  for (const [wrong, message] of [
    [entry("{name: ../escape, description: Outside}"), "packages.repos.settings.entries.1.name: must match pattern"],
    [entry("{name: blank, description: '   '}"), "packages.repos.settings.entries.1.description: must match pattern"],
    [entry("{name: pinned, description: A ref without a remote, ref: main}"), "packages.repos.settings.entries.1: must have property url when property ref is present"],
  ]) {
    o.yaml(valid + wrong);
    const output = o.cli(1, "sync");

    expect(output).toContain(message);
    expect(output).toContain("no package's full-sync work ran");
    expect(o.touching(o.calls(), o.path("repos"))).toEqual([]);
    expect(existsSync(o.path("repos"))).toBe(false);
  }

  // A name listed twice passes the schema; the package's setup names it, so admission publishes
  // nothing, full or package-only: no checkout's Git runs and sessions keep the last inventory.
  o.yaml(valid);
  o.cli(0, "sync");
  const inventory = o.cli(0, "instructions", "--packages");

  expect(inventory).toContain("- `repos/good/`: Fine");
  o.calls();

  for (const args of [["sync"], ["sync", "--packages"]]) {
    o.yaml(valid + entry(`{name: good, description: Twice, url: '${good.url}'}`) + entry("{name: extra, description: New}"));
    const twice = o.cli(1, ...args);

    expect(twice, args.join(" ")).toContain("entries[1] (good): name is listed twice");
    expect(twice, args.join(" ")).toContain("no package set was published");
    expect(o.touching(o.calls(), o.path("repos")), args.join(" ")).toEqual([]);
    expect(o.cli(0, "instructions", "--packages"), args.join(" ")).toBe(inventory);
    o.calls();
  }

  expect(o.cli(1, "check")).toMatch(/^FAIL\s+package repos: [^\n]*entries\[1\] \(good\): name is listed twice/m);
});

test("full sync clones at the declared ref and then only fetches; a wrong origin or unreachable remote fails alone, never fetched; local-only checkouts and package-only operations run no Git", () => {
  const o = office("checkouts");
  const alpha = upstream("alpha", true);
  const beta = upstream("beta");
  const other = upstream("other");

  // An existing checkout of another repository where `wrong` goes, and the owner's local-only checkout.
  git(["clone", "-q", other.url, o.path("repos/wrong")]);
  git(["init", "-q", "-b", "main", o.path("repos/notes")]);
  writeFileSync(o.path("repos/notes/today.md"), "notes\n");
  o.yaml([
    `        - {name: alpha, description: The alpha project, url: '${alpha.url}', ref: release}`,
    `        - {name: beta, description: The beta project, url: '${beta.url}'}`,
    `        - {name: gone, description: Unreachable, url: 'file://${root}/absent.git'}`,
    `        - {name: wrong, description: Declared elsewhere, url: '${beta.url}'}`,
    "        - {name: notes, description: Local notes}",
    "        - {name: life, description: Personal planning}",
    "",
  ].join("\n"));
  o.calls();

  const first = o.cli(1, "sync");
  const firstCalls = o.calls();

  expect(first).toContain(`repos: repos/gone/: FAILED: fatal: '${root}/absent.git' does not appear to be a git repository`);
  expect(first).toContain(`repos: repos/wrong/: FAILED: repos/wrong/ has origin ${other.url}, not the declared ${beta.url}; not fetched, and left as it is`);
  expect(first).toContain("repos: repos/alpha/: cloned at release");
  expect(first).toContain("repos: repos/beta/: cloned");
  // The reference completes beside the failures.
  expect(existsSync(o.path("references/manual/README.md"))).toBe(true);
  expect(state(o.path("repos/alpha"))).toMatchObject({ branch: "release", head: git(["rev-parse", "release"], alpha.work) });
  expect(git(["symbolic-ref", "--short", "HEAD"], o.path("repos/beta"))).toBe("main");
  // The wrong origin is read, never fetched; local-only checkouts, present or missing, run no Git at all.
  expect(o.touching(firstCalls, o.path("repos/wrong")).map(line => line.split(" ")[1])).toEqual(["rev-parse", "rev-parse", "config"]);
  expect(o.touching(firstCalls, o.path("repos/notes"))).toEqual([]);
  expect(o.touching(firstCalls, o.path("repos/life"))).toEqual([]);
  expect(existsSync(o.path("repos/life"))).toBe(false);
  expect(git(["remote"], o.path("repos/notes"))).toBe("");

  // The owner's work in a checkout: a staged edit, an unstaged one and an untracked file.
  const checkout = o.path("repos/alpha");

  writeFileSync(join(checkout, "README.md"), "staged\n");
  git(["add", "README.md"], checkout);
  writeFileSync(join(checkout, "RELEASE.md"), "unstaged\n");
  writeFileSync(join(checkout, "local.txt"), "untracked\n");
  const before = state(checkout);

  // Upstream moves ahead on the checked-out branch.
  writeFileSync(join(alpha.work, "RELEASE.md"), "upstream\n");
  const moved = commit(alpha.work);

  git(["push", "-q", "origin", "release"], alpha.work);
  const second = o.cli(1, "sync");

  expect(second).toContain("repos: repos/alpha/: fetched; 1 new upstream commit not merged");
  expect(git(["rev-parse", "origin/release"], checkout)).toBe(moved);
  expect(state(checkout)).toEqual(before);
  expect(o.touching(o.calls(), o.path("repos/wrong")).some(line => / fetch\b/.test(line))).toBe(false);

  // Package-only operations touch no checkout.
  o.cli(0, "sync", "--packages");
  o.cli(0, "packages", "update");
  expect(o.touching(o.calls(), o.path("repos"))).toEqual([]);

  const checked = o.cli(1, "check");

  expect(checked).toMatch(/^WARN\s+package repos: repos\/life\/ is missing; it is local only, so sync doesn't create it/m);
  expect(checked).toMatch(/^FAIL\s+package repos: repos\/wrong\/ has origin /m);
  expect(checked).not.toContain("repos/notes/");
  expect(o.touching(o.calls(), o.path("repos")).some(line => / (fetch|clone)\b/.test(line))).toBe(false);
});

test("withdrawing an entry or the package keeps every checkout and stops managing it; references go on; the office's repository never takes checkouts or scratch work", async () => {
  const o = office("withdrawal");
  const alpha = upstream("withdrawn-alpha");

  o.yaml([`        - {name: alpha, description: The alpha project, url: '${alpha.url}'}`, "        - {name: notes, description: Local notes}", ""].join("\n"));
  o.cli(0, "sync");
  git(["init", "-q", o.path("repos/notes")]);
  writeFileSync(o.path("repos/notes/today.md"), "notes\n");
  writeFileSync(o.path("repos/alpha/local.txt"), "mine\n");
  git(["add", "local.txt"], o.path("repos/alpha"));
  git(["-c", "user.name=Owner", "-c", "user.email=owner@example.com", "commit", "-qm", "local"], o.path("repos/alpha"));
  write(o.path("scratch/wip/draft.md"), "draft\n");
  const kept = state(o.path("repos/alpha"));
  // The office's own repository: what `git add -A` would take.
  const added = () => git(["add", "--all", "--dry-run"], o.dir);

  expect(added()).not.toMatch(/repos\/|scratch\//);
  expect(o.cli(0, "instructions", "--packages")).toContain("- `repos/alpha/`: The alpha project");

  // Withdrawing the entry: the checkout stays, sync leaves it alone and sessions stop listing it.
  o.yaml("        - {name: notes, description: Local notes}\n");
  o.calls();
  o.cli(0, "sync");
  expect(o.touching(o.calls(), o.path("repos"))).toEqual([]);
  expect(state(o.path("repos/alpha"))).toEqual(kept);
  expect(o.cli(0, "instructions", "--packages")).not.toContain("repos/alpha/");

  // Deselecting the package: the same, and no inventory at all.
  o.yaml(undefined);
  o.calls();
  o.cli(0, "sync");
  expect(o.touching(o.calls(), o.path("repos"))).toEqual([]);
  expect(state(o.path("repos/alpha"))).toEqual(kept);
  expect(readFileSync(o.path("repos/notes/today.md"), "utf8")).toBe("notes\n");
  expect(o.cli(0, "instructions", "--packages")).toBe("");
  expect(await promptEntries(o.dir, o.path("repos/alpha"))).not.toHaveProperty("packages");
  expect(added()).not.toMatch(/repos\/|scratch\//);

  // A read-only reference is the references' own: it still updates to its ref.
  writeFileSync(join(o.manual.work, "README.md"), "moved\n");
  const moved = commit(o.manual.work);

  git(["push", "-q", "origin", "main"], o.manual.work);
  o.cli(0, "sync", "--references");
  expect(git(["rev-parse", "HEAD"], o.path("references/manual"))).toBe(moved);

  // Rules that no longer ignore repos/ fail check, which leaves the owner's .gitignore as it is.
  const ignore = readFileSync(o.path(".gitignore"), "utf8");

  expect(o.cli(1, "check")).not.toContain("is not ignored");
  writeFileSync(o.path(".gitignore"), ignore.replace("/repos/\n", ""));
  expect(o.cli(1, "check")).toContain("repos/ is not ignored by the office's Git rules, so its checkouts could be committed into the office; add /repos/ to .gitignore");
  expect(readFileSync(o.path(".gitignore"), "utf8")).toBe(ignore.replace("/repos/\n", ""));
});

test("every session gets the whole inventory, missing local checkouts included, wherever it starts; sync applies a changed description and a withdrawn entry", async () => {
  const o = office("inventory");
  const alpha = upstream("listed-alpha");
  const listed = (description: string) => [`        - {name: alpha, description: The alpha project, url: '${alpha.url}'}`, `        - {name: life, description: ${description}}`, ""].join("\n");

  o.yaml(listed("Personal planning"));
  o.cli(0, "sync");
  write(o.path("repos/alpha/AGENTS.md"), "# Alpha's own instructions\n");
  const text = o.cli(0, "instructions", "--packages");

  expect(text).toContain("# Working repositories");
  expect(text).toContain("- `repos/alpha/`: The alpha project\n- `repos/life/`: Personal planning (local only, missing here)");

  // The installed plugin attaches the same text at the root and inside a checkout, beside the office guidance.
  const atRoot = await promptEntries(o.dir, o.dir);
  const inside = await promptEntries(o.dir, o.path("repos/alpha"));

  expect(atRoot.packages).toBe(text.trim());
  expect(inside.packages).toBe(text.trim());
  expect(inside.office).toBe(atRoot.office);
  expect(atRoot.office).not.toMatch(/\bdesks?\b/i);

  o.yaml(`        - {name: life, description: Plans and journal}\n`);
  o.cli(0, "sync");
  const changed = (await promptEntries(o.dir, o.path("repos/alpha"))).packages;

  expect(changed).toContain("- `repos/life/`: Plans and journal (local only, missing here)");
  expect(changed).not.toContain("repos/alpha/");
  expect(existsSync(o.path("repos/alpha/AGENTS.md"))).toBe(true);
});

test("fresh setup plans each declared remote for pushing from office.yaml as it is, asks nothing for a local-only entry, and a wrong entry stops it before any read or clone", () => {
  const f = fixture("fresh-setup");
  const log = join(f.home, "git.log");
  const miseVersion = "2026.11.11";
  const work = join(root, "setup-site-work");

  // A GitHub URL that reads from a local bare repository: offline, and still on the GitHub host for planning.
  mkdirSync(work, { recursive: true });
  git(["init", "-q", "-b", "main", work]);
  writeFileSync(join(work, "README.md"), "site\n");
  commit(work);
  git(["clone", "-q", "--bare", work, join(root, "github/site.git")]);
  write(join(f.home, ".gitconfig"), `[url "file://${root}/github/"]\n\tinsteadOf = https://github.com/example/\n`);
  write(join(f.home, "bin/git"), `#!/bin/sh\necho "$*" >> "${log}"\nexec "${bin}/git" "$@"\n`, 0o755);
  // Setup's tool checks pass; the services it would start later don't.
  write(join(f.home, "bin/docker"), "#!/bin/sh\nexit 0\n", 0o755);
  write(join(f.home, "bin/mise"), `#!/bin/sh\nif [ "$1" = --version ]; then echo "${miseVersion} linux-x64 (2026-01-01)"; exit 0; fi\nexit 1\n`, 0o755);
  write(join(f.home, "state/office-executor.env"), "EXECUTOR_TOKEN=test\n");

  const setup = (entries: string) => {
    writeFileSync(join(f.dir, "office.yaml"), [
      "name: fresh-setup", `state: ${join(f.home, "state")}`, "opencode: {mode: host, url: 'http://127.0.0.1:1'}",
      `tools: {sfw: {enabled: false}, mise: ${miseVersion}}`, "git: {name: Test, email: test@example.com}",
      "packages:", "  - name: repos", "    settings:", "      entries:", entries, "",
    ].join("\n"));
    // As a fresh clone of the office has it: no package set, applied settings or pulled-in packages.
    rmSync(join(f.dir, ".office"), { recursive: true, force: true });
    rmSync(log, { force: true });
    const result = Bun.spawnSync([join(bin, "office"), "--office", f.dir, "setup"], { cwd: root, env: f.env });

    return { output: result.stdout.toString() + result.stderr.toString(), calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [] };
  };

  const site = "        - {name: site, description: The website, url: 'https://github.com/example/site.git'}";
  const planned = setup(`${site}\n        - {name: diary, description: Local only}`);

  expect(planned.output).toContain("repos site reads without a login, but agents can't push to it without one");
  expect(planned.output).not.toContain("diary");
  const firstClone = planned.calls.findIndex(call => /^clone\b/.test(call));
  const reads = planned.calls.flatMap((call, index) => call.endsWith("ls-remote https://github.com/example/site.git HEAD") ? [index] : []);

  expect(reads.length, planned.calls.join("\n")).toBeGreaterThanOrEqual(2);
  expect(firstClone === -1 || reads.every(index => index < firstClone)).toBe(true);
  expect(planned.calls.some(call => call.includes("diary"))).toBe(false);

  // The first setup went on to sync and clone; this one must not get that far.
  rmSync(join(f.dir, "repos"), { recursive: true, force: true });
  const wrong = setup(`${site}\n        - {name: site, description: Twice}`);

  expect(wrong.output).toContain("package repos: its access declaration failed: entries[1] (site): name is listed twice");
  expect(wrong.output).toContain("so nothing was cloned");
  expect(wrong.calls.filter(call => /\b(ls-remote|clone|fetch)\b/.test(call))).toEqual([]);
  expect(existsSync(join(f.dir, "repos"))).toBe(false);
});

test("sync fetches only a checkout of the office's own, only from where its declared URL leads, only into remote-tracking branches; check and sessions classify each folder the same way", () => {
  const o = office("effective");
  const beta = upstream("effective-beta");
  const other = upstream("effective-other");
  const credentialed = "https://user:s3cret@example.invalid/cred.git";
  const outside = join(root, "effective-outside");

  // Where git fetches from is the first origin URL, not the last one `git config --get` reads.
  git(["clone", "-q", other.url, o.path("repos/dual")]);
  git(["config", "--add", "remote.origin.url", beta.url], o.path("repos/dual"));
  // The checkout's own rule sends its origin elsewhere.
  git(["clone", "-q", beta.url, o.path("repos/bent")]);
  git(["config", `url.${other.url}.insteadOf`, beta.url], o.path("repos/bent"));
  // An origin with credentials in it, never shown.
  git(["init", "-q", o.path("repos/cred")]);
  git(["remote", "add", "origin", credentialed], o.path("repos/cred"));
  // A link to a checkout elsewhere, and a linked worktree whose metadata is elsewhere.
  git(["clone", "-q", beta.url, outside]);
  symlinkSync(outside, o.path("repos/linked"));
  git(["worktree", "add", "-q", "-b", "away", o.path("repos/away")], outside);
  // A file, and an owner's plain folder, where checkouts are declared.
  write(o.path("repos/file"), "a file\n");
  write(o.path("repos/plain/notes.md"), "notes\n");
  o.yaml([
    `        - {name: beta, description: Beta, url: '${beta.url}'}`,
    `        - {name: relative, description: Relative to the office, url: '../effective-other.git'}`,
    `        - {name: dual, description: Two origins, url: '${beta.url}'}`,
    `        - {name: bent, description: Rewritten, url: '${beta.url}'}`,
    "        - {name: cred, description: Credentials, url: 'https://example.invalid/cred.git'}",
    `        - {name: linked, description: A link, url: '${beta.url}'}`,
    `        - {name: away, description: Elsewhere, url: '${beta.url}'}`,
    `        - {name: file, description: A file, url: '${beta.url}'}`,
    "        - {name: plain, description: A plain folder}",
    "",
  ].join("\n"));
  o.cli(1, "sync");
  // A worktree of a checkout under repos/ shares its metadata there, so it is fetched like it.
  git(["worktree", "add", "-q", "-b", "side", o.path("repos/beta-side")], o.path("repos/beta"));
  writeFileSync(o.path("office.yaml"), readFileSync(o.path("office.yaml"), "utf8").replace("        - {name: relative", `        - {name: beta-side, description: A worktree, url: '${beta.url}'}\n        - {name: relative`));

  // The owner's own fetch mapping into local branches, pruning and tags: none applies.
  const mapped = o.path("repos/beta");

  git(["config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"], mapped);
  git(["config", "fetch.prune", "true"], mapped);
  git(["checkout", "-q", "-b", "work"], mapped);
  git(["branch", "-q", "keep", "origin/main"], mapped);
  const kept = git(["rev-parse", "refs/heads/keep"], mapped);

  git(["push", "-q", "origin", "main:old"], beta.work);
  o.cli(1, "sync");
  git(["push", "-q", "origin", ":old"], beta.work);
  writeFileSync(join(beta.work, "README.md"), "moved\n");
  const moved = commit(beta.work);

  git(["tag", "v1"], beta.work);
  git(["push", "-q", "origin", "main", "v1"], beta.work);
  o.calls();
  const synced = o.cli(1, "sync");
  const calls = o.calls();
  const fetched = (name: string) => o.touching(calls, o.path(`repos/${name}`)).some(line => / fetch\b/.test(line));

  expect(synced).toMatch(/repos: repos\/beta\/: fetched/);
  expect(synced).toMatch(/repos: repos\/beta-side\/: fetched/);
  expect(synced).toMatch(/repos: repos\/relative\/: fetched/);
  expect(synced).toContain(`repos/dual/ has origin ${other.url}, not the declared ${beta.url}; not fetched`);
  expect(synced).toContain(`repos/bent/ fetches origin from ${other.url}, not from ${beta.url}`);
  expect(synced).toContain("repos/cred/ has origin https://***@example.invalid/cred.git, not the declared https://example.invalid/cred.git");
  expect(synced).not.toContain("s3cret");
  expect(synced).toContain("repos/linked/ is a link; sync writes only to folders of the office's own; not fetched");
  expect(synced).toContain("repos/away/ keeps its Git metadata outside repos/; sync writes only to folders of the office's own; not fetched");
  expect(synced).toContain("repos/file/ is not a folder; not fetched");

  for (const name of ["dual", "bent", "cred", "linked", "away", "file"]) expect(fetched(name), name).toBe(false);
  // Only remote-tracking branches moved: the owner's branches, a pruned branch's tracking ref and tags are as they were.
  expect(git(["rev-parse", "refs/remotes/origin/main"], mapped)).toBe(moved);
  expect(git(["rev-parse", "refs/heads/keep"], mapped)).toBe(kept);
  expect(git(["rev-parse", "refs/heads/main"], mapped)).toBe(kept);
  expect(git(["for-each-ref", "--format=%(refname)", "refs/remotes/origin/old", "refs/tags"], mapped)).toBe("refs/remotes/origin/old");
  expect(readFileSync(join(outside, "README.md"), "utf8")).toBe("effective-beta\n");

  const checked = o.cli(1, "check");

  for (const name of ["dual", "bent", "cred", "linked", "away", "file"]) expect(checked, name).toMatch(new RegExp(`^FAIL\\s+package repos: repos/${name}/ `, "m"));
  expect(checked).toMatch(/^WARN\s+package repos: repos\/plain\/ is not a Git checkout of its own/m);
  expect(checked).not.toContain("s3cret");
  expect(checked).not.toMatch(/repos\/(beta|beta-side|relative)\//);

  const text = o.cli(0, "instructions", "--packages");

  expect(text).toContain("- `repos/file/`: A file (not a checkout here: is not a folder)");
  expect(text).toContain("- `repos/plain/`: A plain folder (local only, not a checkout here: is not a Git checkout of its own)");
  expect(text).toContain("- `repos/beta/`: Beta\n");
});

test("a repos folder that is a link is no place for sync to write; verbose sync shows Git's progress as it comes", () => {
  const o = office("linked-root");
  const beta = upstream("linked-root-beta");
  const elsewhere = join(root, "linked-root-elsewhere");

  mkdirSync(elsewhere);
  symlinkSync(elsewhere, o.path("repos"));
  o.yaml(`        - {name: beta, description: Beta, url: '${beta.url}'}\n`);
  expect(o.cli(1, "sync")).toContain("repos/beta/ is inside repos/, which is a link; sync writes only to folders of the office's own; not fetched");
  expect(readdirSync(elsewhere)).toEqual([]);

  // Without --verbose, Git says only what went wrong; with it, its progress shows under the item.
  rmSync(o.path("repos"));
  expect(o.cli(0, "sync")).not.toContain("Cloning into");
  o.yaml(`        - {name: beta, description: Beta, url: '${beta.url}'}\n        - {name: again, description: Again, url: '${beta.url}'}\n`);
  expect(o.cli(0, "sync", "--verbose")).toMatch(/repos: repos\/again\/[^\n]*\n(?:[^\n]*\n)*?[^\n]*Cloning into/);
});

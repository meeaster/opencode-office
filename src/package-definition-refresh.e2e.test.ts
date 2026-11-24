import { expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.ts";
import { definitionFixture } from "./package-definition.fixture.ts";
import { definitionText, writePackage } from "./test-package.ts";

const { root, bin, exe, variant, marker, write, read, commit, prompt, fixture, collector, pausedRefresh, published } = definitionFixture();

test("a compiled office records the references it resolved, in the gathering's order, and refreshes from that record", async () => {
  const { dir, home, probe, cli } = fixture("references");
  const yaml = join(dir, "office.yaml");
  const applied = join(dir, ".office/resolved/references.json");
  const local = join(dir, "packages/manual/office.ts");
  const checkout = join(dir, "references/manual");
  const floci = "https://github.com/floci-io/floci.git";
  const upstream = join(dir, "origin");
  const wanted = "../../origin"; // Git resolves file remotes from the checkout.
  git(["init", "-qb", "main", upstream]);
  write(join(upstream, "document"), "first");
  const first = commit(upstream);
  // Keep the built-in's real Git URL in its checkout. Git transports it over a local mirror.
  write(join(home, ".gitconfig"), `[url "${upstream}"]\n\tinsteadOf = ${floci}\n`);

  const configure = (packages: string[], owner = "z-owner") => write(yaml, `name: refs
references: [{name: ${owner}, url: ${wanted}}, {name: a-owner, url: ${wanted}}]
packages: [${packages.join(", ")}]
`);

  const aws = "{name: aws-emulator}";
  const manual = "{name: manual}";
  const definition = (body: string) => writePackage(local, definitionText(`{async setup({add}) {${body}}}`, `${marker}`));
  const add = (name: string, url = wanted) => `add({id:"references.repository",parse:e=>e},{name:"${name}",url:"${url}"});`;
  const broken = () => definition(`${add("partial")} await Promise.resolve(); throw Error("collector interrupted");`);
  const list = () => published(dir);
  const head = (repo: string) => git(["rev-parse", "HEAD"], repo);
  const names = (text: string) => text.trimEnd().split("\n").map(line => line.split("\t")[0]);

  const verifyPrompt = async (folder: string) => {
    const instructions = cli(0, "instructions", folder).trimEnd();
    expect(await prompt(dir, folder)).toBe(instructions);

    return instructions;
  };

  rmSync(applied);
  configure([manual, aws]);
  broken();
  // A selected package not synced yet stops the command before any package loads, the broken one included.
  const unsynced = cli(1, "references", "list");
  expect(unsynced).toContain("package aws-emulator: not synced yet; run office sync");
  expect(unsynced).not.toContain("collector interrupted");
  // A setup that throws publishes nothing and records nothing.
  expect(cli(1, "sync", "--packages")).toContain("FAILED package manual: collector interrupted");
  expect(existsSync(applied)).toBe(false);
  expect(existsSync(join(dir, "references/floci"))).toBe(false);

  definition(add("manual"));
  // A switch that can't record its references (a folder where the file goes) exits 1 and clones none.
  mkdirSync(join(applied, "occupied"), { recursive: true });
  const pointer = readlinkSync(join(dir, ".office/current"));
  expect(cli(1, "sync")).toMatch(/FAILED the references were not recorded \(.*\), so no reference checkout is cloned or updated; run office sync again/);
  expect(readlinkSync(join(dir, ".office/current"))).not.toBe(pointer);
  expect(existsSync(checkout)).toBe(false);
  expect(existsSync(join(dir, "references/floci"))).toBe(false);
  rmSync(applied, { recursive: true });
  cli(0, "sync");
  expect(lstatSync(applied).isFile()).toBe(true);
  expect(existsSync(join(dir, ".office/current/references.json"))).toBe(false);
  // office.yaml's own first, then the packages' in the order they were set up: manual before floci, not alphabetically.
  expect(names(list())).toEqual(["z-owner", "a-owner", "manual", "floci"]);
  expect(cli(0, "references", "list")).toBe(list());
  expect(JSON.parse(read(applied)).references.find((row: { name: string }) => row.name === "floci")).toEqual({ name: "floci", url: floci, ref: "main", description: expect.any(String), owner: "aws-emulator" });
  expect(read(applied)).not.toContain(dir);
  expect(head(checkout)).toBe(first);
  expect(head(join(dir, "references/floci"))).toBe(first);
  configure([aws, manual]);
  cli(0, "sync", "--packages");
  expect(names(list())).toEqual(["z-owner", "a-owner", "floci", "manual"]);
  expect(cli(0, "references", "list")).toBe(list());
  const recorded = read(applied);
  // Deliver just the applied file and YAML at another root, without the packages.
  const moved = fixture("relocated");
  write(join(moved.dir, "office.yaml"), read(yaml));
  write(join(moved.dir, ".office/resolved/references.json"), recorded);
  cpSync(upstream, join(moved.dir, "origin"), { recursive: true });
  write(join(moved.home, ".gitconfig"), `[url "${moved.dir}/origin"]\n\tinsteadOf = ${floci}\n`);
  moved.cli(0, "sync", "--references");
  expect(head(join(moved.dir, "references/manual"))).toBe(first);
  expect(existsSync(join(moved.dir, "packages/manual"))).toBe(false);

  configure([aws, manual], "floci");
  write(yaml, read(yaml) + `plugins: [{name: fixture, repo: ${upstream}}]\n`);
  write(join(checkout, "document"), "keep through rejection");
  expect(cli(1, "sync")).toContain("floci claimed by both office.yaml and package aws-emulator");
  // Steps outside packages still run; the applied file and the reference checkouts stay.
  expect(head(join(dir, ".opencode/plugins/fixture"))).toBe(first);
  expect(read(applied)).toBe(recorded);
  expect(read(join(checkout, "document"))).toBe("keep through rejection");
  configure(["{name: aws-emulator, settings: {source_reference: false}}", manual], "floci");
  cli(0, "sync", "--packages");
  expect(list()).toContain("floci\t../../origin\toffice.yaml");
  configure([aws, manual]);
  cli(0, "sync", "--packages");
  const restored = read(applied);

  write(join(upstream, "document"), "second");
  const second = commit(upstream);
  broken();
  // A rejected sync clones and updates no reference; a refresh applies what the last sync recorded.
  expect(cli(1, "sync")).toContain("collector interrupted");
  expect(head(checkout)).toBe(first);
  expect(read(applied)).toBe(restored);
  writePackage(local, `${marker} throw Error("never import on read");`);
  // Help loads packages too, and names the one that failed.
  expect(cli(0, "--help")).toMatch(/references list[\s\S]*package manual: .*never import on read/);
  rmSync(probe);
  cli(0, "sync", "--references");
  expect(head(checkout)).toBe(second);
  const nested = join(dir, "repos/work/nested");
  mkdirSync(nested, { recursive: true });
  const texts: string[] = [];

  // Every folder of the office gets the same guidance.
  for (const folder of [dir, nested]) {
    const text = await verifyPrompt(folder);
    expect(text).toContain("references/floci/");
    expect(text).toContain("references/manual/` (package manual)");
    texts.push(text);
  }

  expect(texts[1]).toBe(texts[0]);

  expect(existsSync(probe)).toBe(false);
  git(["remote", "set-url", "origin", "../../foreign"], checkout);
  expect(cli(1, "sync", "--references")).toContain(`expected origin ${wanted}, found ../../foreign`);
  git(["remote", "set-url", "origin", wanted], checkout);

  // A new desired origin is not permission to replace, fetch or clean the old checkout.
  const changed = "../../other-origin";
  definition(add("manual", changed));
  cli(0, "sync", "--packages");
  write(join(checkout, "document"), "preserved");

  for (const args of [["sync", "--references"], ["check"]]) {
    expect(cli(1, ...args)).toContain(`expected origin ${changed}, found ${wanted}`);
    expect(head(checkout)).toBe(second);
    expect(read(join(checkout, "document"))).toBe("preserved");
  }

  definition("");
  configure([manual]);
  cli(0, "sync", "--packages");
  expect(list()).not.toContain("manual");
  expect(list()).not.toContain("floci");
  expect(await verifyPrompt(nested)).not.toContain("references/manual/");
  expect(read(join(checkout, "document"))).toBe("preserved");
  expect(head(join(dir, "references/floci"))).toBe(second);

  // An applied file that isn't valid is named, never read as empty, and touches no checkout.
  write(applied, "{");
  const refused = cli(1, "sync", "--references");
  expect(refused).toContain(".office/resolved/references.json");
  const guidance = await verifyPrompt(nested);
  expect(guidance).toContain(".office/resolved/references.json");
  expect(guidance).not.toContain("references/z-owner/");
  expect(read(join(checkout, "document"))).toBe("preserved");
  cli(0, "sync", "--packages");
  expect(names(list())).toEqual(["z-owner", "a-owner"]);
}, 60_000);

test("a broken new pin of a Git package publishes nothing; the recorded references stay the last sync's", () => {
  const { dir, cli, select } = fixture("source-change");
  const repo = join(root, "source-change-repo");
  const module = join(repo, "pkg/office.ts");
  const setup = `add({id:"references.repository",parse:e=>e},{name:"remote-docs",url:"../../local"});`;

  const publish = (body: string) => {
    writePackage(module, definitionText(`{setup({add}){${body}}}`), { name: "docs" });
    select(`  - {name: docs, repo: ${repo}, path: pkg, ref: ${commit(repo)}}\n`);
  };

  git(["init", "-q", repo]);
  publish(setup);
  cli(0, "sync", "--packages");
  expect(cli(0, "references", "list")).toContain("remote-docs");
  const current = readlinkSync(join(dir, ".office/current"));
  publish(`${setup} throw Error("bad new pin");`);
  expect(cli(1, "sync", "--packages")).toContain("bad new pin");
  expect(readlinkSync(join(dir, ".office/current"))).toBe(current);
  expect(cli(0, "instructions", dir)).toContain("references/remote-docs/` (package docs)");
  // The installed copy is still the old pin's: the command doesn't load it under the new pin.
  expect(cli(1, "references", "list")).toContain("package docs: ");
  expect(existsSync(join(dir, "node_modules"))).toBe(false);
  publish('add({id:"references.repository",parse:e=>e},{name:"../outside",url:"../../local"});');
  expect(cli(1, "sync", "--packages")).toContain("value.name:");
  expect(published(dir)).not.toContain("../outside");
  expect(cli(0, "instructions", dir)).not.toContain("../outside");
}, 60_000);

test("check compares a checkout with the last applied origin, ref and commit", () => {
  const f = fixture("refresh-records");
  const repo = join(root, "apply-upstream");
  git(["init", "-qb", "main", repo]);
  write(join(repo, "document"), "main");
  const main = commit(repo);
  git(["switch", "-qc", "release"], repo);
  write(join(repo, "document"), "release");
  const release = commit(repo);
  git(["switch", "-q", "main"], repo);
  const yaml = join(f.dir, "office.yaml");
  const initial = read(yaml);

  const select = (ref: string) => {
    write(yaml, initial.replace("references: []", `references: [{name: docs, url: ${repo}, ref: ${ref}}]`));
    f.cli(0, "sync", "--packages");
  };

  const dir = join(f.dir, "references/docs");
  const record = () => JSON.parse(git(["config", "--get", "office.appliedReference"], dir));
  select("main");
  f.cli(0, "sync", "--references");
  select("release");
  f.cli(0, "sync", "--references");
  expect(git(["rev-parse", "HEAD"], dir)).toBe(release);
  expect(read(join(dir, "document"))).toBe("release");
  expect(record()).toEqual({ origin: repo, ref: "release", commit: release });
  git(["checkout", "--detach", main], dir);
  expect(f.cli(1, "check")).toContain(`expected applied commit ${release}, found HEAD ${main}`);
  select("main");
  expect(f.cli(1, "check")).toContain(`last applied ${repo} @ release`);
  f.cli(0, "sync", "--references");
  expect(record()).toEqual({ origin: repo, ref: "main", commit: main });
}, 60_000);

for (const signal of ["SIGTERM", "SIGKILL"] as const) {
  test(`a checkout's lease stays with real Git after parent-only ${signal}`, async () => {
    const f = fixture(`orphan-${signal.toLowerCase()}`);
    const upstream = join(f.home, "source");
    const other = join(f.home, "other-source");

    for (const repo of [upstream, other]) {
      git(["init", "-qb", "main", repo]);
      write(join(repo, "a"), "original");
      write(join(repo, "z"), "original");
      write(join(repo, ".gitattributes"), "a filter=barrier\n");
      commit(repo);
    }

    const yaml = join(f.dir, "office.yaml");
    const original = read(yaml);
    const selected = original.replace("references: []", `references: [{name: docs, url: ${upstream}}, {name: other, url: ${other}}]`);
    write(yaml, selected);
    f.cli(0, "sync");
    const docs = join(f.dir, "references/docs");
    const gate = mkdtempSync(join(root, "smudge-"));
    const go = join(gate, "go");
    const entered = join(gate, "entered");
    const exited = join(gate, "git-exited");
    const pid = join(gate, "git-pid");
    // The witness waits for the actual Git child to exit. Neither the witness nor
    // the paused filter keeps fd 3: after Office dies it is Git's lease alone.
    write(join(f.home, "bin/git"), `#!/bin/sh
if [ -z "\${SMUDGE_GATE:-}" ] || [ "$PWD" != "$GATED_DIR" ] || [ "$1" != checkout ]; then exec "${bin}/git" "$@"; fi
"${bin}/git" "$@" &
gitpid=$!
exec 3>&-
echo "$gitpid" > "$SMUDGE_GATE/git-pid"
wait "$gitpid"
status=$?
echo "$status" > "$SMUDGE_GATE/git-exited"
exit "$status"
`, 0o755);
    write(join(f.home, "bin/office-test-smudge"), `#!/bin/sh
exec 3>&-
if [ -n "\${SMUDGE_GATE:-}" ]; then
  : > "$SMUDGE_GATE/entered"
  while [ ! -f "$SMUDGE_GATE/go" ]; do /bin/sleep 0.02; done
fi
exec /bin/cat
`, 0o755);
    git(["config", "filter.barrier.smudge", "office-test-smudge"], docs);
    write(join(upstream, "a"), "update");
    write(join(upstream, "z"), "update");
    const expected = commit(upstream);
    const generation = join(f.dir, ".office/resolved/references.json");
    const before = read(generation);

    const parent = Bun.spawn([exe, "--office", f.dir, "sync", "--references"], {
      env: { ...f.env, SMUDGE_GATE: gate, GATED_DIR: docs }, stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });

    async function waitForFile(path: string) {
      for (let i = 0; i < 500 && !existsSync(path); i++) await Bun.sleep(20);
      expect(existsSync(path), path).toBe(true);
    }

    try {
      await waitForFile(entered);
      await waitForFile(pid);
      expect(git(["config", "office.appliedReference"], docs)).toBe("null");
      expect(f.cli(1, "sync", "--references")).toContain("reference docs: checkout lease unavailable");

      parent.kill(signal);
      await parent.exited;
      expect(parent.signalCode).toBe(signal);
      expect(existsSync(exited)).toBe(false);

      if (process.platform === "linux") {
        const proc = `/proc/${read(pid).trim()}`;
        expect(readlinkSync(`${proc}/fd/3`)).toBe(join(f.dir, ".office/resolved/checkout-leases/docs.lock"));
        expect(read(`${proc}/fdinfo/3`)).toMatch(/^lock:\s+\d+: FLOCK\s+ADVISORY\s+WRITE\b/m);
      }

      // With the parent gone, the Git child still holds the checkout's lease.
      expect(f.cli(1, "sync", "--references")).toContain("reference docs: checkout lease unavailable");
      expect(read(generation)).toBe(before);
    } finally {
      write(go, "");

      if (parent.exitCode === null && !parent.signalCode) parent.kill();
      await parent.exited;
    }

    await waitForFile(exited);
    expect(read(exited).trim()).toBe("0");
    expect(git(["rev-parse", "HEAD"], docs)).toBe(expected);
    expect(git(["config", "office.appliedReference"], docs)).toBe("null");
    write(yaml, original);
    f.cli(0, "sync", "--packages");
    write(join(docs, "z"), "mine after successful withdrawal");
    f.cli(0, "sync", "--references");
    expect(read(join(docs, "z"))).toBe("mine after successful withdrawal");
    write(yaml, selected);
    f.cli(0, "sync");
    expect(JSON.parse(git(["config", "office.appliedReference"], docs)).commit).toBe(expected);
  }, 60_000);
}

test("two refreshes never work on one checkout at once: the second runs no Git on it and fails naming it", async () => {
  const f = fixture("clone-overlap");
  const repo = join(root, "queued-upstream");
  git(["init", "-qb", "main", repo]);
  write(join(repo, "document"), "upstream");
  const sha = commit(repo);
  const log = join(f.home, "git.log");

  const select = (names: string[]) => {
    write(join(f.dir, "office.yaml"), JSON.stringify({ name: "overlap", references: names.map(name => ({ name, url: repo })) }));
    f.cli(0, "sync", "--packages");
  };

  /** A second refresh, logging each Git command it runs with the folder it runs in. */
  const second = () => {
    const result = Bun.spawnSync([exe, "--office", f.dir, "sync", "--references"], { cwd: root, env: { ...f.env, GIT_LOG: log } });

    return { status: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
  };

  // Paused inside the fetch of an existing checkout.
  select(["docs"]);
  f.cli(0, "sync", "--references");
  write(join(repo, "document"), "advanced");
  const advanced = commit(repo);
  const first = await pausedRefresh(f);
  const overlap = second();
  expect(overlap.status).toBe(1);
  expect(overlap.output).toContain("reference docs: checkout lease unavailable");
  expect(existsSync(log) ? read(log) : "").not.toContain(join(f.dir, "references/docs"));
  await first.resume(0);
  expect(git(["rev-parse", "HEAD"], join(f.dir, "references/docs"))).toBe(advanced);
  // Unopposed, the same refresh does run Git there: the log sees it.
  expect(second().status).toBe(0);
  expect(read(log)).toContain(join(f.dir, "references/docs"));

  // With Office killed inside the fetch, the fetch it started still holds the checkout's lease.
  write(join(repo, "document"), "orphaned");
  commit(repo);
  const orphan = await pausedRefresh(f);
  await orphan.kill();
  expect(second().output).toContain("reference docs: checkout lease unavailable");
  orphan.release();

  for (let i = 0; i < 100 && second().status !== 0; i++) await Bun.sleep(20);
  expect(git(["rev-parse", "HEAD"], join(f.dir, "references/docs"))).toBe(git(["rev-parse", "HEAD"], repo));
  git(["reset", "-q", "--hard", advanced], repo);

  // Paused inside the fetch of a fresh clone: the second never creates the checkout.
  select(["fresh"]);
  const fresh = join(f.dir, "references/fresh");
  const loser = await pausedRefresh(f);
  expect(second().output).toContain("reference fresh: checkout lease unavailable");
  expect(existsSync(fresh)).toBe(false);
  await loser.resume(0);
  expect(git(["rev-parse", "HEAD"], fresh)).toBe(advanced);

  // A clone queued behind another finds the checkout a later refresh made, and leaves it.
  select(["a", "b", "c", "d", "queued"]);
  const old = await pausedRefresh(f, 4);
  select(["queued"]);
  const queued = join(f.dir, "references/queued");
  f.cli(0, "sync", "--references");
  write(join(queued, "document"), "winner");
  expect(await old.resume(1)).toContain("reference checkout already exists");
  expect(read(join(queued, "document"))).toBe("winner");

  select(["interrupted"]);
  const interrupted = await pausedRefresh(f);
  interrupted.interrupt();
  await interrupted.resume(130);
  expect(existsSync(join(f.dir, "references/interrupted"))).toBe(false);
  f.cli(0, "sync", "--references");
  expect(read(join(f.dir, "references/interrupted/document"))).toBe("advanced");
  expect(sha).not.toBe(advanced);
}, 60_000);

test.skipIf(process.getuid?.() === 0)("a failed materialization matches only the wanted embedded bytes", () => {
  const f = fixture("embedded-identity");
  f.select("  - name: aws-emulator\n");
  f.cli(0, "sync", "--packages");
  const folder = join(f.dir, ".office/packages");

  // A read-only *prior* package directory no longer prevents writing a generation.
  // Fail the actual copy into each candidate instead, for the same and a newer CLI.
  const block = (name: string) => {
    const file = join(folder, name, "unreadable");
    write(file, "uncopyable");
    chmodSync(file, 0);
  };

  block("aws-emulator");

  try {
    const failed = f.cli(1, "sync", "--packages");
    expect(failed).toContain("EACCES");
    // The set publishes without it; what it claims is unknown, so no package's tools are reconciled.
    expect(failed).toContain("not reconciling any package's tools or machine files: what package aws-emulator claims is unknown");
    expect(published(f.dir)).not.toContain("floci");
    expect(f.cli(1, "references", "list")).toContain("package aws-emulator: rejected by the last sync; run office sync");
    f.cli(0, "sync", "--references");
    expect(existsSync(join(f.dir, "references/floci"))).toBe(false);
    mkdirSync(join(folder, "aws-emulator"), { recursive: true });
    block("aws-emulator");
    block("references");
    expect(f.newer(1, "sync", "--packages")).toContain("EACCES");
    // The variant's references package also changed and could not be installed: no package
    // loads, and the command names why. The independent data reader still sees the correct generation.
    expect(f.newer(0, "--help")).toContain("package references: rejected by the last sync; run office sync");
    expect(f.newer(1, "references", "list")).toContain("package references: rejected by the last sync; run office sync");
    expect(f.newer(0, "instructions", f.dir)).not.toContain("references/floci/");
  } finally {
    for (const name of ["aws-emulator", "references"]) rmSync(join(folder, name, "unreadable"), { force: true });
  }

  f.cli(0, "sync", "--packages");
  expect(f.cli(0, "references", "list")).toContain("main\tpackage aws-emulator\n");
}, 60_000);

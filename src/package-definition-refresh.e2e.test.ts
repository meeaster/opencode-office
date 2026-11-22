import { expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.ts";
import { definitionFixture } from "./package-definition.fixture.ts";

const { root, bin, exe, variant, marker, write, read, commit, prompt, fixture, collector, pausedRefresh, published } = definitionFixture();

test("a compiled office collects independent references and scopes the last published generation to every reader", async () => {
  const { dir, home, probe, cli } = fixture("references");
  const yaml = join(dir, "office.yaml");
  const snapshot = join(dir, ".office/resolved/references.json");
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
desks: {work: {app: false}, sibling: {app: false, repos: [{name: other-desk, url: ${upstream}}]}}
packages: [${packages.join(", ")}]
`);

  const aws = "{name: aws-emulator}";
  const manual = "{name: manual}";
  const definition = (body: string) => write(local, `${marker} export default {name:"manual",description:"Manual",async setup({add}) {${body}}}`);
  const add = (name: string, url = wanted) => `add({registry:"references.repository",value:{name:"${name}",url:"${url}"}});`;
  const broken = () => definition(`${add("partial")} await Promise.resolve(); throw Error("collector interrupted");`);
  const list = () => published(dir);
  const head = (repo: string) => git(["rev-parse", "HEAD"], repo);

  const verifyPrompt = async (folder: string) => {
    const instructions = cli(0, "instructions", folder).trimEnd();
    expect(await prompt(dir, folder)).toBe(instructions);

    return instructions;
  };

  rmSync(realpathSync(snapshot));
  configure([manual, aws]);
  broken();
  // The command loads every selected package: one failed, one not synced yet.
  const unsynced = cli(1, "references", "list");
  expect(unsynced).toContain("package manual: ");
  expect(unsynced).toContain("collector interrupted");
  expect(unsynced).toContain("package aws-emulator: not synced yet; run office sync");
  expect(cli(1, "sync", "--packages")).toContain("collector interrupted");
  expect(list()).toContain(`${floci} @ main\tpackage aws-emulator`);
  expect(list()).not.toContain("partial");
  expect(existsSync(join(dir, "references/floci"))).toBe(false);

  definition(add("manual"));
  cli(0, "sync");
  const expected = list();
  expect(expected.split("\n").slice(0, 4).map(line => line.split("\t")[0])).toEqual(["z-owner", "a-owner", "floci", "manual"]);
  expect(read(snapshot)).not.toContain(dir);
  expect(head(checkout)).toBe(first);
  expect(head(join(dir, "references/floci"))).toBe(first);
  const generation = read(snapshot);
  configure([aws, manual]);
  cli(0, "sync", "--packages");
  expect(list()).toBe(expected);
  expect(read(snapshot)).toBe(generation);
  // Deliver just the generation and YAML at another root, without the collector modules.
  const moved = fixture("relocated");
  write(join(moved.dir, "office.yaml"), read(yaml));
  write(join(moved.dir, ".office/resolved/references.json"), generation);
  cpSync(upstream, join(moved.dir, "origin"), { recursive: true });
  write(join(moved.home, ".gitconfig"), `[url "${moved.dir}/origin"]\n\tinsteadOf = ${floci}\n`);
  moved.cli(0, "sync", "--references");
  expect(head(join(moved.dir, "references/manual"))).toBe(first);
  expect(existsSync(join(moved.dir, "packages/manual"))).toBe(false);

  configure([aws, manual], "floci");
  const workRepo = join(dir, "sibling/repos/other-desk");
  rmSync(workRepo, { recursive: true });
  write(yaml, read(yaml) + `plugins: [{name: fixture, repo: ${upstream}}]\n`);
  write(join(checkout, "document"), "keep through rejection");
  expect(cli(1, "sync")).toContain("floci claimed by both office.yaml and package aws-emulator");
  expect(head(workRepo)).toBe(first);
  expect(head(join(dir, ".opencode/plugins/fixture"))).toBe(first);
  expect(read(snapshot)).toBe(generation);
  expect(read(join(checkout, "document"))).toBe("keep through rejection");
  configure(["{name: aws-emulator, settings: {source_reference: false}}", manual], "floci");
  cli(0, "sync", "--packages");
  expect(list()).toContain("floci\t../../origin\toffice.yaml");
  configure([aws, manual]);

  write(join(upstream, "document"), "second");
  const second = commit(upstream);
  broken();
  expect(cli(1, "sync")).toContain("collector interrupted");
  expect(head(checkout)).toBe(second);
  expect(list()).toContain("manual\t../../origin\tpackage manual (stale)");
  expect(list()).not.toContain("partial");
  write(local, `${marker} throw Error("never import on read");`);
  // Help loads packages too, and names the one that failed.
  expect(cli(0, "--help")).toMatch(/references list[\s\S]*package manual: .*never import on read/);
  rmSync(probe);
  expect(cli(0, "sync", "--references")).toContain("last-good");
  const nested = join(dir, "work/repos/nested");
  mkdirSync(nested, { recursive: true });

  for (const folder of [dir, nested]) {
    const text = await verifyPrompt(folder);
    expect(text).toContain("references/floci/");
    expect(text).toContain("references/manual/");
    expect(text).toContain("(package manual, stale)");
    expect(text).toContain("package manual: reference collection failed");
    expect(text.includes("sibling/repos/other-desk/")).toBe(folder === dir);
  }

  expect(existsSync(probe)).toBe(false);
  renameSync(checkout, `${checkout}.saved`);
  expect(cli(1, "sync", "--references")).toContain("stale contribution cannot authorize a new clone");
  expect(existsSync(checkout)).toBe(false);
  renameSync(`${checkout}.saved`, checkout);
  git(["remote", "set-url", "origin", "../../foreign"], checkout);
  expect(cli(1, "sync", "--references")).toContain(`expected origin ${wanted}, found ../../foreign`);
  git(["remote", "set-url", "origin", wanted], checkout);

  definition(`add({registry:"references.repository",value:{name:"manual",url:"${wanted}",ref:"${first}"}});`);
  cli(0, "sync", "--packages");
  broken();
  cli(1, "sync", "--packages");
  expect(cli(1, "sync", "--references")).toContain(`desired ${wanted} @ ${first}, last applied ${wanted} @ HEAD`);
  expect(head(checkout)).toBe(second);

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

  broken();
  cli(1, "sync", "--packages");
  expect(cli(1, "sync", "--references")).toContain(`expected origin ${changed}, found ${wanted}`);
  expect(read(join(checkout, "document"))).toBe("preserved");
  definition("");
  configure([manual]);
  cli(0, "sync", "--packages");
  expect(list()).not.toContain("manual");
  expect(list()).not.toContain("floci");
  expect(await verifyPrompt(nested)).not.toContain("references/manual/");
  expect(read(join(checkout, "document"))).toBe("preserved");
  expect(head(join(dir, "references/floci"))).toBe(second);

  write(snapshot, read(snapshot).replace('"version": 4', '"version": 9'));
  expect(cli(1, "sync", "--references")).toContain("unsupported references snapshot version");
  expect(await verifyPrompt(nested)).toContain("unsupported references snapshot version");
  expect(cli(1, "sync", "--packages")).toContain("restore a readable generation");
  rmSync(realpathSync(snapshot));
  cli(0, "sync", "--packages");
}, 60_000);

test("a different pin of a Git contributor cannot inherit the old pin's claims", () => {
  const { dir, cli, select } = fixture("source-change");
  const repo = join(root, "source-change-repo");
  const module = join(repo, "pkg/office.ts");
  const setup = `add({registry:"references.repository",value:{name:"remote-docs",url:"../../local"}});`;

  const publish = (body: string) => {
    write(module, `export default {name:"docs",description:"Docs",setup({add}){${body}}}`);
    select(`  - {name: docs, repo: ${repo}, path: pkg, ref: ${commit(repo)}}\n`);
  };

  git(["init", "-q", repo]);
  publish(setup);
  cli(0, "sync", "--packages");
  expect(cli(0, "references", "list")).toContain("remote-docs");
  publish(`${setup} throw Error("bad new pin");`);
  expect(cli(1, "sync", "--packages")).toContain("bad new pin");
  // Readers of the saved file (here the office guidance) drop the old pin's rows.
  expect(cli(0, "instructions", dir)).toContain("package docs: reference collection failed");
  expect(cli(0, "instructions", dir)).not.toContain("remote-docs");
  // The installed copy is still the old pin's: the command doesn't load it under the new pin.
  expect(cli(1, "references", "list")).toContain("package docs: ");
  expect(existsSync(join(dir, "node_modules"))).toBe(false);
  publish('add({registry:"references.repository",value:{name:"../outside",url:"../../local"}});');
  expect(cli(1, "sync", "--packages")).toContain("value.name:");
  expect(published(dir)).not.toContain("../outside");
  expect(cli(0, "instructions", dir)).not.toContain("../outside");
}, 60_000);

test("only a current refresh may apply its fetched commit; withdrawal protects later edits", async () => {
  const f = fixture("refresh-races");
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

  const select = (ref?: string) => {
    write(yaml, initial.replace("references: []", ref ? `references: [{name: docs, url: ${repo}, ref: ${ref}}]` : "references: []"));
    f.cli(0, "sync", "--packages");
  };

  const dir = join(f.dir, "references/docs");
  const head = () => git(["rev-parse", "HEAD"], dir);
  const record = () => JSON.parse(git(["config", "--get", "office.appliedReference"], dir));
  select("main");
  f.cli(0, "sync", "--references");
  const older = await pausedRefresh(f);
  select("release");
  f.cli(0, "sync", "--references");
  expect(await older.resume(1)).toContain("superseded");
  expect(head()).toBe(release);
  expect(read(join(dir, "document"))).toBe("release");
  expect(record()).toEqual({ origin: repo, ref: "release", commit: release });
  git(["checkout", "--detach", main], dir);
  expect(f.cli(1, "check")).toContain(`expected applied commit ${release}, found HEAD ${main}`);
  select("main");
  expect(f.cli(1, "check")).toContain(`last applied ${repo} @ release`);
  f.cli(0, "sync", "--references");

  const previousMain = await pausedRefresh(f);
  write(join(repo, "document"), "advanced main");
  const advanced = commit(repo);
  f.cli(0, "sync", "--references");
  expect(await previousMain.resume(1)).toContain("superseded");
  expect(head()).toBe(advanced);
  expect(record().commit).toBe(advanced);

  const withdrawn = await pausedRefresh(f);
  select();
  write(join(dir, "document"), "mine after withdrawal");
  expect(await withdrawn.resume(1)).toContain("superseded");
  expect(read(join(dir, "document"))).toBe("mine after withdrawal");
  expect(head()).toBe(advanced);
  expect(record()).toEqual({ origin: repo, ref: "main", commit: advanced });
}, 60_000);

for (const signal of ["SIGTERM", "SIGKILL"] as const) {
  test(`publication waits for real Git's authority after parent-only ${signal}`, async () => {
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
      // The second process finishes an independent checkout while the first is in
      // a real smudge filter; admission isn't blocked on a global SQLite writer.
      write(join(other, "z"), "independent update");
      const independent = commit(other);
      expect(f.cli(1, "sync", "--references")).toContain("reference docs: checkout lease unavailable");
      expect(git(["rev-parse", "HEAD"], join(f.dir, "references/other"))).toBe(independent);

      parent.kill(signal);
      await parent.exited;
      expect(parent.signalCode).toBe(signal);
      expect(existsSync(exited)).toBe(false);

      if (process.platform === "linux") {
        const proc = `/proc/${read(pid).trim()}`;
        expect(readlinkSync(`${proc}/fd/3`)).toBe(join(f.dir, ".office/resolved/checkout-leases/docs.lock"));
        expect(read(`${proc}/fdinfo/3`)).toMatch(/^lock:\s+\d+: FLOCK\s+ADVISORY\s+WRITE\b/m);
      }

      write(yaml, original);
      expect(f.cli(1, "sync", "--packages")).toContain("retry after the active Git checkout finishes");
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
    f.cli(0, "sync", "--packages");
    write(join(docs, "z"), "mine after successful withdrawal");
    f.cli(0, "sync", "--references");
    expect(read(join(docs, "z"))).toBe("mine after successful withdrawal");
    write(yaml, selected);
    f.cli(0, "sync");
    expect(JSON.parse(git(["config", "office.appliedReference"], docs)).commit).toBe(expected);
  }, 60_000);
}

test("overlapping fresh clones publish only their own staging directories", async () => {
  const f = fixture("clone-overlap");
  const repo = join(root, "queued-upstream");
  git(["init", "-qb", "main", repo]);
  write(join(repo, "document"), "upstream");
  const sha = commit(repo);

  const select = (names: string[]) => {
    write(join(f.dir, "office.yaml"), JSON.stringify({ name: "overlap", references: names.map(name => ({ name, url: repo })) }));
    f.cli(0, "sync", "--packages");
  };

  select(["a", "b", "c", "d", "queued"]);
  const old = await pausedRefresh(f, 4);
  select(["queued"]);
  const queued = join(f.dir, "references/queued");
  f.cli(0, "sync", "--references");
  write(join(queued, "document"), "winner");
  expect(await old.resume(1)).toContain("superseded");
  expect(git(["rev-parse", "HEAD"], queued)).toBe(sha);
  expect(read(join(queued, "document"))).toBe("winner");
  expect(readdirSync(join(f.dir, "references"))).toEqual(["queued"]);

  select(["fresh"]);
  const fresh = join(f.dir, "references/fresh");
  const loser = await pausedRefresh(f);
  expect(existsSync(fresh)).toBe(false);
  f.cli(0, "sync", "--references");
  write(join(fresh, "document"), "keep the winner's checkout");
  await loser.resume(1);
  expect(git(["rev-parse", "HEAD"], fresh)).toBe(sha);
  expect(read(join(fresh, "document"))).toBe("keep the winner's checkout");

  select(["interrupted"]);
  const interrupted = await pausedRefresh(f);
  interrupted.interrupt();
  await interrupted.resume(130);
  expect(existsSync(join(f.dir, "references/interrupted"))).toBe(false);
  f.cli(0, "sync", "--references");
  expect(read(join(f.dir, "references/interrupted/document"))).toBe("upstream");
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
    expect(f.cli(1, "sync", "--packages")).toContain("EACCES");
    expect(published(f.dir)).toContain("main\tpackage aws-emulator (stale)");
    expect(f.cli(1, "references", "list")).toContain("package aws-emulator: rejected by the last sync; run office sync");
    expect(f.cli(1, "sync", "--references")).toContain("stale contribution cannot authorize a new clone");
    expect(existsSync(join(f.dir, "references/floci"))).toBe(false);
    mkdirSync(join(folder, "aws-emulator"), { recursive: true });
    block("aws-emulator");
    block("references");
    expect(f.newer(1, "sync", "--packages")).toContain("EACCES");
    // The variant's references package also changed and could not be installed: it doesn't
    // load, so its command is unknown. The independent data reader still sees the correct generation.
    expect(f.newer(0, "--help")).toContain("package references: rejected by the last sync; run office sync");
    expect(f.newer(2, "references", "list")).toContain("package references: rejected by the last sync; run office sync");
    expect(f.newer(0, "instructions", f.dir)).not.toContain("references/floci/");
  } finally {
    for (const name of ["aws-emulator", "references"]) rmSync(join(folder, name, "unreadable"), { force: true });
  }

  f.cli(0, "sync", "--packages");
  expect(f.cli(0, "references", "list")).toContain("main\tpackage aws-emulator\n");
}, 60_000);

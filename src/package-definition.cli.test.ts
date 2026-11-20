import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compile } from "./build.ts";
import { git } from "./git.ts";
import { sources } from "./github.ts";
import { loadOffice } from "./office.ts";
import { preparePackageServices } from "./package-services.ts";
import type officePlugin from "../packages/office/plugin/index.ts";

const root = mkdtempSync(join(tmpdir(), "office-definition-"));
const fixtureMarker = join(root, ".compiled-office-test");

writeFileSync(fixtureMarker, import.meta.url);

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

  for (const path of ["src", "standard", "packages", "template", "image", "compose.yaml", "LICENSE", "package.json"]) cpSync(join(checkout, path), join(dist, path), { recursive: true });
  write(join(dist, "packages/arrival/office.ts"), `${marker} export default { name: "arrival", description: "Newly shipped" }`);
  const aws = join(dist, "packages/aws-emulator/office.ts");
  write(aws, read(aws).replace("if (settings.source_reference === false) return;", 'throw Error("changed built-in collector");'));
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

afterAll(() => {
  if (read(fixtureMarker) !== import.meta.url) throw new Error(`refusing cleanup of unmarked fixture ${root}`);
  rmSync(root, { recursive: true, force: true });
});

// Exercise the installed bundle through the same prompt hook that writes the session entry.
async function prompt(dir: string, folder: string) {
  const plugin: typeof officePlugin = (await import(join(dir, ".opencode/plugins/office/index.js"))).default;
  const hooks: ((event: { sessionID: string }) => Promise<void>)[] = [];
  const registration = { dispose: async () => {} };
  let text = "";

  const close = await plugin.setup({
    location: { directory: folder },
    session: {
      async hook(_, handler) {
        hooks.push(handler);

        return registration;
      },
      instructions: { entry: { async put(entry) {
        expect(entry.key).toBe("office");
        text = entry.value;
      } } },
    },
    skill: { transform: async () => registration, list: async () => ({ data: [] }), reload: async () => {} },
    mcp: { transform: async () => registration },
  });

  try {
    for (const hook of hooks) await hook({ sessionID: "fixture" });

    return text;
  } finally {
    close?.();
  }
}

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

  return { dir, home, env, probe, cli, newer, select: (entries: string) => write(config, initial + entries) };
}

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
  const list = () => cli(0, "references", "list");
  const head = (repo: string) => git(["rev-parse", "HEAD"], repo);

  const verifyPrompt = async (folder: string) => {
    const instructions = cli(0, "instructions", folder).trimEnd();
    expect(await prompt(dir, folder)).toBe(instructions);

    return instructions;
  };

  rmSync(snapshot);
  configure([manual, aws]);
  broken();
  expect(list()).toContain("z-owner\t../../origin\toffice.yaml");
  expect(list()).not.toContain("floci");
  expect(existsSync(probe)).toBe(false);
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
  expect(moved.cli(0, "references", "list")).toBe(expected);
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
  expect(list()).toContain("reference inputs changed");
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
  rmSync(probe);
  write(local, `${marker} throw Error("never import on read");`);
  expect(cli(0, "--help")).toContain("references list");
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

  write(snapshot, read(snapshot).replace('"version": 2', '"version": 9'));
  expect(cli(1, "references", "list")).toContain("unsupported references snapshot version");
  expect(cli(1, "sync", "--references")).toContain("unsupported references snapshot version");
  expect(await verifyPrompt(nested)).toContain("unsupported references snapshot version");
  expect(cli(1, "sync", "--packages")).toContain("restore a readable generation");
  rmSync(snapshot);
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
  const list = cli(0, "references", "list");
  expect(list).toContain("package docs: reference collection failed");
  expect(list).not.toContain("remote-docs");
  expect(existsSync(join(dir, "node_modules"))).toBe(false);
  publish('add({registry:"references.repository",value:{name:"../outside",url:"../../local"}});');
  expect(cli(1, "sync", "--packages")).toContain("value.name:");
  expect(cli(0, "references", "list")).not.toContain("../outside");
}, 60_000);

function collector(url: string, ref = "main", after = "") {
  const value = JSON.stringify({ name: "docs", url, ref });

  return `export default {name:"docs",description:"Docs",async setup({add}) {add({registry:"references.repository",value:${value}});${after}}}`;
}

/** Pause this invocation after real Git finished each network fetch, before Office can apply. */
async function pausedRefresh(f: ReturnType<typeof fixture>, count = 1) {
  const gate = mkdtempSync(join(root, "fetch-gate-"));
  write(join(f.home, "bin/git"), `#!/bin/sh
set -eu
if [ "$1" != fetch ] || [ -z "\${FETCH_GATE:-}" ]; then exec "${bin}/git" "$@"; fi
"${bin}/git" "$@"
: > "$FETCH_GATE/\${PWD##*/}"
while [ ! -f "$FETCH_GATE/go" ]; do /bin/sleep 0.02; done
`, 0o755);

  const process = Bun.spawn([exe, "--office", f.dir, "sync", "--references"], {
    cwd: f.dir, env: { ...f.env, FETCH_GATE: gate }, stdout: "pipe", stderr: "pipe",
  });

  const output = Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text()]);

  for (let i = 0; i < 500 && readdirSync(gate).length < count && process.exitCode === null; i++) await Bun.sleep(20);

  if (readdirSync(gate).length !== count) {
    write(join(gate, "go"), "");
    process.kill();
    throw new Error(`fetch barrier not reached: ${(await output).join("")}`);
  }

  return {
    async resume(expected: number) {
      write(join(gate, "go"), "");
      const status = await process.exited;
      const text = (await output).join("");
      expect(status, text).toBe(expected);

      return text;
    },
    interrupt() { process.kill("SIGINT"); },
  };
}

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
      expect(f.cli(0, "references", "list")).toContain("docs\t");
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
  rmSync(join(folder, "aws-emulator"), { recursive: true });
  chmodSync(folder, 0o555);

  try {
    expect(f.cli(1, "sync", "--packages")).toContain("EACCES");
    expect(f.cli(0, "references", "list")).toContain("main\tpackage aws-emulator (stale)");
    expect(f.cli(1, "sync", "--references")).toContain("stale contribution cannot authorize a new clone");
    expect(existsSync(join(f.dir, "references/floci"))).toBe(false);
    expect(f.newer(1, "sync", "--packages")).toContain("EACCES");
    expect(f.newer(0, "references", "list")).not.toContain("floci\t");
  } finally {
    chmodSync(folder, 0o755);
  }

  f.cli(0, "sync", "--packages");
  expect(f.cli(0, "references", "list")).toContain("main\tpackage aws-emulator\n");
}, 60_000);

test("stale refresh needs the actual and last-applied origin/ref; cron runs only its named owner", async () => {
  const f = fixture("cron-refs");
  const { dir, home, cli, probe, select } = f;
  const a = join(root, "repo-a");
  const b = join(root, "repo-b");

  for (const repo of [a, b]) {
    git(["init", "-qb", "main", repo]);
    write(join(repo, "document"), repo);
    commit(repo);
  }

  const module = join(dir, "packages/docs/office.ts");
  const checkout = join(dir, "references/docs");
  const job = "package.office.update-references";
  const stamp = join(home, `.local/state/office/cron/cron-refs/${job}.stamp`);
  const observed = () => [git(["rev-parse", "HEAD"], checkout), read(join(checkout, "document")), read(join(checkout, ".git/FETCH_HEAD"))];
  select("  - name: docs\n");
  write(module, collector(a));
  cli(0, "sync");
  cli(0, "check");
  write(join(checkout, "document"), "dirty A");
  const before = observed();

  write(module, collector(b));
  cli(0, "sync", "--packages");
  write(module, `${marker} throw Error("broken definition");`);
  cli(1, "sync", "--packages");
  rmSync(probe);
  git(["remote", "set-url", "origin", b], checkout);
  expect(cli(1, "sync", "--references")).toContain(`desired ${b} @ main, last applied ${a} @ main`);
  expect(observed()).toEqual(before);
  expect(cli(1, "cron", "run", job)).toContain("exited 1");
  expect(observed()).toEqual(before);
  expect(existsSync(stamp)).toBe(false);
  expect(existsSync(probe)).toBe(false);

  git(["remote", "set-url", "origin", a], checkout);
  git(["switch", "-qc", "release"], a);
  write(join(a, "document"), "pending release");
  commit(a);
  git(["switch", "-q", "main"], a);
  write(module, collector(a, "release"));
  cli(0, "sync", "--packages");
  expect(cli(1, "check", "--verbose")).toContain(`desired ${a} @ release, last applied ${a} @ main`);
  expect(observed()).toEqual(before);

  // A legacy ref alone cannot grant stale authority. A healthy refresh establishes the pair.
  write(module, collector(a));
  cli(0, "sync", "--packages");
  git(["config", "--unset", "office.appliedReference"], checkout);
  git(["config", "office.referenceRef", "main"], checkout);
  write(module, collector(a, "main", 'throw Error("failed");'));
  cli(1, "sync", "--packages");
  expect(cli(1, "sync", "--references")).toContain("no unambiguous applied origin and ref");
  expect(observed()).toEqual(before);
  write(module, collector(a));
  cli(0, "sync");
  write(module, `${marker} throw Error("must not import from cron");`);
  cli(1, "sync", "--packages");
  rmSync(probe);
  write(join(a, "document"), "advanced A");
  const advanced = commit(a);
  expect(cli(0, "cron", "run", job)).toContain("exited 0");
  expect(git(["rev-parse", "HEAD"], checkout)).toBe(advanced);
  expect(read(join(checkout, "document"))).toBe("advanced A");
  const success = read(stamp);
  write(join(a, "document"), "fetched but no longer authorized");
  commit(a);
  write(join(checkout, "document"), "keep through stale apply refusal");
  const lastGood = observed();
  const paused = await pausedRefresh(f);
  git(["config", "--unset", "office.appliedReference"], checkout);
  expect(await paused.resume(1)).toContain("no unambiguous applied");
  expect(observed()).toEqual(lastGood);
  select("  - name: docs\n  - name: office\n    cron: {update-references: {enabled: false}}\n");
  expect(cli(1, "cron", "run", job)).toContain("not enabled");
  expect(read(stamp)).toBe(success);
  expect(existsSync(probe)).toBe(false);
}, 60_000);

test("a built-in's bytes and a Git contributor's resolved commit survive separate executable processes", () => {
  const { dir, env, cli, newer, probe, select } = fixture("reference-repair");
  select("  - name: aws-emulator\n");
  cli(0, "sync", "--packages");

  // Exercise setup's real planner with Git restricted to file transport. The only HTTPS
  // source is contributed, so it must be reported as requiring access, never push access.
  const planning = Bun.spawnSync([process.execPath, "--no-install", "-e", `
    import {planGithub} from ${JSON.stringify(join(import.meta.dir, "github.ts"))};
    import {loadOffice} from ${JSON.stringify(join(import.meta.dir, "office.ts"))};
    console.log(JSON.stringify(await planGithub(loadOffice(process.cwd()))));
  `], { cwd: dir, env });

  expect(planning.exitCode, planning.stderr.toString()).toBe(0);
  expect(JSON.parse(planning.stdout.toString())).toEqual({
    hosts: ["github.com"], private: [{ what: "reference floci", url: "https://github.com/floci-io/floci.git", pushes: false }], pushes: [], needed: true,
  });
  expect(newer(1, "sync", "--packages")).toMatch(/built-in:[a-f0-9]{64}.*changed built-in collector/);
  expect(newer(0, "references", "list")).not.toContain("floci\t");
  const repo = join(root, "tags");
  const installed = join(dir, ".office/packages/docs");
  git(["init", "-qb", "main", repo]);
  write(join(repo, "pkg/office.ts"), collector("approved:A"));
  const first = commit(repo);
  git(["tag", "v1"], repo);
  const pin = (ref: string) => select(`  - {name: docs, repo: ${repo}, path: pkg, ref: ${ref}}\n`);
  pin("v1");
  cli(0, "sync", "--packages");
  write(join(repo, "pkg/office.ts"), `${marker} ${collector("unapproved:B")}`);
  git(["tag", "-f", "v1", commit(repo)], repo);
  rmSync(installed, { recursive: true });
  cli(0, "sync", "--packages");
  expect(JSON.parse(read(join(installed, ".source.json")))).toMatchObject({ commit: first, ref: "v1" });
  expect(cli(0, "references", "list")).toContain("approved:A");
  expect(existsSync(probe)).toBe(false);
  pin(first);
  cli(0, "sync", "--packages");
  rmSync(installed, { recursive: true });
  renameSync(repo, repo + "-offline");
  expect(cli(1, "sync", "--packages")).toContain(`${repo}:pkg @ ${first} (revision ${first})`);
  expect(cli(0, "references", "list")).toContain("approved:A @ main\tpackage docs (stale)");
  expect(existsSync(installed)).toBe(false);
}, 60_000);

test("an overlapping or interrupted collector cannot republish an explicitly withdrawn reference", async () => {
  const { dir, cli, env, select } = fixture("overlap");
  const repo = join(root, "overlap-origin");
  git(["init", "-qb", "main", repo]);
  write(join(repo, "document"), "original");
  commit(repo);
  const checkout = join(dir, "references/docs/document");
  const module = join(dir, "packages/docs/office.ts");
  select("  - name: docs\n");
  write(module, collector(repo));
  cli(0, "sync");
  write(checkout, "keep after withdrawal");
  write(module, collector(repo, "main", 'console.log("collection-paused"); await Bun.stdin.text();'));

  const pause = async () => {
    const child = Bun.spawn([exe, "--office", dir, "sync", "--packages"], { env, cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    let output = "";

    while (!output.includes("collection-paused")) {
      const chunk = await reader.read();

      if (chunk.done) throw new Error(`collector exited before barrier: ${output}`);
      output += Buffer.from(chunk.value).toString();
    }

    reader.releaseLock();

    return child;
  };

  const killed = await pause();
  killed.kill("SIGKILL");
  await killed.exited;
  const old = await pause();

  try {
    select("");
    cli(0, "sync", "--packages");
    old.stdin.end();
    expect(await old.exited).toBe(1);
    expect(cli(0, "references", "list")).not.toContain("docs\t");
    cli(0, "sync", "--references");
    expect(read(checkout)).toBe("keep after withdrawal");
  } finally {
    old.kill();
  }

  // Even identical YAML can produce a newer explicit empty result after editing office.ts.
  select("  - name: docs\n");
  const empty = 'export default {name:"docs",description:"withdrawn",setup(){}}';
  const paused = read(module);
  write(module, empty);
  cli(0, "sync", "--packages");
  const unchanged = read(join(dir, ".office/resolved/references.json"));
  write(module, paused);
  const superseded = await pause();

  try {
    write(module, empty);
    cli(0, "sync", "--packages");
    expect(read(join(dir, ".office/resolved/references.json"))).toBe(unchanged);
    superseded.stdin.end();
    expect(await superseded.exited).toBe(1);
    expect(cli(0, "references", "list")).not.toContain("docs\t");
    cli(0, "sync", "--references");
    expect(read(checkout)).toBe("keep after withdrawal");
  } finally {
    superseded.kill();
  }
}, 60_000);

test.skipIf(process.getuid?.() === 0)("inaccessible generation fails closed; genuine absence reads legacy YAML", () => {
  const { dir, cli } = fixture("read-errors");
  const folder = join(dir, ".office/resolved");
  const repo = join(root, "legacy-origin");
  git(["init", "-qb", "main", repo]);
  write(join(repo, "document"), "legacy");
  commit(repo);
  write(join(dir, "office.yaml"), `name: legacy\nreferences: [{name: legacy, url: ${repo}}]\n`);
  chmodSync(folder, 0);

  try {
    expect(cli(1, "references", "list")).toContain("EACCES");
    expect(cli(1, "sync", "--references")).toContain("EACCES");
    expect(existsSync(join(dir, "references/legacy"))).toBe(false);
    expect(() => sources(loadOffice(dir))).toThrow("EACCES");
  } finally {
    chmodSync(folder, 0o700);
  }

  write(join(folder, "references.json"), "{");
  expect(cli(1, "references", "list")).toContain(".office/resolved/references.json");
  cli(1, "sync", "--references");
  expect(existsSync(join(dir, "references/legacy"))).toBe(false);
  rmSync(join(folder, "references.json"));
  expect(cli(0, "references", "list")).toContain("listing office.yaml only");
  cli(0, "sync", "--references");
  expect(read(join(dir, "references/legacy/document"))).toBe("legacy");
}, 60_000);

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
  write(join(pkg, "office.ts"), 'export default { name: "notes", description: "Notes", setup: "handler.ts" }');
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

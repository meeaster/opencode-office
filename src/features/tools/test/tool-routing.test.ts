import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { activeRecord } from "../../../../packages/tools/applied.ts";
import { activate, projectionPath, toolsState } from "../applied.ts";
import { firewalledMise, reconcileTools } from "../host.ts";
import { officeMise } from "../registry.ts";
import { bump } from "../../../commands/bump.ts";
import { isolatedEnvironment } from "../selection.ts";
import { git } from "../../../git.ts";
import { hostEnvironment, hostLayout, miseShims } from "../../host/host-env.ts";
import { hostToolsRoot, officeTool } from "../../host/host-tools.ts";
import { globalConfD, grantConsent, linkName, machineRecordPath, readMachine } from "../../host/machine.ts";
import { loadOffice } from "../../../office.ts";
import { toolPath } from "../../../tool.ts";
import { gatherPackages } from "../../../gather.ts";
import { syncLines as sync } from "../../../../test/support/sync.fixture.ts";
import { applyOfficeTools, definitionText, isOfficeTool, officePlan, officeRegistry, sharedToolsLock, writePackage } from "../../../../test/support/test-package.ts";
import { defaultPins, lockSections, readLockText } from "../../../versions.ts";

let dir: string;

let office: string;

let fake: string;

const saved = { PATH: process.env.PATH, FAKE_MISE: process.env.FAKE_MISE, OFFICE_MACHINE_DIR: process.env.OFFICE_MACHINE_DIR };
const checksum = (digit: string) => `sha256:${digit.repeat(64)}`;

// The mise the office finds first on PATH, reporting the version the office pins: it logs each
// call with its folder, answers a dry run with `plan`, and fails anything
// else. Socket Firewall, where office up would have installed it, runs the command it is given.
const fakeMise = `#!/bin/sh
echo "$* | $PWD" >> "$FAKE_MISE/calls"
case "$1" in
  --version) echo "\${FAKE_MISE_VERSION:-${defaultPins.mise.version}}" ;;
  registry) echo '${JSON.stringify([{ short: "bun", backends: ["core:bun"] }, { short: "jq", backends: ["aqua:jqlang/jq"] }, ...officeRegistry])}' ;;
  upgrade) [ ! -f "$FAKE_MISE/warn" ] || cat "$FAKE_MISE/warn" >&2; cat "$FAKE_MISE/plan" ;;
  ls-remote) cat "$FAKE_MISE/releases" ;;
  outdated) cat "$FAKE_MISE/outdated" ;;
  latest) echo "$2" | sed 's/.*@//' ;;
  install) ;;
  *) exit 1 ;;
esac
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-tool-routing-"));
  office = join(dir, "office");
  fake = join(dir, "fake");
  mkdirSync(fake, { recursive: true });
  writeFileSync(join(fake, "mise"), fakeMise, { mode: 0o755 });
  writeFileSync(join(fake, "calls"), "");
  process.env.PATH = `${fake}:${saved.PATH}`;
  process.env.FAKE_MISE = fake;
  process.env.OFFICE_MACHINE_DIR = join(dir, "machine");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Socket Firewall where office up installs it, listed in the machine record as office up lists it. */
function installSfw(): void {
  const path = hostLayout("").sfw;
  const text = '#!/bin/sh\nexec "$@"\n';
  const record = readMachine();

  if (record === undefined) throw new Error("installSfw lists sfw in the machine record, which needs the office's consent first");
  write(path, text);
  chmodSync(path, 0o755);
  writeFileSync(machineRecordPath(), JSON.stringify({ ...record, files: [...record.files.filter(file => file.path !== path), { kind: "file", path, package: null, sha256: createHash("sha256").update(text).digest("hex") }] }));
}

/** What the fake mise's dry run plans: each tool at its version, beside the office package's tools. */
function answers(plan: Record<string, string>): void {
  writeFileSync(join(fake, "plan"), `${officePlan}${Object.entries(plan).map(([tool, version]) => `Would install ${tool}@${version}\n`).join("")}`);
}

/** The mise calls that select, lock or install, without the version lookups. */
function work(): string[] {
  return readFileSync(join(fake, "calls"), "utf8").split("\n").filter(line => /^(upgrade|lock|ls-remote|install|outdated) /.test(line));
}

function requires(name: string, tool: string, minimum: string, bin: string): void {
  writePackage(join(office, `packages/${name}/office.ts`), definitionText(`{setup(ctx){tools.require(ctx,{name:${JSON.stringify(tool)},minimum:${JSON.stringify(minimum)},bin:${JSON.stringify(bin)}})}}`, 'import { tools } from "@office/tools";'), { dependencies: ["tools"] });
}

function select(...entries: string[]): void {
  write(join(office, "office.yaml"), `name: t\nstate: ${join(dir, "state")}\nopencode: {mode: host, url: 'http://127.0.0.1:49999'}\nminimum_release_age: 3d\npackages: [${entries.map(entry => `{name: ${entry}}`).join(", ")}]\n`);
}

const run = async () => (await sync(loadOffice(office), { scope: "packages" })).join("\n");

async function published(): Promise<void> {
  mkdirSync(join(office, "packages"), { recursive: true });
  select();
  write(join(office, "office.lock"), sharedToolsLock());
  applyOfficeTools(loadOffice(office).state);
  grantConsent(loadOffice(office));
  await run();
}

function locked() {
  const read = lockSections(readLockText(office)).tools;

  if (!read.ok) throw read.error;

  // The office package's tools stay as the fixture recorded them.
  return Object.fromEntries([...read.value].flatMap(([tool, entry]) => isOfficeTool(tool) ? [] : [[tool, entry.version]]));
}

const current = () => readlinkSync(join(office, ".office/current"));

test("sync records a release for a new or raised requirement before it publishes, installs nothing, and asks mise nothing when every tool is served", async () => {
  await published();
  installSfw();
  // Only the office package's tools are applied, as the fixture applied them.
  const applied = readFileSync(activeRecord(toolsState(loadOffice(office))), "utf8");
  requires("alpha", "core:bun", "1.4.4", "bun");
  requires("beta", "aqua:sharkdp/bat", "0.26.0", "bat");
  select("alpha", "beta");
  answers({ "core:bun": "1.4.4", "aqua:sharkdp/bat": "0.26.1" });

  expect(await run()).not.toContain("FAILED");
  expect(locked()).toEqual({ "aqua:sharkdp/bat": "0.26.1", "core:bun": "1.4.4" });
  expect(work().map(line => line.split(" | ")[0])).toEqual(["upgrade --bump --dry-run"]);
  expect(work().every(line => !line.includes(`| ${office}`))).toBe(true);
  expect(readFileSync(activeRecord(toolsState(loadOffice(office))), "utf8")).toBe(applied);

  // Unchanged: mise is asked for no release, lock or install; only its offline registry names the office package's tools.
  writeFileSync(join(fake, "calls"), "");
  expect(await run()).not.toContain("FAILED");
  expect(readFileSync(join(fake, "calls"), "utf8").split("\n").filter(line => line !== "" && !/^(--version|registry --json) \|/.test(line))).toEqual([]);

  // A new minimum above the recorded bun: only bun is selected, and bat's entry stays as it was.
  requires("gamma", "core:bun", "1.4.5", "bun");
  select("alpha", "beta", "gamma");
  answers({ "core:bun": "1.4.5" });
  writeFileSync(join(fake, "calls"), "");

  expect(await run()).toContain("office.lock: selected tool core:bun 1.4.5 (was 1.4.4) for package alpha and package gamma");
  expect(locked()).toEqual({ "aqua:sharkdp/bat": "0.26.1", "core:bun": "1.4.5" });
  expect(readFileSync(join(fake, "calls"), "utf8")).toContain('upgrade --bump --dry-run');
  expect(readFileSync(activeRecord(toolsState(loadOffice(office))), "utf8")).toBe(applied);

  // No eligible release meets a newer minimum: nothing is published and office.lock is as it was.
  const before = { current: current(), lock: readLockText(office) };

  requires("delta", "core:bun", "1.4.9", "bun");
  select("alpha", "beta", "gamma", "delta");
  answers({ "core:bun": "1.4.6" });
  const refused = await run();

  expect(refused).toContain("FAILED mise selected tool core:bun 1.4.6, below the 1.4.9 package alpha and package delta and package gamma need; office.lock is left as it was");
  expect({ current: current(), lock: readLockText(office) }).toEqual(before);
});

test("while Socket Firewall can't run, sync leaves a new tool unselected and refuses to publish against a recorded release that no longer serves; bump and upgrade-tools ask mise nothing", async () => {
  await published();
  requires("alpha", "core:bun", "1.4.4", "bun");
  select("alpha");
  const notInstalled = `Socket Firewall at ${hostLayout("").sfw} isn't the copy office installed (missing, changed or not in the machine record), and office selects and installs shared tools only behind it; run office up, which installs it`;

  // Missing.
  expect(await run()).toContain(`not selecting releases of tool core:bun yet: ${notInstalled}`);
  // A program at sfw's place that isn't the copy the machine record lists is not Socket Firewall: it never runs.
  write(hostLayout("").sfw, '#!/bin/sh\n# not the recorded copy\nexec "$@"\n');
  chmodSync(hostLayout("").sfw, 0o755);
  expect(await run()).toContain(`not selecting releases of tool core:bun yet: ${notInstalled}`);
  // The recorded copy, changed since office installed it.
  installSfw();
  writeFileSync(hostLayout("").sfw, '#!/bin/sh\n# changed\nexec "$@"\n');
  expect(await run()).toContain(`not selecting releases of tool core:bun yet: ${notInstalled}`);
  await expect(bump(loadOffice(office))).rejects.toThrow(`office bump asked mise nothing: ${notInstalled}`);
  expect(readFileSync(join(fake, "calls"), "utf8")).not.toContain("upgrade");

  // Turned off in office.yaml: the owner's setting stands, and nothing runs mise bare in its place.
  installSfw();
  write(join(office, "office.yaml"), readFileSync(join(office, "office.yaml"), "utf8").replace("minimum_release_age: 3d\n", `minimum_release_age: 3d\ntools:\n  sfw: { version: ${defaultPins.sfw.version}, enabled: false }\n`));
  const off = "Socket Firewall is off for this office (sfw enabled: false in office.yaml), and office selects and installs shared tools only behind it; turn it on, then run office up";

  expect(await run()).toContain(`not selecting releases of tool core:bun yet: ${off}`);
  await expect(bump(loadOffice(office))).rejects.toThrow(`office bump asked mise nothing: ${off}`);
  const job = Bun.spawnSync([process.execPath, toolPath("src/cli.ts"), "upgrade-tools"], { cwd: office, env: { ...process.env, XDG_DATA_HOME: dir } });

  expect(job.exitCode).not.toBe(0);
  expect(`${job.stdout}${job.stderr}`).toContain(`the packages' shared tools aren't bumped: ${off}`);
  const gathered = await gatherPackages(loadOffice(office), { machine: true });
  const up = await reconcileTools(loadOffice(office), gathered, { upgrade: false });

  expect(up).toEqual({ ok: false, lines: [`FAILED ${off}; no shared tool was selected, installed or switched`] });
  expect(work()).toEqual([]);
  select("alpha");

  installSfw();
  answers({ "core:bun": "1.4.4" });
  await run();
  rmSync(hostLayout("").sfw);
  const before = { current: current(), lock: readLockText(office) };

  requires("beta", "core:bun", "1.4.5", "bun");
  select("alpha", "beta");

  expect(await run()).toContain(`FAILED office.lock records tool core:bun 1.4.4, which no longer serves its packages, and no other is selected: ${notInstalled}, then office sync`);
  expect({ current: current(), lock: readLockText(office) }).toEqual(before);
});

test("the CLI's lookups, the environment file and native tasks take the applied shared tools; machine.toml's holds of them never reach mise's global config", async () => {
  await published();
  installSfw();
  requires("alpha", "core:bun", "1.4.4", "bun");
  writePackage(join(office, "packages/beta/office.ts"), definitionText('{setup(ctx){ctx.add(tasks,{name:"audit",description:"Run audit",script:"audit.sh"})}}', 'import { tasks } from "@office/mise-integration/claims";'), { dependencies: ["mise-integration"] });
  write(join(office, "packages/beta/audit.sh"), "true\n");
  select("alpha", "beta");
  const owner = '[settings]\nexperimental = true\n\n[tools]\nbun = "1.4.4" # the owner\'s hold\nzig = "0.15.2"\n';

  write(join(office, "machine.toml"), owner);
  answers({});
  writeFileSync(join(fake, "releases"), "1.4.4\n");
  expect(await run()).not.toContain("FAILED");
  const config = loadOffice(office);
  const projection = projectionPath(config);

  // machine.toml stays the owner's; mise loads it without the hold.
  const loaded = join(globalConfD(), linkName(config, join(office, "machine.toml")));

  expect(readFileSync(join(office, "machine.toml"), "utf8")).toBe(owner);
  expect(lstatSync(loaded).isSymbolicLink()).toBe(false);
  expect(readFileSync(loaded, "utf8")).toBe(`# office: machine.toml as mise loads it, without the shared tools the office's packages require (bun), which office installs from office.lock. Written by office sync from machine.toml; edit that file instead.\n${owner.replace('bun = "1.4.4" # the owner\'s hold\n', "")}`);
  expect(readdirSync(globalConfD()).some(name => readFileSync(join(globalConfD(), name), "utf8").includes('bun = "'))).toBe(false);

  // The environment file and the package's task put the applied tools before mise's shims.
  const { environment } = hostEnvironment(config, (await gatherPackages(config)).packages);

  expect(environment.path.indexOf(projection)).toBeLessThan(environment.path.findIndex(entry => entry.endsWith("/shims")));
  expect(readFileSync(join(office, ".office/mise/beta.toml"), "utf8")).toContain(`run = "PATH='${projection}':\\"$PATH\\" bash \\"$OFFICE_ROOT/packages/beta/audit.sh\\""`);

  // An applied shared tool exposing an office command is what the CLI runs.
  const sops = join(dir, "state/tools/mise/installs/sops/3.12.0/sops");
  const measured = `sha256:${createHash("sha256").update("#!/bin/sh\n").digest("hex")}`;

  write(sops, "#!/bin/sh\n");
  activate(config, { tools: new Map([["aqua:getsops/sops", { version: "3.12.0", identity: checksum("1"), names: ["sops"], bin: { sops: { path: sops, sha256: measured } } }]]), highest: new Map([["aqua:getsops/sops", "3.12.0"]]) });
  expect(officeTool(config, "sops")).toMatchObject({ path: sops, version: "3.12.0", managed: true });
  expect(officeTool({ ...config, opencode: { ...config.opencode, mode: "container" } }, "sops")?.path).not.toBe(sops);

  // A changed or missing applied executable is named as drift; no other sops on PATH or in mise stands in.
  const other = join(fake, "sops");

  write(other, '#!/bin/sh\necho 3.12.0\n');
  chmodSync(other, 0o755);
  write(sops, "#!/bin/sh\necho changed\n");
  const changed = `sha256:${createHash("sha256").update("#!/bin/sh\necho changed\n").digest("hex")}`;

  expect(() => officeTool(config, "sops")).toThrow(`tool aqua:getsops/sops 3.12.0: its applied executable sops at ${sops} is ${changed}, not the ${measured} office activated; office neither runs a changed tool nor substitutes another copy`);
  rmSync(sops);
  expect(() => officeTool(config, "sops")).toThrow(`tool aqua:getsops/sops 3.12.0: its applied executable sops at ${sops} is missing`);
});

test("the shared tools run only the mise the office pins, by its real path; another version is refused, never installed over or repinned", async () => {
  await published();
  installSfw();
  const config = loadOffice(office);
  const yaml = readFileSync(join(office, "office.yaml"), "utf8");

  // PATH's mise reports another version and there is no private copy: registry, planning and staging all refuse.
  process.env.FAKE_MISE_VERSION = "2026.11.99";

  try {
    expect(() => officeMise(config)).toThrow(`the shared tools run only mise ${defaultPins.mise.version}, the version this office pins (office.yaml tools.mise), but ${join(fake, "mise")} reports 2026.11.99; office doesn't install, replace or repin your mise for them`);
    expect(() => firewalledMise(config)).toThrow(`mise ${defaultPins.mise.version}`);
    requires("alpha", "core:bun", "1.4.4", "bun");
    select("alpha");
    answers({ "core:bun": "1.4.4" });
    const refused = await run();

    expect(refused).toContain(`package office requires tool sops, but mise's registry can't be read: the shared tools run only mise ${defaultPins.mise.version}`);
    expect(refused).toContain("no package set was published");
    await expect(bump(loadOffice(office))).rejects.toThrow(`the shared tools run only mise ${defaultPins.mise.version}`);

    // A private copy at the pin is the one used, by its real path, even with a different one first on PATH.
    const xdg = process.env.XDG_DATA_HOME;

    process.env.XDG_DATA_HOME = join(dir, "data");
    const copy = join(hostToolsRoot(), "bin/mise");

    write(copy, `#!/bin/sh\necho "$* | $PWD" >> "$FAKE_MISE/calls"\n[ "$1" != --version ] || { echo ${defaultPins.mise.version}; exit 0; }\nFAKE_MISE_VERSION=${defaultPins.mise.version} exec "${join(fake, "mise")}" "$@"\n`);
    chmodSync(copy, 0o755);

    try {
      expect(officeMise(config)).toEqual({ path: copy, version: defaultPins.mise.version });
    } finally {
      if (xdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = xdg;
    }

    // The office pins a version: that one, and nothing else, is accepted.
    write(join(office, "office.yaml"), yaml.replace("minimum_release_age: 3d\n", "minimum_release_age: 3d\ntools:\n  mise: 2026.11.99\n"));
    expect(officeMise(loadOffice(office))).toEqual({ path: join(fake, "mise"), version: "2026.11.99" });
  } finally {
    delete process.env.FAKE_MISE_VERSION;
  }

  // Nothing was installed, selected or rewritten: only version reports and offline registry reads ran.
  expect(work()).toEqual([]);
  expect(readFileSync(join(fake, "mise"), "utf8")).toBe(fakeMise);
});

test("upgrade-tools leaves the owner's holds of shared tools, bumps their desired releases as bump does, and commits office.lock only with --commit and when it was clean", async () => {
  await published();
  installSfw();
  requires("alpha", "core:bun", "1.4.4", "bun");
  select("alpha");
  answers({ "core:bun": "1.4.4" });
  await run();
  const owner = '[tools]\njq = "1.7.1"\n';

  write(join(office, "machine.toml"), owner);
  git(["init", "-q"], office);
  git(["add", "-A"], office);
  git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "start"], office);

  writeFileSync(join(fake, "outdated"), '{"jq":{"requested":"1.7.1","current":"1.7.1","latest":"1.8.0"}}');
  answers({ "core:bun": "1.4.5" });
  writeFileSync(join(fake, "calls"), "");
  const job = (...args: string[]) => Bun.spawnSync([process.execPath, toolPath("src/cli.ts"), "upgrade-tools", ...args], { cwd: office, env: { ...process.env, XDG_DATA_HOME: dir } });

  // mise's warnings about the selection reach the job's output.
  writeFileSync(join(fake, "warn"), "mise WARN  aws-cli: no release dates; minimum_release_age not applied\n");
  const result = job("--commit");

  expect(result.exitCode).toBe(0);
  expect(`${result.stdout}${result.stderr}`).toContain("mise WARN  aws-cli: no release dates; minimum_release_age not applied");
  expect(`${result.stdout}${result.stderr}`).toContain(`shared tools: mise ${defaultPins.mise.version} at ${join(fake, "mise")}`);
  expect(locked()).toEqual({ "core:bun": "1.4.5" });
  expect(readFileSync(join(office, "machine.toml"), "utf8")).toBe(owner.replace("1.7.1", "1.8.0"));
  expect(git(["show", "--stat", "--format=%s", "HEAD"], office)).toContain("core:bun 1.4.4 → 1.4.5");
  expect(git(["show", "--name-only", "--format=", "HEAD"], office).split("\n").toSorted()).toEqual(["machine.toml", "office.lock"]);
  // Nothing was installed for the shared tool: only mise's own outdated, plan and lock ran for it.
  expect(work().filter(line => line.startsWith("install"))).toEqual(["install jq@1.8.0 | " + office]);

  // A held shared tool in machine.toml is the owner's: the job leaves its line alone.
  write(join(office, "machine.toml"), '[tools]\nbun = "1.4.5"\njq = "1.8.0"\n');
  writeFileSync(join(fake, "outdated"), '{"bun":{"requested":"1.4.5","current":"1.4.5","latest":"1.4.9"},"jq":{"requested":"1.8.0","current":"1.8.0","latest":"1.8.0"}}');
  writeFileSync(join(fake, "releases"), "1.4.5\n");
  writeFileSync(join(fake, "calls"), "");
  expect(job().exitCode).toBe(0);
  expect(readFileSync(join(office, "machine.toml"), "utf8")).toBe('[tools]\nbun = "1.4.5"\njq = "1.8.0"\n');
  expect(work().some(line => line.includes("bun@"))).toBe(false);

  // A selection refused after mise's plan still shows mise's warnings beside the failure.
  requires("alpha", "core:bun", "1.4.6", "bun");
  writeFileSync(join(fake, "releases"), "");
  rmSync(join(office, "machine.toml"));
  answers({ "core:bun": "1.4.5" });
  const below = job();

  expect(below.exitCode).not.toBe(0);
  expect(`${below.stdout}${below.stderr}`).toContain("mise selected tool core:bun 1.4.5, below the 1.4.6 package alpha needs");
  expect(`${below.stdout}${below.stderr}`).toContain("mise WARN  aws-cli: no release dates; minimum_release_age not applied");
  requires("alpha", "core:bun", "1.4.4", "bun");
  rmSync(join(fake, "warn"));

  // With --commit, an office.lock with uncommitted changes is skipped, not committed.
  const head = git(["rev-parse", "HEAD"], office);

  writeFileSync(join(office, "office.lock"), `${readFileSync(join(office, "office.lock"), "utf8")}# local edit\n`);
  job("--commit");
  expect(git(["rev-parse", "HEAD"], office)).toBe(head);
  expect(readFileSync(join(office, "office.lock"), "utf8")).toEndWith("# local edit\n");
});

test("one mise, by its real absolute path, runs every step of an operation, with the host toolchain's node and pnpm handed across isolation", async () => {
  await published();
  installSfw();
  const shims = join(dir, "data/mise/shims");

  const runtimes = join(dir, "runtimes");

  // A shim would resolve through the config isolation hides; the host's own node and pnpm are real files.
  mkdirSync(shims, { recursive: true });

  for (const command of ["node", "pnpm"]) {
    writeFileSync(join(shims, command), "#!/bin/sh\nexit 99\n", { flag: "wx", mode: 0o755 });
    write(join(runtimes, command), "#!/bin/sh\n");
    chmodSync(join(runtimes, command), 0o755);
  }

  const path = process.env.PATH;
  const previous = process.env.XDG_DATA_HOME;

  process.env.XDG_DATA_HOME = join(dir, "data");
  process.env.PATH = `${shims}:${runtimes}:${path}`;

  try {
    expect(miseShims()).toBe(shims);
    const firewalled = firewalledMise(loadOffice(office));
    const tools = firewalled.ok ? firewalled.tools : undefined;

    expect(tools?.mise).toEqual({ path: join(fake, "mise"), version: defaultPins.mise.version });
    expect(tools?.inputs.mise).toEqual([hostLayout(join(fake, "mise")).sfw, join(fake, "mise")]);
    expect(tools?.runtimes).toEqual([runtimes]);
    const env = isolatedEnvironment(process.env, join(dir, "root"), join(dir, "root/plan"), tools?.runtimes);

    expect(env.PATH.split(":")[0]).toBe(runtimes);
    expect(env.PATH.split(":")).not.toContain(shims);
  } finally {
    process.env.PATH = path;
    process.env.XDG_DATA_HOME = previous;
  }
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ghLink, installedTool, needsInstall, officePins, officeTool, officeToolNamed, onboardHostTools, requireOfficeTool, startingVersions } from "../host-tools.ts";
import { hostToolsRoot } from "../mise-bootstrap.ts";
import { installMise, miseAsset, verifyDigest } from "../mise-bootstrap.ts";
import { loadOffice, type Office } from "../../../office.ts";
import { toolPath } from "../../../tool.ts";
import { type Candidate, type Release, selectToolRelease } from "../releases.ts";
import { activate } from "../applied.ts";

let dir: string;
const previous = { PATH: process.env.PATH, XDG_DATA_HOME: process.env.XDG_DATA_HOME };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-host-tools-"));
  process.env.PATH = join(dir, "path");
  process.env.XDG_DATA_HOME = join(dir, "data");
  mkdirSync(process.env.PATH, { recursive: true });
});

afterEach(() => {
  for (const key of ["PATH", "XDG_DATA_HOME"] as const) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }

  rmSync(dir, { recursive: true, force: true });
});

function release(version: string, published = "2026-11-10T12:00:00Z"): Release {
  return { tag_name: `v${version}`, target_commitish: "main", prerelease: false, draft: false, published_at: published, assets: [] };
}

function candidate(version = "2026.11.7"): Candidate {
  const selected = release(version);

  return { version, published: "2026-11-10T12:00:00Z", release: selected };
}

function executable(path: string, version: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!${process.execPath}\nconsole.log(${JSON.stringify(version)});\n`, { mode: 0o755 });
}

/** An office whose machine.packages.toml pins `pins` (beside another package's tool), or has none. */
function office(pins?: Record<string, string>): Office {
  const root = join(dir, "office");

  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "office.yaml"), "name: t\n");

  if (pins !== undefined) {
    writeFileSync(join(root, "machine.packages.toml"), `[tools]\n${Object.entries(pins).map(([tool, version]) => `"${tool}" = "${version}" # office`).join("\n")}\n"bun" = "1.4.4" # browser\n`);
  }

  return loadOffice(root);
}

/** Where the fake mise installs a tool's commands. */
const installs = () => join(dir, "installs");

/** Puts `command` of `tool` at `version` among the fake mise's installs. */
function installed(tool: string, version: string, command = tool): string {
  const path = join(installs(), tool, version, command);

  executable(path, command === "gh" ? `gh version ${version} (2026-11-01)` : `${command} ${version}`);

  return path;
}

// A real subprocess seam, not a module mock: records each request with its folder and whether it
// read config, and installs, finds and lists tools in a folder of its own, as mise does.
function fakeMise(at = join(dir, "path/mise"), version = "2026.11.7", { fail = "" } = {}): void {
  executable(at, version);
  writeFileSync(at, `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const installs = ${JSON.stringify(installs())};
fs.appendFileSync(${JSON.stringify(join(dir, "requests"))}, JSON.stringify({ args, cwd: process.cwd(), noConfig: process.env.MISE_NO_CONFIG }) + "\\n");
const commands = (tool) => tool === "age" ? ["age", "age-keygen"] : [tool];
const write = (file, line) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "#!${process.execPath}\\nconsole.log(" + JSON.stringify(line) + ");\\n", { mode: 0o755 }); };
if (args[0] === "--version") { console.log(${JSON.stringify(version)}); process.exit(0); }
if (args[0] === "install") {
  for (const spec of args.slice(1)) {
    const [tool, version] = spec.split("@");
    if (tool === ${JSON.stringify(fail)}) continue;
    for (const command of commands(tool)) write(path.join(installs, tool, version, command), command === "gh" ? "gh version " + version + " (2026-11-01)" : command + " " + version);
  }
  process.exit(0);
}
if (args[0] === "which") {
  const [tool, version] = args[2].replace("--tool=", "").split("@");
  const file = path.join(installs, tool, version, args[1]);
  if (!fs.existsSync(file)) process.exit(1);
  console.log(file);
  process.exit(0);
}
if (args[0] === "ls") {
  const folder = path.join(installs, args[3]);
  console.log(JSON.stringify((fs.existsSync(folder) ? fs.readdirSync(folder) : []).map((version) => ({ version, installed: true, active: false }))));
  process.exit(0);
}
process.exit(1);
`, { mode: 0o755 });
}

type Request = { args: string[]; cwd: string; noConfig: string | undefined };

function requests(): Request[] {
  const path = join(dir, "requests");

  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
}

const pins = { sops: "3.13.3", age: "1.3.2", gh: "2.104.0", "pre-commit": "4.7.0" };

test("three days means 72 hours inclusive; prereleases, drafts, invalid dates and floating tags never qualify", () => {
  const now = new Date("2026-11-16T12:00:00Z");
  const tooYoung = release("2026.11.9", "2026-11-13T12:00:00.001Z");
  const exact = release("2026.11.8", "2026-11-13T12:00:00Z");
  const preview = { ...release("2026.12.0"), prerelease: true };

  const chosen = selectToolRelease("mise", [
    release("2026.11.6"), tooYoung, exact, preview,
    release("2026.12.1-rc.1"), { ...release("2026.12.2"), draft: true },
    release("2026.12.3", "invalid"), release("latest"),
  ], "3d", now);

  expect(chosen.chosen?.version).toBe("2026.11.8");
  expect(chosen.tooNew).toEqual(["2026.11.9"]);
  expect(needsInstall({ path: "mise", version: "2026.11.9" }, "2026.11.8")).toBe(false);
});

test("the office package starts every office at exact versions of the tools the CLI runs", () => {
  expect(Object.keys(startingVersions())).toEqual(["sops", "age", "gh", "pre-commit"]);

  for (const version of Object.values(startingVersions())) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
});

test("an office's own pin of one of these tools is recognized under its registry name or another backend", () => {
  expect(["sops", "aqua:getsops/sops", "github:getsops/sops[bin=sops]", "gh", "cli/cli", "ubi:cli/cli", "aqua:FiloSottile/age", "pypi:pre-commit", "node", "npm:sops", "aqua:cli/cli-extra"].map(officeToolNamed)).toEqual(["sops", "sops", "sops", "gh", "gh", "gh", "age", "pre-commit", undefined, undefined, undefined]);
});

test("the CLI runs the version the office pins, as mise installed it, over newer copies on PATH and in host-tools, from any folder", () => {
  fakeMise();

  const pinned = installed("sops", "3.13.3");

  executable(join(dir, "path/sops"), "sops 3.14.0");
  executable(join(hostToolsRoot(), "bin/sops"), "sops 3.15.0");

  expect(officeTool(office(pins), "sops")).toEqual({ path: pinned, version: "3.13.3", pinned: "3.13.3", managed: true });
  expect(requests().at(-1)).toEqual({ args: ["which", "sops", "--tool=sops@3.13.3"], cwd: "/", noConfig: "1" });

  // No shims, PATH entry or session-local selection: a new process from another folder finds it too.
  const child = Bun.spawnSync([process.execPath, "-e", `import {requireOfficeTool} from ${JSON.stringify(toolPath("src/features/tools/host-tools.ts"))}; import {loadOffice} from ${JSON.stringify(toolPath("src/office.ts"))}; console.log(requireOfficeTool(loadOffice(${JSON.stringify(join(dir, "office"))}), "sops"));`], { env: process.env, cwd: tmpdir() });

  expect(new TextDecoder().decode(child.stdout).trim()).toBe(pinned);
});

test("until the pinned version is installed, the newest copy anywhere serves; with none, the error says how to install it", () => {
  fakeMise();

  const older = installed("age", "1.2.0", "age-keygen");

  expect(officeTool(office(pins), "age-keygen")).toEqual({ path: older, version: "1.2.0", pinned: "1.3.2", managed: false });

  executable(join(dir, "path/age-keygen"), "v1.2.1");

  expect(officeTool(office(pins), "age-keygen")?.path).toBe("age-keygen");
  expect(() => requireOfficeTool(office(pins), "gh")).toThrow("office setup --install-deps installs the version the office pins in machine.packages.toml");
});

test("unattended missing dependencies require permission and do not create managed state", async () => {
  await expect(onboardHostTools(office(), false, undefined, { lookupMise: async () => candidate() })).rejects.toThrow("--install-deps");
  expect(existsSync(hostToolsRoot())).toBe(false);
});

test("an authorized setup installs the office's pinned versions with mise, from / without config, once, and links gh", async () => {
  fakeMise();
  await onboardHostTools(office({ ...pins, sops: "3.13.2" }), true, undefined, { lookupMise: async () => candidate() });

  expect(requests().filter((request) => request.args[0] === "install")).toEqual([{ args: ["install", "sops@3.13.2", "age@1.3.2", "gh@2.104.0", "pre-commit@4.7.0"], cwd: "/", noConfig: "1" }]);
  expect(requireOfficeTool(office(), "sops")).toBe(join(installs(), "sops/3.13.2/sops"));
  expect(readlinkSync(ghLink())).toBe(join(installs(), "gh/2.104.0/gh"));

  writeFileSync(join(dir, "requests"), "");
  await onboardHostTools(office(), false, async () => { throw new Error("unexpected prompt"); }, { lookupMise: async () => candidate() });

  expect(requests().some((request) => request.args[0] === "install")).toBe(false);
});

test("the office's pins are its tools in machine.packages.toml, and none without that file", () => {
  expect(officePins(office(pins))).toEqual(pins);

  const root = join(dir, "office");

  rmSync(join(root, "machine.packages.toml"));

  expect(officePins(loadOffice(root))).toEqual({});
});

test("before sync writes machine.packages.toml, setup installs the package's starting versions", async () => {
  fakeMise();
  await onboardHostTools(office(), true, undefined, { lookupMise: async () => candidate() });

  expect(requests().find((request) => request.args[0] === "install")?.args.slice(1)).toEqual(Object.entries(startingVersions()).map(([tool, version]) => `${tool}@${version}`));
});

test("installs go through the installer setup passes, such as the Socket Firewall wrapper", async () => {
  fakeMise();
  fakeMise(join(dir, "wrapper/mise"));
  await onboardHostTools(office(pins), true, undefined, { installer: () => join(dir, "wrapper/mise"), lookupMise: async () => candidate() });

  expect(requests().filter((request) => request.args[0] === "install")).toHaveLength(1);
  expect(officeTool(office(), "pre-commit")?.version).toBe("4.7.0");
});

test("declining keeps compatible tools on PATH, with one prompt and no install", async () => {
  fakeMise();
  executable(join(dir, "path/sops"), "sops 3.12.0");
  executable(join(dir, "path/age"), "1.2.0");
  executable(join(dir, "path/age-keygen"), "1.2.0");

  const prompts: string[] = [];

  await onboardHostTools(office(pins), false, async (text) => {
    prompts.push(text);

    return "no";
  }, { lookupMise: async () => candidate() });

  expect(prompts).toEqual(["Install the office's tools? [yes/no]"]);
  expect(requests().some((request) => request.args[0] === "install")).toBe(false);
  expect(officeTool(office(), "sops")?.version).toBe("3.12.0");
});

test("once the office's gh is installed, bin/gh in host-tools links to it, replacing a link to another gh", async () => {
  fakeMise();
  executable(join(dir, "other/gh"), "gh 2.103.3");
  mkdirSync(join(hostToolsRoot(), "bin"), { recursive: true });
  symlinkSync(join(dir, "other/gh"), ghLink());

  await onboardHostTools(office(pins), true, undefined, { lookupMise: async () => candidate() });

  expect(readlinkSync(ghLink())).toBe(join(installs(), "gh/2.104.0/gh"));
});

test("a required tool mise didn't install fails setup; an optional one only warns", async () => {
  fakeMise(undefined, undefined, { fail: "sops" });
  await expect(onboardHostTools(office(pins), true, undefined, { lookupMise: async () => candidate() })).rejects.toThrow("mise didn't install sops 3.13.3");

  rmSync(installs(), { recursive: true });
  rmSync(hostToolsRoot(), { recursive: true });
  fakeMise(undefined, undefined, { fail: "gh" });
  await onboardHostTools(office(pins), true, undefined, { lookupMise: async () => candidate() });

  expect(officeTool(office(), "sops")?.version).toBe("3.13.3");
  expect(existsSync(ghLink())).toBe(false);
});

test("a tool mise installed that doesn't run is named as such, not as a failed download", async () => {
  fakeMise(undefined, undefined, { fail: "pre-commit" });

  // What mise leaves without Python 3: the command is there, but it can't run.
  const broken = join(installs(), "pre-commit", pins["pre-commit"], "pre-commit");

  mkdirSync(dirname(broken), { recursive: true });
  writeFileSync(broken, "#!/nonexistent/python3\n", { mode: 0o755 });

  const printed: string[] = [];
  const log = console.log;

  console.log = (line: string) => printed.push(line);

  try {
    await onboardHostTools(office(pins), true, undefined, { lookupMise: async () => candidate() });
  } finally {
    console.log = log;
  }

  expect(printed.at(-1)).toBe(`Warning: mise installed pre-commit ${pins["pre-commit"]} (it needs Python 3), but it doesn't run on this host (\`--version\` fails); install what it needs and rerun office setup`);
});

test("PATH wins ties against host-tools' private mise, which wins when newer", () => {
  const bin = join(hostToolsRoot(), "bin");

  executable(join(dir, "path/mise"), "2026.11.2");
  executable(join(bin, "mise"), "2026.11.7");
  expect(installedTool("mise")?.path).toBe(join(bin, "mise"));
  executable(join(dir, "path/mise"), "2026.11.7");
  expect(installedTool("mise")?.path).toBe("mise");
});

test("integrity failures fail closed, and bootstrap checks the exact executable version before selection", async () => {
  const bytes = new TextEncoder().encode(`#!${process.execPath}\nconsole.log("2026.11.7");\n`);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(bytes) });
  const selected = candidate();
  const asset = { name: miseAsset(selected.version), state: "uploaded", digest: `sha256:${"0".repeat(64)}`, browser_download_url: `http://127.0.0.1:${server.port}/mise` };

  selected.release.assets.push(asset);

  try {
    await expect(installMise(selected)).rejects.toThrow("SHA-256 verification");
    expect(installedTool("mise")).toBeUndefined();
    asset.digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    await installMise(selected);
    expect(installedTool("mise")?.version).toBe("2026.11.7");
    selected.version = "2026.11.8";
    asset.name = miseAsset(selected.version);
    await expect(installMise(selected)).rejects.toThrow("does not report");
    expect(installedTool("mise")?.version).toBe("2026.11.7");
  } finally {
    server.stop(true);
  }

  expect(() => verifyDigest(bytes, null, "mise")).toThrow("no authoritative");
  expect(() => miseAsset("2026.11.7", "win32", "x64")).toThrow("WSL");
});

test("in a host-mode office, setup leaves to the shared tools a tool they apply, and the CLI runs their executable", async () => {
  fakeMise();
  const root = join(dir, "host-office");
  const state = join(dir, "host-state");
  const bin: Record<string, { path: string; sha256: string }> = {};

  for (const command of ["sops", "age", "age-keygen", "gh", "pre-commit"]) {
    const path = join(state, "tools/mise/installs", command, command);

    executable(path, `${command} 9.9.9`);
    bin[command] = { path, sha256: `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}` };
  }

  activate({ state }, { tools: new Map([["shared", { version: "9.9.9", identity: "test", names: [], bin }]]), highest: new Map([["shared", "9.9.9"]]) });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "office.yaml"), `name: t\nstate: ${state}\nopencode: {mode: host, url: 'http://127.0.0.1:49999'}\n`);
  writeFileSync(join(root, "machine.packages.toml"), `[tools]\n${Object.entries(pins).map(([tool, version]) => `"${tool}" = "${version}" # office`).join("\n")}\n`);
  const host = loadOffice(root);

  await onboardHostTools(host, false, async () => { throw new Error("unexpected prompt"); }, { lookupMise: async () => candidate() });

  expect(requests().some((request) => request.args[0] === "install")).toBe(false);
  expect(requireOfficeTool(host, "sops")).toBe(bin.sops.path);
  expect(officeTool(host, "gh")).toEqual({ path: bin.gh.path, version: "9.9.9", pinned: pins.gh, managed: true });
});

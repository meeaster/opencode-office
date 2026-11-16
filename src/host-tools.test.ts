import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hostTool, hostToolsRoot, installedTool, installMise, miseAsset, needsInstall, onboardHostTools, verifyDigest } from "./host-tools.ts";
import { type Candidate, type Release, selectToolRelease } from "./releases.ts";

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
  writeFileSync(path, `#!${process.execPath}\nconsole.log(${JSON.stringify(version)});\n`, { mode: 0o755 });
}

// A real subprocess seam, not a module mock: records exact requests and supplies tool executables.
function fakeMise(version = "2026.11.7"): void {
  writeFileSync(join(dir, "path/mise"), `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const root = ${JSON.stringify(dir)};
fs.appendFileSync(path.join(root, "requests"), JSON.stringify(args) + "\\n");
if (args[0] === "--version") { console.log(${JSON.stringify(version)}); process.exit(0); }
if (args[0] === "latest") { console.log(args[1].includes("sops") ? "3.13.3" : args[1].includes("cli/cli") ? "2.104.0" : "1.3.2"); process.exit(0); }
if (args[0] === "install") {
  if (Object.keys(process.env).some(k => k === "MISE_DATA_DIR" && !process.env[k].startsWith(root))) process.exit(1);
  const age = args[1].includes("age@");
  const names = age ? ["age", "age-keygen"] : args[1].includes("cli/cli") ? ["gh"] : ["sops"];
  const version = args[1].split("@").at(-1);
  for (const name of names) fs.writeFileSync(path.join(root, "installed-" + name), "#!${process.execPath}\\nconsole.log(" + JSON.stringify(version) + ");\\n", { mode: 0o755 });
  process.exit(0);
}
if (args[0] === "which") { console.log(path.join(root, "installed-" + args[1])); process.exit(0); }
process.exit(1);
`, { mode: 0o755 });
}

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

test("PATH wins ties, managed wins when newer, PATH newer is never downgraded", () => {
  const bin = join(hostToolsRoot(), "bin");

  mkdirSync(bin, { recursive: true });
  executable(join(dir, "path/sops"), "sops 3.13.2");
  executable(join(bin, "sops"), "sops 3.13.3");
  expect(hostTool("sops")).toBe(join(bin, "sops"));
  executable(join(dir, "path/sops"), "sops 3.13.3");
  expect(hostTool("sops")).toBe("sops");
  executable(join(dir, "path/sops"), "sops 3.14.0");
  expect(installedTool("sops")?.version).toBe("3.14.0");
  expect(hostTool("sops")).toBe("sops");
});

test("unattended missing dependencies require permission and do not create managed state", async () => {
  await expect(onboardHostTools(false, undefined, { lookupMise: async () => candidate() })).rejects.toThrow("--install-deps");
  expect(existsSync(hostToolsRoot())).toBe(false);
});

test("declining updates keeps compatible old tools without installation", async () => {
  fakeMise("2026.11.2");
  executable(join(dir, "path/sops"), "sops 3.12.0");
  executable(join(dir, "path/age"), "1.2.0");
  executable(join(dir, "path/age-keygen"), "1.2.0");
  let prompts = 0;

  await onboardHostTools(false, async () => { prompts++;

 return "no"; }, { lookupMise: async () => candidate() });
  expect(prompts).toBe(1);
  expect(readFileSync(join(dir, "requests"), "utf8")).not.toContain('"install"');
  expect(installedTool("sops")?.version).toBe("3.12.0");
});

test("authorized fresh SOPS/age install uses exact resolved versions and works without shell activation", async () => {
  fakeMise();
  await onboardHostTools(true, undefined, { lookupMise: async () => candidate() });

  const requests = readFileSync(join(dir, "requests"), "utf8");

  expect(requests).toContain('["latest","github:getsops/sops[bin=sops]","--minimum-release-age","3d"]');
  expect(requests).toContain('["install","github:getsops/sops[bin=sops]@3.13.3"]');
  expect(requests).toContain('["install","github:FiloSottile/age@1.3.2"]');
  expect(hostTool("sops")).toBe(join(hostToolsRoot(), "bin/sops"));
  expect(installedTool("age-keygen")?.version).toBe("1.3.2");

  // No inherited PATH changes or session-local selection is needed in a new process.
  const child = Bun.spawnSync([process.execPath, "-e", `import {hostTool} from ${JSON.stringify(join(import.meta.dir, "host-tools.ts"))}; console.log(hostTool("sops"));`], { env: process.env });

  expect(child.exitCode).toBe(0);
  expect(new TextDecoder().decode(child.stdout).trim()).toBe(join(hostToolsRoot(), "bin/sops"));
});

test("one update confirmation supplies managed tools without replacing older PATH executables", async () => {
  fakeMise();
  executable(join(dir, "path/sops"), "sops 3.12.0");
  executable(join(dir, "path/age"), "1.2.0");
  executable(join(dir, "path/age-keygen"), "1.2.0");
  const original = readFileSync(join(dir, "path/sops"), "utf8");
  let prompts = 0;

  await onboardHostTools(false, async () => {
    prompts++;

    return "yes";
  }, { lookupMise: async () => candidate() });
  expect(prompts).toBe(1);
  expect(installedTool("sops")?.version).toBe("3.13.3");
  expect(installedTool("age")?.version).toBe("1.3.2");
  expect(readFileSync(join(dir, "path/sops"), "utf8")).toBe(original);
});

test("mise's non-exact or prerelease answer is rejected before install", async () => {
  writeFileSync(join(dir, "path/mise"), `#!${process.execPath}
console.log(process.argv[2] === "--version" ? "2026.11.7" : "3.14.0-rc.1");
`, { mode: 0o755 });
  await expect(onboardHostTools(true, undefined, { lookupMise: async () => candidate() })).rejects.toThrow("no exact stable version");
  expect(existsSync(join(hostToolsRoot(), "bin/sops"))).toBe(false);
});

test("newer installed tools are kept, including versions inside the waiting period", async () => {
  fakeMise("2026.11.9");
  executable(join(dir, "path/sops"), "sops 3.14.0");
  executable(join(dir, "path/age"), "1.4.0");
  executable(join(dir, "path/age-keygen"), "1.4.0");
  await onboardHostTools(true, async () => { throw new Error("unexpected prompt"); }, { lookupMise: async () => candidate() });
  expect(readFileSync(join(dir, "requests"), "utf8")).not.toContain('"install"');
  expect(hostTool("sops")).toBe("sops");
});

test("repairing missing age-keygen keeps a newer managed age selected", async () => {
  fakeMise();
  executable(join(dir, "path/sops"), "sops 3.13.3");
  mkdirSync(join(hostToolsRoot(), "bin"), { recursive: true });
  executable(join(hostToolsRoot(), "bin/age"), "1.4.0");
  await onboardHostTools(true, undefined, { lookupMise: async () => candidate() });
  expect(installedTool("age")?.version).toBe("1.4.0");
  expect(installedTool("age-keygen")?.version).toBe("1.3.2");
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

test("gh is optional: unattended runs never require it, and an authorized run installs the exact version", async () => {
  fakeMise();
  executable(join(dir, "path/sops"), "sops 3.13.3");
  executable(join(dir, "path/age"), "1.3.2");
  executable(join(dir, "path/age-keygen"), "1.3.2");

  await onboardHostTools(false, undefined, { gh: true, lookupMise: async () => candidate() });
  expect(installedTool("gh")).toBeUndefined();

  await onboardHostTools(true, undefined, { gh: true, lookupMise: async () => candidate() });
  expect(readFileSync(join(dir, "requests"), "utf8")).toContain('["install","github:cli/cli@2.104.0"]');
  expect(hostTool("gh")).toBe(join(hostToolsRoot(), "bin/gh"));
});

test("an older gh joins the one grouped confirmation; declining keeps it, and a newer gh is never replaced", async () => {
  fakeMise();
  executable(join(dir, "path/sops"), "sops 3.12.0");
  executable(join(dir, "path/age"), "1.3.2");
  executable(join(dir, "path/age-keygen"), "1.3.2");
  executable(join(dir, "path/gh"), "gh version 2.103.3 (2026-10-26)");
  const prompts: string[] = [];

  await onboardHostTools(false, async (text) => {
    prompts.push(text);

    return "no";
  }, { gh: true, lookupMise: async () => candidate() });
  expect(prompts).toHaveLength(1);
  expect(installedTool("gh")?.version).toBe("2.103.3");

  await onboardHostTools(false, async () => "yes", { gh: true, lookupMise: async () => candidate() });
  expect(installedTool("gh")?.version).toBe("2.104.0");
  expect(installedTool("sops")?.version).toBe("3.13.3");

  executable(join(dir, "path/gh"), "gh version 2.105.0 (2026-11-15)");
  writeFileSync(join(dir, "requests"), "");
  await onboardHostTools(true, async () => { throw new Error("unexpected prompt"); }, { gh: true, lookupMise: async () => candidate() });
  expect(readFileSync(join(dir, "requests"), "utf8")).not.toContain('"install"');
  expect(hostTool("gh")).toBe("gh");
});

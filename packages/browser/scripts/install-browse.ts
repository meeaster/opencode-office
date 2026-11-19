// Installs Browse's binary as ~/.local/bin/browse, from the stable channel of Anomaly's release
// service, as https://opencode.ai/browse/install does without its setup step: no `browse install`,
// no agent configs, no pairing. The package's mise fragment (.office/mise/browser.toml) runs it, in a host-mode office, when
// that file is missing (its postinstall hook) or on demand (`mise run browser:install`). From then
// on Browse updates itself, as its Chrome extension does; office never pins it.
//
// It runs with nothing but Bun. Usage: bun install-browse.ts
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** The release service the official installer uses. */
export const releaseService = "https://anoma.ly/release";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** One file of a release, as the manifest lists it for a target. */
export type Artifact = { version: string; url: string; size: number; sha256: string };

/** What this machine is, as the official installer reads it. */
export type Machine = { platform: string; arch: string; avx2: boolean; musl: boolean; rosetta: boolean };

/** The value of `key` in a JSON object, or undefined for anything else. */
function field(value: Json | undefined, key: string): Json | undefined {
  if (value === undefined || value === null || Array.isArray(value) || !(value instanceof Object)) return undefined;

  return value[key];
}

/**
 * The stable channel's file for `target`, checked against the manifest's shape: browse's CLI on
 * the stable channel, a version, and for the target a path on the service, a size and a SHA-256.
 * Throws naming what doesn't match.
 */
export function parseManifest(document: Json, target: string): Artifact {
  if (field(document, "app") !== "browse" || field(document, "artifact") !== "cli" || field(document, "channel") !== "stable") {
    throw new Error("the manifest isn't the stable channel of browse's CLI");
  }

  const release = field(document, "release");
  const version = String(field(release, "version"));

  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("the manifest's release has no version");

  const file = field(field(release, "targets"), target);

  if (file === undefined) throw new Error(`the stable release ${version} has no build for ${target}`);

  const url = String(field(file, "url"));
  const size = field(file, "size");
  const sha256 = String(field(file, "sha256"));

  if (!/^\/release\/browse\/files\/[0-9a-f]{64}\/[A-Za-z0-9._-]+\.tgz$/.test(url)) throw new Error(`the ${target} build's url isn't a file on the release service`);

  if (!Number.isSafeInteger(size) || Number(size) <= 0) throw new Error(`the ${target} build has no size`);

  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`the ${target} build has no SHA-256`);

  return { version, url, size: Number(size), sha256 };
}

/**
 * The release service's name for a machine's build: `<os>-<arch>`, then `-baseline` for x64
 * without AVX2 and `-musl` for musl's libc. Throws for a platform Browse doesn't build for.
 */
export function targetFor(machine: Machine): string {
  const os = { linux: "linux", darwin: "macos" }[machine.platform];
  // An x64 process on Apple silicon runs under Rosetta; the arm64 build is the native one.
  const arch = machine.platform === "darwin" && machine.rosetta ? "arm64" : { x64: "x64", arm64: "arm64" }[machine.arch];

  if (os === undefined || arch === undefined) throw new Error(`browse has no build for ${machine.platform}-${machine.arch}; see https://opencode.ai/browse`);

  return `${os}-${arch}${arch === "x64" && !machine.avx2 ? "-baseline" : ""}${machine.platform === "linux" && machine.musl ? "-musl" : ""}`;
}

function output(command: string[]): string {
  try {
    const result = Bun.spawnSync(command, { stderr: "pipe" });

    return `${result.stdout.toString()}${result.stderr.toString()}`;
  } catch {
    return "";
  }
}

/** This machine, read the way the official installer reads it. */
function thisMachine(): Machine {
  const { platform, arch } = process;

  if (platform === "darwin") {
    return { platform, arch, avx2: output(["sysctl", "-n", "hw.optional.avx2_0"]).trim() === "1", musl: false, rosetta: output(["sysctl", "-n", "sysctl.proc_translated"]).trim() === "1" };
  }

  const cpuinfo = existsSync("/proc/cpuinfo") ? readFileSync("/proc/cpuinfo", "utf8") : "";

  return { platform, arch, avx2: /\bavx2\b/i.test(cpuinfo), musl: existsSync("/etc/alpine-release") || /musl/i.test(output(["ldd", "--version"])), rosetta: false };
}

async function download(url: string): Promise<Response> {
  const response = await fetch(url, { headers: { "user-agent": "office-browser-package" } });

  if (!response.ok) throw new Error(`${url} answered ${response.status}`);

  return response;
}

/**
 * Downloads the stable release's build for `machine`, checks its size and SHA-256 against the
 * manifest, unpacks `package/bin/browse` and renames it over `<home>/.local/bin/browse`, so a relay
 * still running the old binary keeps its file. Returns the version installed.
 */
export async function installBrowse({ home, machine, service = releaseService }: { home: string; machine: Machine; service?: string }): Promise<{ version: string; path: string }> {
  const target = targetFor(machine);
  const document: Json = JSON.parse(await (await download(`${service}/browse/cli/stable.json`)).text());
  const artifact = parseManifest(document, target);
  const bytes = new Uint8Array(await (await download(`${new URL(service).origin}${artifact.url}`)).arrayBuffer());

  if (bytes.length !== artifact.size) throw new Error(`the download is ${bytes.length} bytes, not the manifest's ${artifact.size}; nothing was installed`);

  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

  if (sha256 !== artifact.sha256) throw new Error(`the download's SHA-256 is ${sha256}, not the manifest's ${artifact.sha256}; nothing was installed`);

  const work = mkdtempSync(join(tmpdir(), "browse-install-"));

  try {
    writeFileSync(join(work, "browse.tgz"), bytes);

    const tar = Bun.spawnSync(["tar", "-xzf", join(work, "browse.tgz"), "-C", work], { stderr: "pipe" });
    const unpacked = join(work, "package/bin/browse");

    if (tar.exitCode !== 0 || !existsSync(unpacked)) throw new Error(`the download has no package/bin/browse: ${tar.stderr.toString().trim()}`);

    const dir = join(home, ".local/bin");
    const path = join(dir, "browse");

    mkdirSync(dir, { recursive: true });
    copyFileSync(unpacked, `${path}.new`);
    chmodSync(`${path}.new`, 0o755);
    renameSync(`${path}.new`, path);

    return { version: artifact.version, path };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const { version, path } = await installBrowse({ home: process.env.HOME ?? homedir(), machine: thisMachine() });

    console.log(`browse ${version} installed at ${path} (size and SHA-256 checked); it updates itself from now on. Pair Chrome once: ${path} pair`);
  } catch (error) {
    console.error(`browse wasn't installed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

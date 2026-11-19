// `office update`: replaces this compiled `office` with a release from the tool's GitHub releases,
// read without a login. By default it takes the newest eligible release without waiting.
// --minimum-release-age sets a wait for this update; office.yaml's ages don't apply, since one
// executable serves several offices. Only --version can install an older release.
// The new executable is downloaded beside the old one, checked against the release's SHA256SUMS,
// run once to confirm it reports the release's version and commit, and only then renamed over the
// old one. It changes no office: each office picks it up with `office sync` and `office up`.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { fetchBytes } from "../download.ts";
import { OfficeError } from "../office.ts";
import { ageMs, type Release, releaseByTag, releases } from "../releases.ts";
import { type Build, build, toolPath, toolRepository, version } from "../tool.ts";
import { compareVersions } from "../versions.ts";

/** The tags the release workflow publishes: the package version and the UTC time of the build. */
const releaseTag = /^\d+\.\d+\.\d+-\d{8}T\d{6}Z$/;

/** The executable a release publishes for this machine. */
const assetName = `office-${process.platform}-${process.arch}`;

const sumsName = "SHA256SUMS";

/** What `office update` installs: a release's executable for this machine and its checksum file. */
export type Download = {
  tag: string;
  /** The 12-character commit the executable must report, when the release names its commit. */
  commit: string | undefined;
  name: string;
  binary: string;
  sums: string;
};

export type UpdateOptions = { check: boolean; age: string; version: string | undefined };

// Host-mode timers and cron scripts run this file, so they use the new `office` right away; a
// container keeps the copy its image was built with until `office up`.
const nextSteps = `Offices still hold the previous office's plugins, and containers its copy. In each office:
  office sync    refresh its copies of the tool's plugins, then commit them
  office up      restart with this office (container mode rebuilds the opencode image with it).
                 It keeps the applied OpenCode, Claude Code, Executor and mise versions; only
                 office up --upgrade applies pending ones from office.yaml
  office check   confirm the container runs this office and nothing drifted`;

function uploaded(release: Release, name: string) {
  return release.assets.find((asset) => asset.name === name && asset.state === "uploaded");
}

/** The download for `release`, failing clearly when it publishes nothing for this machine. */
function downloadOf(release: Release): Download {
  const binary = uploaded(release, assetName);
  const sums = uploaded(release, sumsName);

  if (binary === undefined) {
    const published = release.assets.filter((asset) => asset.name.startsWith("office-")).map((asset) => asset.name);

    throw new OfficeError(`release ${release.tag_name} has no ${assetName} for this machine (it publishes ${published.join(", ") || "no executables"}); build office from a checkout instead (see README.md)`);
  }

  if (sums === undefined) throw new OfficeError(`release ${release.tag_name} has no ${sumsName}, so its ${assetName} can't be verified`);

  const commit = /^[0-9a-f]{40}$/.test(release.target_commitish) ? release.target_commitish.slice(0, 12) : undefined;

  return { tag: release.tag_name, commit, name: assetName, binary: binary.browser_download_url, sums: sums.browser_download_url };
}

/** What `office update` found among the releases, before comparing with this `office`. */
export type Selection = {
  /** The highest complete release at least the minimum age old. */
  chosen: Release | undefined;
  /** Complete releases too new for the age. */
  tooNew: string[];
  /** Releases with this machine's executable but no SHA256SUMS, which can't be verified. */
  incomplete: string[];
  /** The release version this `office` counts as; undefined for a local build no release can place. */
  baseline: string | undefined;
};

/**
 * Picks the highest office release that publishes this machine's executable and SHA256SUMS and is
 * at least `age` old. A local build has no release version, so it is placed by the newest release
 * built from its commit; a build of a commit no release has, or with uncommitted changes, gets no
 * baseline. Throws when no release publishes this machine's executable, or none can be verified.
 */
export function selectRelease(listed: Release[], current: Build, age: string, now = Date.now()): Selection {
  const office = listed.filter((release) => releaseTag.test(release.tag_name) && !release.draft && release.published_at !== null);

  if (office.length === 0) throw new OfficeError(`${toolRepository} has no published releases of office`);

  office.sort((left, right) => compareVersions(right.tag_name, left.tag_name));

  const forMachine = office.filter((release) => uploaded(release, assetName) !== undefined);

  if (forMachine.length === 0) throw new OfficeError(`no release of office publishes ${assetName} for this machine; build office from a checkout instead (see README.md)`);

  const complete = forMachine.filter((release) => uploaded(release, sumsName) !== undefined);
  const incomplete = forMachine.flatMap((release) => (uploaded(release, sumsName) === undefined ? [release.tag_name] : []));

  if (complete.length === 0) throw new OfficeError(`no release of office that publishes ${assetName} also publishes ${sumsName}, so none can be verified (${incomplete.join(", ")})`);

  const cutoff = now - ageMs(age);
  const isOldEnough = (release: Release) => new Date(release.published_at ?? "").getTime() <= cutoff;
  const baseline = releaseTag.test(current.version) ? current.version : current.dirty ? undefined : office.find((release) => release.target_commitish.startsWith(current.commit))?.tag_name;

  return {
    chosen: complete.find(isOldEnough),
    tooNew: complete.flatMap((release) => (isOldEnough(release) ? [] : [release.tag_name])),
    incomplete,
    baseline,
  };
}

/** The newest eligible release (see selectRelease), when it is newer than this `office`. */
async function newest(current: Build, age: string): Promise<Download | undefined> {
  // The workflow keeps ten releases, but further pages are read so an old enough release is never missed.
  const { chosen, tooNew, incomplete, baseline } = selectRelease(await releases(toolRepository, 10), current, age);

  if (incomplete.length > 0) console.log(`skipped, without ${sumsName}: ${incomplete.join(", ")}`);

  if (chosen === undefined) {
    console.log(`no release is at least ${age} old${tooNew.length > 0 ? `; newer: ${tooNew.join(", ")} (office update --version <release> installs one now)` : ""}`);

    return undefined;
  }

  console.log(`newest release at least ${age} old: ${chosen.tag_name}, published ${chosen.published_at}`);

  if (baseline === undefined) {
    const built = current.dirty ? `commit ${current.commit} with uncommitted changes` : `commit ${current.commit}, which no release was built from`;

    console.log(`this is a local build of ${built}, so office update can't tell whether ${chosen.tag_name} is newer; office update --version ${chosen.tag_name} installs it anyway`);

    return undefined;
  }

  const order = compareVersions(chosen.tag_name, baseline);

  if (order === 0) console.log(baseline === current.version ? "already current" : `already current: release ${baseline} was built from this commit`);
  else if (order < 0) console.log(`this office is newer than ${chosen.tag_name}; nothing to do`);

  return order > 0 ? downloadOf(chosen) : undefined;
}

/** The release tagged `tag`, whatever its age, unless this `office` already is that release. */
async function exact(current: Build, tag: string): Promise<Download | undefined> {
  if (!releaseTag.test(tag)) throw new OfficeError(`${tag} isn't an office release; releases are named like 0.1.0-20261116T163238Z`);

  const release = await releaseByTag(toolRepository, tag);

  if (release === undefined || release.draft || release.published_at === null) throw new OfficeError(`${toolRepository} has no release ${tag}`);

  if (current.version === tag && !current.dirty) {
    console.log(`already running ${tag}`);

    return undefined;
  }

  if (releaseTag.test(current.version) && compareVersions(tag, current.version) < 0) console.log(`${tag} is older than this office's ${current.version}`);

  return downloadOf(release);
}

/** The SHA-256 `sums` lists for `name`, as `sha256sum` writes it. */
function listedHash(sums: string, name: string): string | undefined {
  for (const line of sums.split("\n")) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());

    if (match?.[2] === name) return match[1];
  }

  return undefined;
}

/**
 * Replaces `executable` with `download`: written to a hidden file beside it (the same filesystem,
 * so the final rename is atomic), checked against SHA256SUMS, run with --version, then renamed
 * over it. Any failure leaves `executable` as it was and removes the download.
 */
export async function replaceExecutable(executable: string, download: Download): Promise<void> {
  const dir = dirname(executable);
  const unchanged = `${executable} is unchanged`;

  try {
    accessSync(dir, constants.W_OK);
  } catch {
    throw new OfficeError(`can't write to ${dir}, so office update can't replace ${executable}. It never uses sudo: run it as the user who owns that folder, or install a release by hand (see README.md)`);
  }

  const temporary = join(dir, `.${basename(executable)}.update-${process.pid}`);

  try {
    const expected = listedHash(new TextDecoder().decode(await fetchBytes(download.sums, `${download.tag}'s ${sumsName}`)), download.name);

    if (expected === undefined) throw new OfficeError(`${download.tag}'s ${sumsName} lists no ${download.name}; ${unchanged}`);

    const bytes = await fetchBytes(download.binary, `${download.tag}'s ${download.name}`);
    const actual = createHash("sha256").update(bytes).digest("hex");

    if (actual !== expected) throw new OfficeError(`the downloaded ${download.name} has SHA-256 ${actual}, but ${download.tag}'s ${sumsName} lists ${expected}; ${unchanged}`);

    writeFileSync(temporary, bytes, { mode: 0o755 });

    let reported;

    try {
      reported = execFileSync(temporary, ["--version"], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch (error) {
      throw new OfficeError(`the downloaded office didn't run (${error instanceof Error ? error.message.trim() : String(error)}); ${unchanged}`);
    }

    const identity = `office ${download.tag} (commit ${download.commit ?? ""}`;

    if (!(download.commit === undefined ? reported.startsWith(identity) : reported === `${identity})`)) {
      throw new OfficeError(`the downloaded office reports "${reported}", not ${download.tag}${download.commit === undefined ? "" : ` at commit ${download.commit}`}; ${unchanged}`);
    }

    try {
      renameSync(temporary, executable);
    } catch (error) {
      throw new OfficeError(`couldn't replace ${executable}: ${error instanceof Error ? error.message.trim() : String(error)}; ${unchanged}`);
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

export async function update({ check, age, version: wanted }: UpdateOptions): Promise<void> {
  if (!Bun.isStandaloneExecutable) {
    throw new OfficeError(`this office runs from the checkout at ${toolPath("")} with Bun, so there is no executable to update. Update the checkout with git pull; pnpm run install-office builds an executable from it`);
  }

  // The file itself, not a symlink to it: renaming over a link would replace the link with a copy.
  const executable = realpathSync(process.execPath);
  const current = build();

  console.log(`this office: ${version()}, at ${executable}`);

  const download = wanted === undefined ? await newest(current, age) : await exact(current, wanted);

  if (download === undefined) return;

  if (check) {
    // The command that would install it now; a later plain `office update` may pick another release.
    console.log(wanted === undefined ? `office update --minimum-release-age ${age} would install ${download.tag}; office update --version ${download.tag} installs exactly that release` : `office update --version ${wanted} would install ${download.tag}`);

    return;
  }

  await replaceExecutable(executable, download);
  console.log(`installed office ${download.tag} at ${executable}\n\n${nextSteps}`);
}

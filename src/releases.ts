// Looks up the releases of the four tools office.yaml pins, on GitHub and (for Executor's image)
// its registry, without a login. Each tool's releases are filtered by tag to the line the office
// runs, aged against the office's minimum release age, and the highest version wins.
import * as v from "valibot";

import { OfficeError } from "./office.ts";
import { check, type PinnedTool } from "./schema.ts";
import { compareVersions, type Pin } from "./versions.ts";

type Source = {
  repo: string;
  /** Matches the tags of the line the office runs; the first group is the version. */
  tag: RegExp;
  /** Executor marks its v2 releases as pre-releases; the others' pre-releases don't count. */
  prereleases: boolean;
  /** The release file the image downloads, whose digest GitHub reports; Executor is an image instead. */
  asset: ((version: string) => string) | undefined;
};

export const sources: Record<PinnedTool, Source> = {
  opencode: { repo: "anomalyco/opencode", tag: /^v(\d+\.\d+\.\d+)$/, prereleases: false, asset: () => "opencode-linux-x64.tar.gz" },
  claude: { repo: "anthropics/claude-code", tag: /^v(\d+\.\d+\.\d+)$/, prereleases: false, asset: () => "claude-linux-x64.tar.gz" },
  mise: { repo: "jdx/mise", tag: /^v(\d+\.\d+\.\d+)$/, prereleases: false, asset: (version) => `mise-v${version}-linux-x64` },
  executor: { repo: "UsefulSoftwareCo/executor", tag: /^executor@(2\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/, prereleases: true, asset: undefined },
};

const executorImage = "usefulsoftwareco/executor-selfhost";

const releasesSchema = v.array(
  v.object({
    tag_name: v.string(),
    prerelease: v.boolean(),
    draft: v.boolean(),
    published_at: v.nullable(v.string()),
    assets: v.array(v.object({ name: v.string(), state: v.string(), digest: v.nullish(v.string()) })),
  }),
);

type Release = v.InferOutput<typeof releasesSchema>[number];

async function getJson(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const response = await fetch(url, { headers: { "user-agent": "office", ...headers }, signal: AbortSignal.timeout(30_000) });

  return { status: response.status, body: await response.text() };
}

/** The newest hundred releases of a repository: enough for every line the office follows. */
async function releases(repo: string): Promise<Release[]> {
  const { status, body } = await getJson(`https://api.github.com/repos/${repo}/releases?per_page=100`, {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  });

  if (status === 403 || status === 429) throw new OfficeError(`GitHub refused to list ${repo}'s releases (HTTP ${status}, probably its rate limit for requests without a login)`);

  if (status !== 200) throw new OfficeError(`GitHub answered HTTP ${status} for ${repo}'s releases`);

  const result = check(v.safeParse(releasesSchema, JSON.parse(body)));

  if (!result.ok) throw new OfficeError(`GitHub's release list for ${repo} has an unexpected shape: ${result.errors[0]}`);

  return result.value;
}

/** A duration such as 36h, 1d or 2w in milliseconds. */
export function ageMs(age: string): number {
  const units = { h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  const unit = age.at(-1);

  return Number(age.slice(0, -1)) * (unit === "h" ? units.h : unit === "w" ? units.w : units.d);
}

export type Candidate = { version: string; published: string; release: Release };

export type Lookup = {
  /** The highest version at least `age` old, or undefined when none is. */
  chosen: Candidate | undefined;
  /** Versions of the line too new for `age`. */
  tooNew: string[];
  /** Tags of other lines the filter left out. */
  ignored: string[];
};

/** The highest release of `tool`'s line that is at least `age` old. */
export async function newestRelease(tool: PinnedTool, age: string, now = new Date()): Promise<Lookup> {
  const source = sources[tool];
  const cutoff = now.getTime() - ageMs(age);
  const candidates: Candidate[] = [];
  const tooNew: string[] = [];
  const ignored: string[] = [];

  for (const release of await releases(source.repo)) {
    const version = source.tag.exec(release.tag_name)?.[1];

    if (version === undefined || release.draft || release.published_at === null || (release.prerelease && !source.prereleases)) {
      ignored.push(release.tag_name);
      continue;
    }

    if (new Date(release.published_at).getTime() > cutoff) tooNew.push(version);
    else candidates.push({ version, published: release.published_at, release });
  }

  candidates.sort((left, right) => compareVersions(right.version, left.version));

  return { chosen: candidates[0], tooNew, ignored };
}

/** The digest of a version of Executor's image, or undefined when the registry has no such tag. */
async function imageDigest(version: string): Promise<string | undefined> {
  const token = await getJson(`https://ghcr.io/token?scope=repository:${executorImage}:pull`, {});

  if (token.status !== 200) throw new OfficeError(`ghcr.io refused an anonymous token (HTTP ${token.status})`);

  const parsed = check(v.safeParse(v.object({ token: v.string() }), JSON.parse(token.body)));

  if (!parsed.ok) throw new OfficeError("ghcr.io's token answer has an unexpected shape");

  const response = await fetch(`https://ghcr.io/v2/${executorImage}/manifests/${version}`, {
    method: "HEAD",
    headers: {
      authorization: `Bearer ${parsed.value.token}`,
      accept: [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
      ].join(", "),
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (response.status === 404) return undefined;

  if (!response.ok) throw new OfficeError(`ghcr.io answered HTTP ${response.status} for ${executorImage}:${version}`);

  return response.headers.get("docker-content-digest") ?? undefined;
}

/**
 * The pin for a version: the digest GitHub reports for the release file the image downloads, or
 * Executor's image digest. Throws when the release, its file or the image doesn't exist.
 */
export async function pinFor(tool: PinnedTool, version: string, release?: Release): Promise<Pin> {
  const source = sources[tool];

  if (source.asset === undefined) {
    const digest = await imageDigest(version);

    if (digest === undefined) throw new OfficeError(`${executorImage}:${version} doesn't exist on ghcr.io`);

    return { version, digest };
  }

  const found = release ?? (await releases(source.repo)).find((entry) => source.tag.exec(entry.tag_name)?.[1] === version);
  const name = source.asset(version);
  const asset = found?.assets.find((entry) => entry.name === name && entry.state === "uploaded");

  if (found === undefined) throw new OfficeError(`${source.repo} has no release ${version} among its newest hundred`);

  if (asset?.digest === undefined || asset.digest === null) throw new OfficeError(`${source.repo} ${version} has no uploaded ${name} with a digest`);

  return { version, digest: asset.digest };
}

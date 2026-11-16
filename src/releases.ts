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

const releaseSchema = v.object({
  tag_name: v.string(),
  /** The commit the release was made from (the release workflow passes the full SHA), or a branch. */
  target_commitish: v.string(),
  prerelease: v.boolean(),
  draft: v.boolean(),
  published_at: v.nullable(v.string()),
  assets: v.array(v.object({ name: v.string(), state: v.string(), digest: v.nullish(v.string()), browser_download_url: v.string() })),
});

export type Release = v.InferOutput<typeof releaseSchema>;

async function getJson(url: string, headers: Record<string, string>): Promise<{ status: number; body: string; link: string | null }> {
  let response;

  try {
    response = await fetch(url, { headers: { "user-agent": "office", ...headers }, signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new OfficeError(`couldn't reach ${new URL(url).host}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { status: response.status, body: await response.text(), link: response.headers.get("link") };
}

const githubHeaders = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };

/** A checked answer from GitHub's API, and the URL of its next page. */
type Answer<Value> = { value: Value; next: string | undefined };

/** A GET on GitHub's API without a login; undefined for a 404. */
async function github<Schema extends v.GenericSchema>(url: string, schema: Schema, what: string): Promise<Answer<v.InferOutput<Schema>> | undefined> {
  const { status, body, link } = await getJson(url, githubHeaders);

  if (status === 404) return undefined;

  if (status === 403 || status === 429) throw new OfficeError(`GitHub refused the request for ${what} (HTTP ${status}, probably its rate limit for requests without a login)`);

  if (status !== 200) throw new OfficeError(`GitHub answered HTTP ${status} for ${what}`);

  const result = check(v.safeParse(schema, JSON.parse(body)));

  if (!result.ok) throw new OfficeError(`GitHub's answer for ${what} has an unexpected shape: ${result.errors[0]}`);

  return { value: result.value, next: link?.match(/<([^>]+)>;\s*rel="next"/)?.[1] };
}

/**
 * A repository's releases, newest first, a hundred per page. One page is enough for every line the
 * office pins; `pages` follows GitHub's next links further.
 */
export async function releases(repo: string, pages = 1): Promise<Release[]> {
  return releasePages(`https://api.github.com/repos/${repo}/releases?per_page=100`, pages, repo);
}

/** Up to `pages` pages of a release list, starting at `url` and following each page's next link. */
export async function releasePages(url: string, pages: number, repo: string): Promise<Release[]> {
  const found: Release[] = [];
  let next: string | undefined = url;

  for (let page = 0; page < pages && next !== undefined; page++) {
    // Annotated because `next` feeds back into the call through the loop, which TypeScript can't infer.
    const answer: Answer<Release[]> | undefined = await github(next, v.array(releaseSchema), `${repo}'s releases`);

    if (answer === undefined) throw new OfficeError(`GitHub has no repository ${repo}`);

    found.push(...answer.value);
    next = answer.next;
  }

  return found;
}

/** The release of `repo` tagged `tag`, or undefined when there is none. */
export async function releaseByTag(repo: string, tag: string): Promise<Release | undefined> {
  return (await github(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, releaseSchema, `${repo}'s release ${tag}`))?.value;
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

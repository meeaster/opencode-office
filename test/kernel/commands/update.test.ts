// replaceExecutable against a local HTTP server standing in for a release's download URLs. The
// "executables" are shell scripts that print a version line, as `office --version` does.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Release, releasePages } from "../../../src/features/tools/releases.ts";
import { type Download, replaceExecutable, selectRelease } from "../../../src/commands/update.ts";

const tag = "0.1.0-20261116T163238Z";
const commit = "7bdbfe502109";
const original = "#!/bin/sh\necho 'office 0.1.0-20261101T000000Z (commit 000000000000)'\n";
const good = `#!/bin/sh\necho 'office ${tag} (commit ${commit})'\n`;
const failing = "#!/bin/sh\necho broken >&2\nexit 1\n";
const impostor = `#!/bin/sh\necho 'office ${tag} (commit ffffffffffff)'\n`;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const files = new Map([
  ["/good", good],
  ["/failing", failing],
  ["/impostor", impostor],
  ["/sums/good", `${sha256(good)}  office-test\n`],
  ["/sums/failing", `${sha256(failing)}  office-test\n`],
  ["/sums/impostor", `${sha256(impostor)}  office-test\n`],
  ["/sums/wrong", `${sha256("something else")}  office-test\n`],
  ["/sums/other", `${sha256(good)}  office-other\n`],
]);

const server = Bun.serve({
  port: 0,
  fetch: (request) => {
    const body = files.get(new URL(request.url).pathname);

    return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
  },
});

afterAll(() => server.stop(true));

let dir = "";
let executable = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-update-"));
  executable = join(dir, "office");
  writeFileSync(executable, original);
  chmodSync(executable, 0o755);
});

function download(binary: string, sums: string): Download {
  return { tag, commit, name: "office-test", binary: `${server.url}${binary.slice(1)}`, sums: `${server.url}${sums.slice(1)}` };
}

/** The original is still in place, byte for byte, and no download was left beside it. */
function expectUntouched(): void {
  expect(readFileSync(executable, "utf8")).toBe(original);
  expect(readdirSync(dir)).toEqual(["office"]);
}

test("replaces the executable with a verified release that reports its version and commit", async () => {
  await replaceExecutable(executable, download("/good", "/sums/good"));

  expect(readFileSync(executable, "utf8")).toBe(good);
  expect(readdirSync(dir)).toEqual(["office"]);
});

test("keeps the executable when the download doesn't match SHA256SUMS", async () => {
  await expect(replaceExecutable(executable, download("/good", "/sums/wrong"))).rejects.toThrow(/SHA256SUMS lists/);
  expectUntouched();
});

test("keeps the executable when SHA256SUMS doesn't list the file", async () => {
  await expect(replaceExecutable(executable, download("/good", "/sums/other"))).rejects.toThrow(/lists no office-test/);
  expectUntouched();
});

test("keeps the executable when the download doesn't run", async () => {
  await expect(replaceExecutable(executable, download("/failing", "/sums/failing"))).rejects.toThrow(/didn't run/);
  expectUntouched();
});

test("keeps the executable when the download reports another commit", async () => {
  await expect(replaceExecutable(executable, download("/impostor", "/sums/impostor"))).rejects.toThrow(/reports "office .* \(commit ffffffffffff\)"/);
  expectUntouched();
});

test("keeps the executable when the download is missing", async () => {
  await expect(replaceExecutable(executable, download("/missing", "/sums/good"))).rejects.toThrow(/HTTP 404/);
  expectUntouched();
});

test("refuses a folder it can't write to before downloading", async () => {
  chmodSync(dir, 0o555);

  try {
    await expect(replaceExecutable(executable, download("/good", "/sums/good"))).rejects.toThrow(/can't write to/);
    expect(readFileSync(executable, "utf8")).toBe(original);
  } finally {
    chmodSync(dir, 0o755);
  }
});

// Release selection, on GitHub-shaped release lists published relative to a fixed time.
const now = Date.parse("2026-11-20T00:00:00Z");
const machineAsset = `office-${process.platform}-${process.arch}`;
const releaseBuild = { version: "0.1.0-20261101T000000Z", commit: "000000000000", dirty: false };

function release(tag: string, hoursAgo: number, { assets = [machineAsset, "SHA256SUMS"], commit = "a".repeat(40), draft = false } = {}): Release {
  return {
    tag_name: tag,
    target_commitish: commit,
    prerelease: true,
    draft,
    published_at: new Date(now - hoursAgo * 3_600_000).toISOString(),
    assets: assets.map((name) => ({ name, state: "uploaded", digest: null, browser_download_url: `https://example.invalid/${tag}/${name}` })),
  };
}

const t1 = "0.1.0-20261117T000000Z";
const t2 = "0.1.0-20261118T000000Z";
const t3 = "0.1.0-20261119T220000Z";

test("skips a newer release without SHA256SUMS and takes the older complete one", () => {
  const selection = selectRelease([release(t3, 30, { assets: [machineAsset] }), release(t2, 48)], releaseBuild, "1d", now);

  expect(selection.chosen?.tag_name).toBe(t2);
  expect(selection.incomplete).toEqual([t3]);
});

test("takes the highest version old enough for the age, whatever the list order", () => {
  const listed = [release(t1, 72), release(t3, 2), release(t2, 48)];

  expect(selectRelease(listed, releaseBuild, "1d", now).chosen?.tag_name).toBe(t2);
  expect(selectRelease(listed, releaseBuild, "1d", now).tooNew).toEqual([t3]);
  expect(selectRelease(listed, releaseBuild, "1h", now).chosen?.tag_name).toBe(t3);
  expect(selectRelease(listed, releaseBuild, "1w", now)).toMatchObject({ chosen: undefined, tooNew: [t3, t2, t1] });
});

test("ignores drafts and tags that aren't office releases", () => {
  const listed = [release("v9.9.9", 100), release("0.1.0-20261119T000000Z", 100, { draft: true }), release(t1, 100)];

  expect(selectRelease(listed, releaseBuild, "1d", now).chosen?.tag_name).toBe(t1);
});

test("tells an unsupported machine apart from releases that can't be verified", () => {
  expect(() => selectRelease([release(t1, 48, { assets: ["office-plan9-mips", "SHA256SUMS"] })], releaseBuild, "1d", now)).toThrow(`no release of office publishes ${machineAsset}`);
  expect(() => selectRelease([release(t1, 48, { assets: [machineAsset] })], releaseBuild, "1d", now)).toThrow(/also publishes SHA256SUMS, so none can be verified/);
});

test("places a local build by the newest release of its commit, and leaves other local builds unplaced", () => {
  const shared = "b".repeat(40);
  const listed = [release(t1, 72, { commit: shared }), release(t2, 48, { commit: shared }), release(t3, 30)];

  expect(selectRelease(listed, { version: "0.1.0", commit: shared.slice(0, 12), dirty: false }, "1d", now).baseline).toBe(t2);
  expect(selectRelease(listed, { version: "0.1.0", commit: shared.slice(0, 12), dirty: true }, "1d", now).baseline).toBeUndefined();
  expect(selectRelease(listed, { version: "0.1.0", commit: "cccccccccccc", dirty: false }, "1d", now).baseline).toBeUndefined();
  expect(selectRelease(listed, releaseBuild, "1d", now).baseline).toBe(releaseBuild.version);
});

test("follows GitHub's next links, so an old enough release on a later page is found", async () => {
  const pages = Bun.serve({
    port: 0,
    fetch: (request) => {
      const page = new URL(request.url).searchParams.get("page") ?? "1";
      const body = page === "1" ? [release(t3, 2)] : [release(t2, 48)];
      const headers = page === "1" ? { link: `<${new URL("?page=2", request.url)}>; rel="next"` } : undefined;

      return Response.json(body, { headers });
    },
  });

  try {
    const first = `${pages.url}releases?page=1`;

    expect(selectRelease(await releasePages(first, 10, "test/office"), releaseBuild, "1d", now).chosen?.tag_name).toBe(t2);
    expect(selectRelease(await releasePages(first, 1, "test/office"), releaseBuild, "1d", now).chosen).toBeUndefined();
  } finally {
    pages.stop(true);
  }
});

test("revalidates every cached release page and still finds a changed release behind an unchanged first page", async () => {
  let later = t1;
  let unavailable = false;
  const responses: number[] = [];

  const pages = Bun.serve({
    port: 0,
    fetch(request) {
      const first = new URL(request.url).pathname === "/first";
      const tag = first ? t3 : later;
      const etag = `"${tag}"`;
      const status = unavailable ? 504 : request.headers.get("if-none-match") === etag ? 304 : 200;

      responses.push(status);

      if (status !== 200) return new Response(null, { status });

      const headers = new Headers({ etag });

      if (first) headers.set("link", `<${new URL("/second", request.url)}>; rel="next"`);

      return Response.json([release(tag, first ? 2 : 48)], { headers });
    },
  });

  const read = () => releasePages(`${pages.url}first`, 2, "test/office", dir);

  try {
    expect((await read()).map(r => r.tag_name)).toEqual([t3, t1]);
    later = t2;
    expect((await read()).map(r => r.tag_name)).toEqual([t3, t2]);
    expect((await read()).map(r => r.tag_name)).toEqual([t3, t2]);
    unavailable = true;
    await expect(read()).rejects.toThrow("HTTP 504");
    expect(responses).toEqual([200, 200, 304, 200, 304, 304, 504]);
  } finally {
    pages.stop(true);
  }
});

import { expect, test } from "bun:test";

import { pinFor, type Release, selectToolRelease } from "../releases.ts";

function release(tag: string, published: string, names: string[]): Release {
  return {
    tag_name: tag,
    target_commitish: "main",
    prerelease: false,
    draft: false,
    published_at: published,
    assets: names.map((name, index) => ({ name, state: "uploaded", digest: `sha256:${String(index).repeat(64)}`, browser_download_url: `https://example.invalid/${name}` })),
  };
}

const sfwAssets = ["sfw-free-linux-x86_64", "sfw-free-linux-arm64", "sfw-free-macos-x86_64", "sfw-free-macos-arm64", "sfw-free-windows-x86_64.exe"];

test("sfw's release lookup takes the newest v-tag old enough, and its pin holds each platform's digest", async () => {
  const listed = [release("v1.17.0", "2026-11-16T00:00:00Z", sfwAssets), release("v1.16.0", "2026-11-01T00:00:00Z", sfwAssets), release("nightly", "2026-11-02T00:00:00Z", sfwAssets)];
  const { chosen, tooNew, ignored } = selectToolRelease("sfw", listed, "3d", new Date("2026-11-17T00:00:00Z"));

  expect(chosen?.version).toBe("1.16.0");
  expect(tooNew).toEqual(["1.17.0"]);
  expect(ignored).toEqual(["nightly"]);

  const pin = await pinFor("sfw", "1.16.0", chosen?.release);

  expect(pin).toEqual({
    version: "1.16.0",
    digest: `sha256:${"0".repeat(64)}`,
    platforms: { "linux-x64": `sha256:${"0".repeat(64)}`, "linux-arm64": `sha256:${"1".repeat(64)}`, "darwin-x64": `sha256:${"2".repeat(64)}`, "darwin-arm64": `sha256:${"3".repeat(64)}` },
  });

  expect(pinFor("sfw", "1.16.0", release("v1.16.0", "2026-11-01T00:00:00Z", sfwAssets.slice(0, 3)))).rejects.toThrow("SocketDev/sfw-free 1.16.0 has no uploaded sfw-free-macos-arm64 with a digest");
});

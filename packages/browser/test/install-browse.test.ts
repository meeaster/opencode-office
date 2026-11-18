import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installBrowse, type Machine, parseManifest, targetFor } from "../scripts/install-browse.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "browse-install-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const linux: Machine = { platform: "linux", arch: "x64", avx2: true, musl: false, rosetta: false };

test("the target is the one the official installer picks", () => {
  expect(targetFor(linux)).toBe("linux-x64");
  expect(targetFor({ ...linux, avx2: false })).toBe("linux-x64-baseline");
  expect(targetFor({ ...linux, avx2: false, musl: true })).toBe("linux-x64-baseline-musl");
  expect(targetFor({ ...linux, arch: "arm64", avx2: false, musl: true })).toBe("linux-arm64-musl");
  expect(targetFor({ platform: "darwin", arch: "x64", avx2: false, musl: false, rosetta: true })).toBe("macos-arm64");
  expect(targetFor({ platform: "darwin", arch: "x64", avx2: true, musl: false, rosetta: false })).toBe("macos-x64");
  expect(() => targetFor({ ...linux, platform: "win32" })).toThrow("browse has no build for win32-x64");
});

/** A browse release whose linux-x64 build is a tarball holding package/bin/browse. */
function release(sha256?: string) {
  const staging = join(dir, "staging");

  mkdirSync(join(staging, "package/bin"), { recursive: true });
  writeFileSync(join(staging, "package/bin/browse"), "#!/bin/sh\necho browse 9.9.9\n");
  Bun.spawnSync(["tar", "-czf", join(dir, "browse.tgz"), "-C", staging, "package"]);

  const bytes = readFileSync(join(dir, "browse.tgz"));
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const url = `/release/browse/files/${digest}/opencode-browse-linux-x64-9.9.9.tgz`;
  const manifest = { schema: 1, app: "browse", artifact: "cli", channel: "stable", release: { version: "9.9.9", targets: { "linux-x64": { url, size: bytes.length, sha256: sha256 ?? digest } } } };

  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const path = new URL(request.url).pathname;

      if (path === "/release/browse/cli/stable.json") return Response.json(manifest);

      return path === url ? new Response(bytes) : new Response("not found", { status: 404 });
    },
  });
}

test("installs the verified binary into the home's .local/bin, executable", async () => {
  const server = release();
  const home = join(dir, "home");

  try {
    const installed = await installBrowse({ home, machine: linux, service: `http://127.0.0.1:${server.port}/release` });

    expect(installed).toEqual({ version: "9.9.9", path: join(home, ".local/bin/browse") });
    expect(readFileSync(installed.path, "utf8")).toContain("browse 9.9.9");
    expect(statSync(installed.path).mode & 0o777).toBe(0o755);
    expect(existsSync(`${installed.path}.new`)).toBe(false);
  } finally {
    await server.stop();
  }
});

test("a download that doesn't match the manifest's SHA-256 installs nothing", async () => {
  const server = release("0".repeat(64));
  const home = join(dir, "home");

  try {
    expect(installBrowse({ home, machine: linux, service: `http://127.0.0.1:${server.port}/release` })).rejects.toThrow(`not the manifest's ${"0".repeat(64)}; nothing was installed`);
  } finally {
    await server.stop();
  }

  expect(existsSync(join(home, ".local/bin/browse"))).toBe(false);
});

test("a manifest of another shape is refused, naming what's wrong", () => {
  expect(() => parseManifest({ app: "browse", artifact: "cli", channel: "dev" }, "linux-x64")).toThrow("isn't the stable channel");
  expect(() => parseManifest({ app: "browse", artifact: "cli", channel: "stable", release: { version: "1.0.0", targets: {} } }, "linux-x64")).toThrow("has no build for linux-x64");
  expect(() =>
    parseManifest({ app: "browse", artifact: "cli", channel: "stable", release: { version: "1.0.0", targets: { "linux-x64": { url: "https://elsewhere.example/x.tgz", size: 1, sha256: "a".repeat(64) } } } }, "linux-x64"),
  ).toThrow("isn't a file on the release service");
});

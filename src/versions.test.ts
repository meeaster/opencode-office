import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ageFor } from "./commands/upgrade.ts";
import { migrate } from "./migrate.ts";
import { loadOffice } from "./office.ts";
import { pinFor, type Release, selectToolRelease } from "./releases.ts";
import { defaultPins, lockLacksSfw, readLock, wantedPins, writeLock } from "./versions.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-versions-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const fourPins = `opencode: ${defaultPins.opencode.version}
claude: ${defaultPins.claude.version}
executor: ${defaultPins.executor.version}
mise: ${defaultPins.mise.version}`;

/** office.lock as releases before sfw wrote it. */
const oldLock = (["opencode", "claude", "executor", "mise"] as const).map((tool) => `${tool}:\n  version: ${defaultPins[tool].version}\n  digest: ${defaultPins[tool].digest}\n`).join("");

function oldOffice(): void {
  writeFileSync(join(dir, "office.yaml"), `name: old\n# The versions.\nversions:\n${fourPins.replace(/^/gm, "  ")}\n# After the versions.\nupgrades:\n  minimum_release_age: 1d\n`);
  writeFileSync(join(dir, "office.lock"), oldLock);
}

test("an office from before sfw was pinned runs the tool's default sfw, and one sync pins it in office.yaml and office.lock", () => {
  oldOffice();

  const office = loadOffice(dir);

  expect(lockLacksSfw(dir)).toBe(true);
  expect(wantedPins(office).sfw).toEqual(defaultPins.sfw);

  const first = migrate(office);

  expect(first.changes).toEqual([
    `pinned sfw ${defaultPins.sfw.version} (Socket Firewall) in office.yaml's versions, the tool's default, which the office ran without a pin`,
    `added sfw ${defaultPins.sfw.version} to office.lock, with the SHA-256 of each platform's release file`,
  ]);

  const yaml = readFileSync(join(dir, "office.yaml"), "utf8");

  expect(yaml).toContain(`  mise: ${defaultPins.mise.version}\n  sfw: ${defaultPins.sfw.version}\n# After the versions.`);
  expect(lockLacksSfw(dir)).toBe(false);
  expect(readLock(dir)?.sfw).toEqual(defaultPins.sfw);
  expect(readFileSync(join(dir, "office.lock"), "utf8")).toContain(`  platforms:\n    linux-x64: ${defaultPins.sfw.platforms?.["linux-x64"]}\n`);
  expect(migrate(first.office).changes).toEqual([]);
});

test("an office.yaml that pins another sfw than an old lock holds asks for office pin, and migration leaves the lock", () => {
  oldOffice();
  writeFileSync(join(dir, "office.yaml"), `name: old\nversions:\n${fourPins.replace(/^/gm, "  ")}\n  sfw: 1.15.6\n`);

  const office = loadOffice(dir);

  expect(office.tools.runtimes.sfw.version).toBe("1.15.6");
  expect(() => wantedPins(office)).toThrow("office.lock doesn't match office.yaml for sfw (1.16.0, office.yaml 1.15.6): run office pin");
  expect(migrate(office).changes).toEqual([]);
  expect(lockLacksSfw(dir)).toBe(true);
});

test("a lock round-trips sfw's platform digests", () => {
  writeLock(dir, defaultPins);

  expect(readLock(dir)).toEqual(defaultPins);
});

test("Socket Firewall is on unless sfw's enabled, or socket_firewall before tools, turns it off", () => {
  writeFileSync(join(dir, "office.yaml"), "name: firewall\n");
  expect(loadOffice(dir).socketFirewall).toBe(true);

  writeFileSync(join(dir, "office.yaml"), "name: firewall\ntools:\n  sfw: { version: 1.16.0, enabled: false }\n");
  expect(loadOffice(dir).socketFirewall).toBe(false);

  writeFileSync(join(dir, "office.yaml"), "name: firewall\ntools:\n  sfw:\n    enabled: true\n");
  expect(loadOffice(dir).socketFirewall).toBe(true);

  writeFileSync(join(dir, "office.yaml"), "name: firewall\nsocket_firewall: false\n");
  expect(loadOffice(dir).socketFirewall).toBe(false);

  writeFileSync(join(dir, "office.yaml"), "name: firewall\nsocket_firewall: off-ish\n");
  expect(() => loadOffice(dir)).toThrow("socket_firewall: must be true or false");

  writeFileSync(join(dir, "office.yaml"), "name: firewall\ntools:\n  sfw: { enabled: off-ish }\n");
  expect(() => loadOffice(dir)).toThrow("tools.sfw.enabled: must be true or false");
});

test("upgrade-tools waits a runtime's own age, else the office's, and the office's for every mise tool", () => {
  writeFileSync(join(dir, "office.yaml"), "name: ages\n");
  expect(ageFor(loadOffice(dir))).toBe("3d");
  expect(ageFor(loadOffice(dir), "sfw")).toBe("3d");

  writeFileSync(join(dir, "office.yaml"), "name: ages\ntools:\n  minimum_release_age: 1d\n  opencode: { version: 2.3.2, minimum_release_age: 0d }\n  executor:\n    version: 2.0.0-beta.49\n    minimum_release_age: 7d\n  claude: 2.1.327\n");

  const office = loadOffice(dir);

  expect(ageFor(office)).toBe("1d");
  expect(ageFor(office, "opencode")).toBe("0d");
  expect(ageFor(office, "executor")).toBe("7d");
  expect(ageFor(office, "claude")).toBe("1d");
  expect(ageFor(office, "sfw")).toBe("1d");

  // Before tools: upgrades' default is every runtime's, sfw's too, but mise tools wait three days.
  writeFileSync(join(dir, "office.yaml"), "name: ages\nupgrades:\n  minimum_release_age: 1d\n  sfw: 12h\n  npm:wrangler: 2d\n");

  const old = loadOffice(dir);

  expect(ageFor(old)).toBe("3d");
  expect(ageFor(old, "mise")).toBe("1d");
  expect(ageFor(old, "sfw")).toBe("12h");
  expect(old.tools.ignoredAges).toEqual(["npm:wrangler"]);
});

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

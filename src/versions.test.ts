import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ageFor } from "./commands/upgrade.ts";
import { loadOffice } from "./office.ts";
import { pinFor, type Release, selectToolRelease } from "./releases.ts";
import { openCheckoutLease, publicationLease } from "./checkout-lease.ts";
import type { SeedReceipt } from "./schema.ts";
import { defaultPins, editLock, readLock, readLockSection, wantedPins, writeLock } from "./versions.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-versions-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const notes = { repo: "https://example.com/acme/office-packages.git", path: "notes", ref: "v1.2.0", commit: "0123456789abcdef0123456789abcdef01234567" };
const agenda = { repo: "https://example.com/acme/agenda.git", path: "pkg", ref: "1.0", commit: "1".repeat(40) };
const sha256 = "9f".repeat(32);

/** Sets office.lock's `packages:` section, as a publication does. */
function setPackages(entries: Record<string, typeof notes>) {
  editLock(dir, (sections) => {
    sections.packages = new Map(Object.entries(entries));
  });
}

/** Sets office.lock's `seeds:` section, as the seed step does. */
function setSeeds(entries: Record<string, SeedReceipt>) {
  editLock(dir, (sections) => {
    sections.seeds = new Map(Object.entries(entries));
  });
}

test("office.lock reads with runtime pins only (round-tripping sfw's platform digests), Git packages only, or both, and rejects a short commit", () => {
  writeLock(dir, defaultPins);
  expect(readLockSection(dir, "packages")).toEqual(new Map());

  rmSync(join(dir, "office.lock"));
  setPackages({ notes });
  expect(readLock(dir)).toBeUndefined();
  expect(readLockSection(dir, "packages")).toEqual(new Map([["notes", notes]]));
  writeFileSync(join(dir, "office.yaml"), `name: t\ntools:\n  opencode: ${defaultPins.opencode.version}\n`);
  expect(() => wantedPins(loadOffice(dir))).toThrow("office.yaml pins versions but office.lock holds no runtime pins: run office pin");

  writeLock(dir, defaultPins);
  expect(readLock(dir)).toEqual(defaultPins);
  expect(readLockSection(dir, "packages")).toEqual(new Map([["notes", notes]]));

  writeFileSync(join(dir, "office.lock"), readFileSync(join(dir, "office.lock"), "utf8").replace(notes.commit, "abcdef0"));
  expect(() => readLockSection(dir, "packages")).toThrow("office.lock is not valid (restore it from Git, or remove its packages: section for office sync to rewrite):\n  packages.notes.commit: must be a full 40-character commit SHA");
});

test("each writer of office.lock leaves the other sections byte-identical, sorted by key, and an unchanged edit leaves the file alone", () => {
  const lock = join(dir, "office.lock");
  const text = () => readFileSync(lock, "utf8");
  const part = (from: string) => text().slice(text().indexOf(from));

  const writers = {
    runtime: () => writeLock(dir, { ...defaultPins, mise: { ...defaultPins.mise, version: "2026.12.1" } }),
    packages: () => setPackages({ notes: { ...notes, ref: "v1.3.0" } }),
    seeds: () => setSeeds({ "notes.md": { package: "notes", existing: true } }),
  };

  writeLock(dir, defaultPins);
  setPackages({ notes, agenda });
  setSeeds({ "tracks/AGENTS.md": { package: "tracks", existing: true }, "initiatives/AGENTS.md": { package: "openspec", sha256 }, "---": { package: "odd", existing: true } });

  // Packages sorted by name, a ref that reads as a number stays a string; one receipt per line.
  expect(part("packages:").indexOf("agenda:")).toBeLessThan(part("packages:").indexOf("notes:"));
  expect(readLockSection(dir, "packages").get("agenda")?.ref).toBe("1.0");
  expect(part("seeds:")).toBe(`seeds:\n  ---: { package: odd, existing: true }\n  initiatives/AGENTS.md: { package: openspec, sha256: ${sha256} }\n  tracks/AGENTS.md: { package: tracks, existing: true }\n`);

  const sections = () => {
    const [runtime, packages, seeds] = text().split("\n\n");

    return { runtime, packages, seeds };
  };

  for (const key of ["runtime", "packages", "seeds"] as const) {
    const before = sections();

    writers[key]();
    const after = sections();

    expect(after).toEqual({ ...before, [key]: after[key] });
    expect(after[key]).not.toBe(before[key]);
  }

  const settled = text();

  editLock(dir, () => {});
  expect(text()).toBe(settled);

  // No packages drops the section, and a lock with no section goes.
  setPackages({});
  expect(text()).not.toContain("packages:");
  rmSync(lock);
  setPackages({ notes });
  setPackages({});
  expect(existsSync(lock)).toBe(false);
});

test("each section of office.lock reads on its own, and a writer refuses, before its edit runs, to rewrite a section it can't read", () => {
  const lock = join(dir, "office.lock");
  const packagesFix = "office.lock is not valid (restore it from Git, or remove its packages: section for office sync to rewrite)";
  const seedsFix = "office.lock is not valid (restore it from Git: without its seeds: section, sync would copy again every seed file the office deleted)";

  writeLock(dir, defaultPins);
  setPackages({ notes });
  setSeeds({ "tracks/AGENTS.md": { package: "tracks", existing: true } });
  const valid = readFileSync(lock, "utf8");
  let edited = false;

  const edit = () => editLock(dir, () => {
    edited = true;
  });

  // A bad runtime section: the others still read, office pin rewrites it, and other writers refuse.
  writeFileSync(lock, valid.replace(`  version: ${defaultPins.mise.version}`, "  version: latest"));
  expect(() => readLock(dir)).toThrow("office.lock is not valid (run office pin to rewrite it)");
  expect(readLockSection(dir, "packages")).toEqual(new Map([["notes", notes]]));
  expect(() => edit()).toThrow("office.lock is not valid (run office pin to rewrite it)");
  writeLock(dir, defaultPins);
  expect(readFileSync(lock, "utf8")).toBe(valid);

  // A bad packages: section: the runtime pins still read, and office pin refuses rather than drop the section.
  writeFileSync(lock, valid.replace(notes.commit, "abcdef0"));
  expect(readLock(dir)).toEqual(defaultPins);
  expect(() => writeLock(dir, defaultPins)).toThrow(packagesFix);
  expect(() => edit()).toThrow(packagesFix);

  // A bad receipt, or a path outside the office.
  writeFileSync(lock, valid.replace("tracks, existing: true", "tracks, existing: maybe"));
  expect(() => readLockSection(dir, "seeds")).toThrow(`${seedsFix}:\n  seeds.tracks/AGENTS.md: must be`);
  expect(readLockSection(dir, "packages")).toEqual(new Map([["notes", notes]]));
  expect(() => writeLock(dir, defaultPins)).toThrow(seedsFix);
  writeFileSync(lock, valid.replace("tracks/AGENTS.md", "../escape.md"));
  expect(() => readLockSection(dir, "seeds")).toThrow("seeds.../escape.md: must be a path relative to the office");
  expect(edited).toBe(false);
});

test("a package or seed path named like an Object property round-trips through office.lock", () => {
  setPackages({ constructor: notes, prototype: agenda });
  editLock(dir, (sections) => {
    sections.seeds = new Map<string, SeedReceipt>([["constructor", { package: "knowledge", existing: true }], ["__proto__", { package: "odd", sha256 }]]);
  });

  expect([...readLockSection(dir, "packages").keys()]).toEqual(["constructor", "prototype"]);
  expect(readLockSection(dir, "seeds")).toEqual(new Map<string, SeedReceipt>([["__proto__", { package: "odd", sha256 }], ["constructor", { package: "knowledge", existing: true }]]));
  expect(readLockSection(dir, "seeds").get("toString")).toBeUndefined();
});

test("office.lock writers hold the publication lease, so a busy lease changes nothing and runs no edit", () => {
  const busy = "another office command is changing packages or office.lock; retry when it finishes";
  let edited = false;

  writeLock(dir, defaultPins);
  const lock = readFileSync(join(dir, "office.lock"), "utf8");

  {
    using lease = openCheckoutLease(dir, publicationLease);
    lease.acquire();

    expect(() => writeLock(dir, { ...defaultPins, mise: { ...defaultPins.mise, version: "2026.12.1" } })).toThrow(busy);
    expect(() => editLock(dir, () => {
      edited = true;
    })).toThrow(busy);
    expect(readFileSync(join(dir, "office.lock"), "utf8")).toBe(lock);
    expect(edited).toBe(false);
  }
});

test("Socket Firewall is on unless sfw's enabled turns it off", () => {
  writeFileSync(join(dir, "office.yaml"), "name: firewall\n");
  expect(loadOffice(dir).socketFirewall).toBe(true);

  writeFileSync(join(dir, "office.yaml"), "name: firewall\ntools:\n  sfw: { version: 1.16.0, enabled: false }\n");
  expect(loadOffice(dir).socketFirewall).toBe(false);

  writeFileSync(join(dir, "office.yaml"), "name: firewall\ntools:\n  sfw:\n    enabled: true\n");
  expect(loadOffice(dir).socketFirewall).toBe(true);

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

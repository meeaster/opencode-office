import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clonePluginStreamed, existingPluginDestination, git, PluginCheckoutProblem } from "./git.ts";
import { renameNoReplace } from "./no-replace.ts";

// Owner races at exact steps of first delivery, through the rename seam instead of timing.
let root: string, remote: string, office: string, dir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "office-plugin-publication-"));
  remote = join(root, "remote");
  office = join(root, "office");
  dir = join(office, ".opencode/plugins/demo");
  mkdirSync(remote);
  mkdirSync(office);
  writeFileSync(join(remote, "index.js"), "export default {id: \"demo\"}\n");
  git(["init", "--quiet", remote]);
  git(["add", "."], remote);
  git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--quiet", "-m", "plugin"], remote);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const staging = () => readdirSync(office).filter(name => name.startsWith(".office-plugin-"));
const ownerFile = (path: string) => writeFileSync(path, "owner\n", { flag: "wx" });

/** A no-replace rename that runs `before` and `after` around the first rename `matches` picks. */
function racing(matches: (from: string, to: string) => boolean, before: () => void, after = () => {}) {
  let raced = false;

  return (from: string, to: string) => {
    if (raced || !matches(from, to)) return renameNoReplace(from, to);
    raced = true;
    before();

    try {
      renameNoReplace(from, to);
    } finally {
      after();
    }
  };
}

const releasing = (from: string, to: string) => from === dir && to.endsWith("/released");

test("first delivery publishes the checkout and leaves no staging", async () => {
  expect(await clonePluginStreamed(remote, undefined, dir, office, () => {})).toBe("cloned");
  expect(readdirSync(dir).sort()).toEqual([".git", "index.js"]);
  expect(git(["config", "--get", "remote.origin.url"], dir)).toBe(remote);
  expect(staging()).toEqual([]);
});

test("an owner folder that takes the destination before the claim gets no .git written into it", async () => {
  const rename = racing((from, to) => from.endsWith("/claim") && to === dir, () => {
    mkdirSync(dir);
    ownerFile(join(dir, "owner.txt"));
  });

  await expect(clonePluginStreamed(remote, undefined, dir, office, () => {}, rename)).rejects.toThrow(existingPluginDestination);
  expect(readdirSync(dir)).toEqual(["owner.txt"]);
  expect(staging()).toEqual([]);
});

test("a file that takes the vacated destination before publication is kept and reported as an existing entry", async () => {
  const rename = racing((from, to) => from.endsWith("/tree") && to === dir, () => ownerFile(dir));

  await expect(clonePluginStreamed(remote, undefined, dir, office, () => {}, rename)).rejects.toThrow(existingPluginDestination);
  expect(readFileSync(dir, "utf8")).toBe("owner\n");
  expect(staging()).toEqual([]);
});

test("owner content in the claim stays at the destination when it can be put back", async () => {
  const rename = racing(releasing, () => ownerFile(join(dir, "owner.txt")));

  await expect(clonePluginStreamed(remote, undefined, dir, office, () => {}, rename)).rejects.toThrow("kept what appeared there and published nothing");
  expect(readdirSync(dir)).toEqual(["owner.txt"]);
  expect(staging()).toEqual([]);
});

// The review's double race: owner content enters the claim, then a file takes the vacated
// destination, so the claim cannot go back. Its content must survive, and the message must say where.
for (const [stage, failure] of [["publication", undefined], ["cleanup after a failure", "verification failed"]] as const) {
  test(`owner content that cannot be put back during ${stage} is kept in staging and named`, async () => {
    const rename = racing(releasing, () => ownerFile(join(dir, "owner.txt")), () => ownerFile(dir));
    let verified = false;

    const verify = () => {
      if (failure && !verified) {
        verified = true;
        throw new PluginCheckoutProblem(failure);
      }
    };

    const delivery = clonePluginStreamed(remote, undefined, dir, office, verify, rename);

    await expect(delivery).rejects.toBeInstanceOf(PluginCheckoutProblem);
    const [work] = staging();

    await expect(delivery).rejects.toThrow(`an entry that appeared at ${dir} during delivery is kept at ${join(office, work, "released")}; move it back yourself`);
    expect(readdirSync(join(office, work))).toEqual(["released"]);
    expect(readdirSync(join(office, work, "released"))).toEqual(["owner.txt"]);
    expect(readFileSync(join(office, work, "released/owner.txt"), "utf8")).toBe("owner\n");
    expect(lstatSync(dir).isFile()).toBe(true);
    expect(existsSync(join(office, work, "tree"))).toBe(false);
  });
}

// The owner deletes the claim and recreates the destination. A freed inode number is reused by
// the next entry created (ext4 does so at once), so the owner's entries can carry the claim's
// device and inode. The Git variants keep Office's very inodes, emptied and refilled, so they
// match on any filesystem; the folder and file variants rely on the filesystem reusing inodes.
const metadata = () => join(dir, ".git");

function refill(fill: () => void) {
  const before = [lstatSync(dir).ino, lstatSync(metadata()).ino];

  for (const name of readdirSync(metadata())) rmSync(join(metadata(), name), { recursive: true });
  fill();
  writeFileSync(join(metadata(), "owner-note"), "owner\n");
  expect([lstatSync(dir).ino, lstatSync(metadata()).ino]).toEqual(before);
}

const ownerRepo = () => refill(() => git(["init", "--quiet", dir]));

const ownerClone = () => refill(() => {
  const copy = join(root, "owner-clone");

  git(["clone", "--quiet", remote, copy]);
  cpSync(join(copy, ".git"), metadata(), { recursive: true });
  cpSync(join(copy, "index.js"), join(dir, "index.js"));
  rmSync(copy, { recursive: true });
});

const recreate = (make: () => void) => () => {
  rmSync(dir, { recursive: true });
  make();
};

const withdrawing = (from: string) => from === dir || from === metadata();
const changed = "plugin destination changed during delivery; kept what appeared there and published nothing";

const replacements = [
  { owner: "a Git repository", at: withdrawing, replace: ownerRepo, kept: () => {
    expect(readdirSync(dir)).toEqual([".git"]);
    expect(readFileSync(join(metadata(), "owner-note"), "utf8")).toBe("owner\n");
    expect(existsSync(join(metadata(), "HEAD"))).toBe(true);
  } },
  { owner: "a clone with the declared origin", at: withdrawing, replace: ownerClone, kept: () => {
    expect(readdirSync(dir).sort()).toEqual([".git", "index.js"]);
    expect(readFileSync(join(metadata(), "owner-note"), "utf8")).toBe("owner\n");
    expect(git(["config", "--get", "remote.origin.url"], dir)).toBe(remote);
  } },
  { owner: "an empty folder", at: releasing, replace: recreate(() => mkdirSync(dir)), kept: () => {
    expect(lstatSync(dir).isDirectory()).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  } },
  { owner: "a file", at: releasing, replace: recreate(() => ownerFile(dir)), kept: () => expect(readFileSync(dir, "utf8")).toBe("owner\n") },
];

for (const { owner, at, replace, kept } of replacements) {
  for (const failure of [undefined, "verification failed"]) {
    test(`${owner} that recreates the destination ${failure ? "before cleanup" : "before publication"} is never deleted or published over`, async () => {
      let verified = false;

      const verify = () => {
        if (failure && !verified) {
          verified = true;
          throw new PluginCheckoutProblem(failure);
        }
      };

      await expect(clonePluginStreamed(remote, undefined, dir, office, verify, racing(at, replace))).rejects.toThrow(failure ?? changed);
      kept();
      expect(staging()).toEqual([]);
    });
  }
}

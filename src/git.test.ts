import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sync } from "./commands/sync.ts";
import { git } from "./git.ts";
import { loadOffice } from "./office.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-git-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("sync refreshes a reference that is its own clone, and refuses a plain folder at a clone path instead of running git in the office", async () => {
  const office = join(dir, "office");
  const upstream = join(dir, "upstream");

  const commit = (message: string) => {
    writeFileSync(join(upstream, "notes.md"), `${message}\n`);
    git(["add", "-A"], upstream);
    git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", message], upstream);
  };

  mkdirSync(upstream);
  git(["init", "--quiet", upstream]);
  commit("one");
  mkdirSync(office);
  writeFileSync(join(office, "office.yaml"), `name: t\nreferences:\n  - { name: up, url: ${upstream} }\n  - { name: plain, url: ${upstream} }\n`);
  git(["init", "--quiet", office]);
  mkdirSync(join(office, "references/plain"), { recursive: true });
  writeFileSync(join(office, "references/plain/keep.md"), "not a clone\n");

  const first = await sync(loadOffice(office), { referencesOnly: true });

  expect(first).toContain("cloned reference references/up");
  expect(first).toContain(`FAILED reference references/plain: ${join(office, "references/plain")} holds a folder that isn't a repository of its own (no .git), not a clone; move it away so office sync can clone there`);

  commit("two");

  expect(await sync(loadOffice(office), { referencesOnly: true })).toContain("updated reference references/up");
});

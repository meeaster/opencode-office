import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { unshareable } from "./github.ts";
import { loadOffice, updateConfig } from "./office.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-github-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("office.yaml edits change only the fields they set, and an invalid value is never written", () => {
  const text = "# The office.\nname: demo # its name\n\nskills:\n  enabled: [office]\n  copied: []\n\n# Plugins.\nplugins: []\n";

  writeFileSync(join(dir, "office.yaml"), text);

  const office = updateConfig(loadOffice(dir), [[["git", "name"], "Demo: Person"], [["git", "email"], "demo@example.com"]]);

  expect(office.git).toEqual({ name: "Demo: Person", email: "demo@example.com" });
  expect(readFileSync(join(dir, "office.yaml"), "utf8")).toBe(`${text}git:\n  name: "Demo: Person"\n  email: demo@example.com\n`);

  writeFileSync(join(dir, "office.yaml"), `${text}git:\n  name: "Demo: Person"\n  email: demo@example.com # who commits\n`);
  updateConfig(office, [[["git", "credentials"], "gh"], [["git", "email"], "other@example.com"]]);
  expect(readFileSync(join(dir, "office.yaml"), "utf8")).toBe(`${text}git:\n  name: "Demo: Person"\n  email: other@example.com # who commits\n  credentials: gh\n`);

  const saved = readFileSync(join(dir, "office.yaml"), "utf8");

  expect(() => updateConfig(office, [[["git", "email"], "not an email"]])).toThrow("git.email");
  expect(readFileSync(join(dir, "office.yaml"), "utf8")).toBe(saved);
});

test("only a non-expiring login stored in gh's hosts.yml is shared with the container", () => {
  const file = { state: "success", account: "someone", tokenSource: "/home/someone/.config/gh/hosts.yml", refreshable: false };

  expect(unshareable(file)).toBeUndefined();
  expect(unshareable({ ...file, tokenSource: "keyring" })).toContain("keyring");
  expect(unshareable({ ...file, tokenSource: "GH_TOKEN" })).toContain("GH_TOKEN");
  expect(unshareable({ ...file, refreshable: true })).toContain("rotates");
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { sync } from "./commands/sync.ts";
import { git } from "./git.ts";
import { loadOffice } from "./office.ts";
import { settingsEnv } from "./package-services.ts";
import { fetchPackage, installPackage, readPackage, resolvePackages } from "./packages.ts";
import { recordRequiredBuiltins } from "./test-builtin-record.ts";
import { readLockSection } from "./versions.ts";
import { definitionText, settingsSchema, writePackage } from "./test-package.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-packages-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** The seed receipts in the office at `office`, as an object. */
function receipts(office: string) {
  return Object.fromEntries(readLockSection(office, "seeds"));
}

/** The office's package named `name`, read with its settings. */
function read(office: string, name: string) {
  const loaded = loadOffice(office);
  const resolved = resolvePackages(loaded).packages.find((item) => item.entry.name === name);

  if (resolved === undefined) throw new Error(`no package ${name}`);

  return { loaded, result: readPackage(loaded, resolved) };
}

/** What a fresh clone has of `.office/`: the committed seed store, and none of the rest. */
function freshClone(office: string): void {
  for (const entry of existsSync(join(office, ".office")) ? readdirSync(join(office, ".office")) : []) if (entry !== "seeds") rmSync(join(office, ".office", entry), { recursive: true, force: true });
}

/** Each stored seed's name and bytes. */
function storedSeeds(office: string): Record<string, string> {
  const store = join(office, ".office/seeds");

  return Object.fromEntries(readdirSync(store).map((name) => [name, readFileSync(join(store, name), "utf8")]));
}

const manifest = "settings: {type: object, additionalProperties: false, properties: {url: {type: string}, title: {type: string, default: Shared}}, required: [url]}\n";

test("settings are one JSON Schema, checked with its defaults applied: types, unknown and required settings, nested $defs, and none when undeclared", () => {
  const path = join(dir, "packages/demo/package.yaml");
  const config = (settings: string) => write(join(dir, "office.yaml"), `name: t\npackages:\n  - name: demo\n    settings: ${settings}\n`);

  const errors = (settings: string) => {
    config(settings);
    const { result } = read(dir, "demo");

    return result.ok ? [] : result.errors;
  };

  const nested = `settings:
  type: object
  additionalProperties: false
  properties:
    port: { type: integer, default: 4566 }
    enabled: { type: boolean, default: true }
    roles:
      type: object
      properties:
        review: { type: array, items: { $ref: '#/$defs/model' } }
  $defs:
    model: { enum: [fast, deep] }
`;

  writePackage(path, nested);
  config("{ port: 4600, roles: { review: [fast, deep] } }");

  const { loaded, result } = read(dir, "demo");

  if (!result.ok) throw new Error(result.errors.join("\n"));

  installPackage(loaded, result.value);
  expect(JSON.parse(readFileSync(join(dir, "packages/demo/.settings.json"), "utf8"))).toEqual({ port: 4600, enabled: true, roles: { review: ["fast", "deep"] } });
  // Lists and objects don't reach a compose file.
  expect(settingsEnv(result.value)).toBe("DEMO_PORT='4600'\nDEMO_ENABLED='true'\n");
  expect(errors("{ roles: { review: [other] } }")).toEqual(["packages.demo.settings.roles.review.0: must be equal to one of the allowed values"]);
  // A quoted port is text, not an integer.
  expect(errors('{ port: "4600" }')).toEqual(["packages.demo.settings.port: must be integer"]);
  expect(errors("{ colour: blue }")).toEqual(["packages.demo.settings.colour: the package declares no such setting; remove it from office.yaml"]);

  writePackage(path, manifest);
  expect(errors("{}")).toEqual(["packages.demo.settings.url: is required; add it to office.yaml"]);
  expect(errors("{ url: https://example.com/site }")).toEqual([]);
  expect(read(dir, "demo").result).toMatchObject({ ok: true, value: { settings: { url: "https://example.com/site", title: "Shared" } } });

  // A package that declares no settings accepts none.
  writePackage(path, "{}\n");
  expect(errors("{ label: x }")).toEqual(["packages.demo.settings.label: the package declares no such setting; remove it from office.yaml"]);

  // The root is an object schema; a removed key is an unknown one; an invalid schema names the file.
  const root = 'its root must have type: "object"';

  writePackage(path, "settings: { type: array }\n");
  expect(errors("{}")).toEqual([`packages/demo/package.yaml: settings: ${root}`]);
  writePackage(path, "settings: { $ref: '#/$defs/all' }\n");
  expect(errors("{}")).toEqual([`packages/demo/package.yaml: settings: ${root}`]);
  // Settings that aren't a mapping are a settings problem too, reported before a check of the package's folder.
  writePackage(path, "settings: null\nhost: {services: {svc: {description: Service, script: missing.sh}}}\n");
  expect(read(dir, "demo").result).toMatchObject({ ok: false, errors: ["packages/demo/package.yaml: settings: must be a JSON Schema object"], settings: ["packages/demo/package.yaml: settings: must be a JSON Schema object"] });
  writePackage(path, "settings_schema: { type: object }\n");
  expect(errors("{}")).toEqual([expect.stringMatching(/^packages\/demo\/package\.yaml: settings_schema: must be a mapping of /)]);
  writePackage(path, nested.replace("type: boolean", "type: invalid"));
  expect(errors("{}")).toEqual([expect.stringContaining("packages/demo/package.yaml: settings: schema is invalid")]);
});

test("two packages' schemas with the same $id each validate, with their own $refs and defaults", () => {
  const schema = (type: string, value: string) => `settings: {$id: "https://example.com/settings", type: object, additionalProperties: false, properties: {size: {$ref: "#/$defs/size"}, label: {type: string, default: ${value}}}, $defs: {size: {type: ${type}}}}\n`;

  writePackage(join(dir, "packages/one/package.yaml"), schema("integer", "one"));
  writePackage(join(dir, "packages/two/package.yaml"), schema("string", "two"));
  write(join(dir, "office.yaml"), "name: t\npackages:\n  - name: one\n    settings: {size: 3}\n  - name: two\n    settings: {size: large}\n");

  expect(read(dir, "one").result).toMatchObject({ ok: true, value: { settings: { size: 3, label: "one" } } });
  expect(read(dir, "two").result).toMatchObject({ ok: true, value: { settings: { size: "large", label: "two" } } });
  write(join(dir, "office.yaml"), "name: t\npackages:\n  - name: one\n    settings: {size: large}\n  - name: two\n    settings: {size: 3}\n");
  expect(read(dir, "one").result).toMatchObject({ ok: false, errors: ["packages.one.settings.size: must be integer"] });
  expect(read(dir, "two").result).toMatchObject({ ok: false, errors: ["packages.two.settings.size: must be string"] });
});

test("an install ignores the source office's records, an update by full commit SHA replaces the package, an edited copy is restored, and seed copies are left alone", async () => {
  const repo = join(dir, "repo");
  const office = join(dir, "office");

  const commit = (message: string) => {
    git(["add", "-A"], repo);
    git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", message], repo);

    return git(["rev-parse", "HEAD"], repo);
  };

  writePackage(join(repo, "pkgs/demo/package.yaml"), manifest);
  write(join(repo, "pkgs/demo/scripts/run.sh"), "echo one\n");
  write(join(repo, "pkgs/demo/seed/out/AGENTS.md"), "from the package\n");
  // Committed by the office that authored the package, as when sharing from its packages/.
  write(join(repo, "pkgs/demo/.template.json"), '["out/AGENTS.md"]\n');
  write(join(repo, "pkgs/demo/.settings.json"), '{"url":"https://example.com","title":"Shared"}\n');
  git(["init", "--quiet", repo]);

  const first = commit("one");

  write(join(repo, "pkgs/demo/scripts/run.sh"), "echo two\n");
  // Copying evaluates nothing: the replacement's module definition loads when admission gathers.
  rmSync(join(repo, "pkgs/demo/package.yaml"));
  writePackage(join(repo, "pkgs/demo/office.ts"), definitionText(`{settings:${settingsSchema({ title: "Shared" }, { url: "string" })}}`));

  const second = commit("two");
  const entry = (ref: string) => `name: t\npackages:\n  - name: demo\n    repo: ${repo}\n    path: pkgs/demo\n    ref: ${ref}\n    settings: { url: https://example.com }\n`;

  write(join(office, "office.yaml"), entry(first));

  const loaded = loadOffice(office);
  const script = join(office, ".office/packages/demo/scripts/run.sh");

  const source = { repo, path: "pkgs/demo", ref: first, track: undefined };
  expect(await fetchPackage(loaded, loaded.packages[0], source)).toEqual([`installed .office/packages/demo from ${repo} at ${first}`]);

  const installed = read(office, "demo").result;

  if (!installed.ok) throw new Error(installed.errors.join("\n"));

  expect(installPackage(loaded, installed.value)).toEqual(["wrote .office/packages/demo/.settings.json", "wrote .office/packages/demo/.office.json (opencode: container)", "created out/AGENTS.md from package demo"]);
  write(join(office, "out/AGENTS.md"), "the office's own\n");
  write(script, "echo edited\n");

  const [restored] = await fetchPackage(loaded, loaded.packages[0], source);

  expect(restored).toStartWith(`restored .office/packages/demo to its copy of ${first}, undoing edits to scripts/run.sh (edited);`);
  expect(readFileSync(script, "utf8")).toBe("echo one\n");

  write(join(office, "office.yaml"), entry(second));
  expect(await fetchPackage(loadOffice(office), loaded.packages[0], { ...source, ref: second })).toEqual([`updated .office/packages/demo from ${repo} pkgs/demo at ${first.slice(0, 12)} (ref ${first}) to ${second} (${second})`]);
  expect(readFileSync(script, "utf8")).toBe("echo two\n");

  const updated = read(office, "demo");

  if (!updated.result.ok) throw new Error(updated.result.errors.join("\n"));

  expect(installPackage(updated.loaded, updated.result.value)).toEqual([]);
  expect(readFileSync(join(office, "out/AGENTS.md"), "utf8")).toBe("the office's own\n");
});

test("a package plugin is linked while declared, gives way to a plugins: entry of its name without git running through the link, and is unlinked when the entry goes", async () => {
  const office = join(dir, "office");
  const cloned = join(dir, "cloned");
  const link = join(office, ".opencode/plugins/demo");
  const declared = "name: t\npackages:\n  - name: demo\n";

  writePackage(join(office, "packages/demo/package.yaml"), "{}\n");
  write(join(office, "packages/demo/plugin/index.ts"), "export default { id: \"demo\", async setup() {} };\n");
  write(join(office, "office.yaml"), declared);
  git(["init", "--quiet", office]);

  expect(await sync(loadOffice(office))).toContain("linked .opencode/plugins/demo");
  expect(readlinkSync(link)).toBe("../../packages/demo/plugin");

  write(join(cloned, "index.ts"), "export default { id: \"cloned\", async setup() {} };\n");
  git(["init", "--quiet", cloned]);
  git(["add", "-A"], cloned);
  git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "plugin"], cloned);
  write(join(office, "office.yaml"), `${declared}plugins:\n  - name: demo\n    repo: ${cloned}\n`);

  const changes = await sync(loadOffice(office));

  expect(changes).toContain("cloned plugin .office/plugins/demo");
  expect(changes).toContain("FAILED package demo: its plugin would be .opencode/plugins/demo, where the plugins: entry demo is cloned, so it isn't linked; rename one of them");
  expect(changes).toContain("unlinked .opencode/plugins/demo for the plugins: entry of that name; restart OpenCode to pick up demo: a running server keeps loading a plugin from where it first found it");
  expect(readlinkSync(link)).toBe("../../.office/plugins/demo");
  expect(git(["rev-parse", "--show-toplevel"], link)).toBe(realpathSync(join(office, ".office/plugins/demo")));

  rmSync(link, { recursive: true });
  write(join(office, "office.yaml"), declared);
  await sync(loadOffice(office));
  write(join(office, "office.yaml"), "name: t\n");

  expect(await sync(loadOffice(office))).toContain("unlinked .opencode/plugins/demo");
  expect(existsSync(link)).toBe(false);
});

test("a seed file is created once: one the office deletes stays deleted, also on a fresh clone, one already there is kept, and one the package adds later is created", () => {
  const office = join(dir, "office");

  const install = () => {
    const { loaded, result } = read(office, "demo");

    if (!result.ok) throw new Error(result.errors.join("\n"));

    return installPackage(loaded, result.value);
  };

  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: demo\n");
  writePackage(join(office, "packages/demo/package.yaml"), "{}\n");
  write(join(office, "packages/demo/seed/notes/README.md"), "from the package\n");
  write(join(office, "packages/demo/seed/notes/AGENTS.md"), "from the package\n");
  write(join(office, "notes/AGENTS.md"), "the office's own\n");

  expect(install()).toEqual(["wrote packages/demo/.settings.json", "wrote packages/demo/.office.json (opencode: container)", "kept notes/AGENTS.md, which was already there, instead of package demo's copy", "created notes/README.md from package demo"]);
  expect(receipts(office)).toEqual({ "notes/AGENTS.md": { package: "demo", existing: true }, "notes/README.md": { package: "demo", sha256: createHash("sha256").update("from the package\n").digest("hex") } });
  expect(existsSync(join(office, "packages/demo/.template.json"))).toBe(false);

  // The receipts are in office.lock, so a fresh clone doesn't copy the deleted files again.
  rmSync(join(office, "notes"), { recursive: true });
  freshClone(office);
  write(join(office, "packages/demo/seed/notes/later.md"), "added by a later version\n");

  expect(install()).toEqual(["created notes/later.md from package demo"]);
  expect(existsSync(join(office, "notes/README.md"))).toBe(false);
  expect(existsSync(join(office, "notes/AGENTS.md"))).toBe(false);
  expect(install()).toEqual([]);
});

test("sync removes a copied package whose entry is gone, even an edited copy, with the seed files it still holds, and leaves changed files, the office's own and a package written in the office beside them", async () => {
  const repo = join(dir, "repo");
  const office = join(dir, "office");

  writePackage(join(repo, "pkgs/demo/package.yaml"), manifest);
  write(join(repo, "pkgs/demo/skills/demo-skill/SKILL.md"), "---\nname: demo-skill\ndescription: Demo.\n---\n");
  write(join(repo, "pkgs/demo/seed/.github/workflows/publish.yml"), "on: push\n");
  write(join(repo, "pkgs/demo/seed/out/AGENTS.md"), "from the package\n");
  write(join(repo, "pkgs/demo/seed/out/README.md"), "from the package\n");
  git(["init", "--quiet", repo]);
  git(["add", "-A"], repo);
  git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "one"], repo);

  write(join(office, "office.yaml"), `name: t\npackages:\n  - name: demo\n    repo: ${repo}\n    path: pkgs/demo\n    ref: ${git(["rev-parse", "HEAD"], repo)}\n    settings: { url: https://example.com }\n`);
  git(["init", "--quiet", office]);
  await sync(loadOffice(office));
  write(join(office, "out/README.md"), "the office changed this\n");
  write(join(office, "out/my-page/index.md"), "the office's own\n");
  write(join(office, ".github/dependabot.yml"), "version: 2\n");
  writePackage(join(office, ".office/packages/demo/package.yaml"), `${manifest}# edited\n`);
  writePackage(join(office, "packages/own/package.yaml"), "{}\n");
  write(join(office, "office.yaml"), "name: t\n");

  const changes = await sync(loadOffice(office));

  expect(changes).toEqual([
    "deleted .github/workflows/publish.yml, which package demo created",
    "deleted out/AGENTS.md, which package demo created",
    "kept out/README.md, which changed since package demo wrote it",
    "removed .office/packages/demo/, which office.yaml no longer lists",
    "linked packages/node_modules/@office to the published package set, for editors",
    "office.lock: removed demo",
  ]);
  expect(existsSync(join(office, ".office/packages/demo"))).toBe(false);
  expect(existsSync(join(office, ".github/workflows"))).toBe(false);
  expect(readFileSync(join(office, ".github/dependabot.yml"), "utf8")).toBe("version: 2\n");
  expect(readFileSync(join(office, "out/README.md"), "utf8")).toBe("the office changed this\n");
  expect(readFileSync(join(office, "out/my-page/index.md"), "utf8")).toBe("the office's own\n");
  expect(existsSync(join(office, "packages/own/package.yaml"))).toBe(true);
  expect(await sync(loadOffice(office))).toEqual([]);
});

test("sync changes no seeded file or receipt of a package it can't read, even one whose seed changed or went", async () => {
  const office = join(dir, "office");

  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: demo\n");
  writePackage(join(office, "packages/demo/package.yaml"), "{}\n");
  write(join(office, "packages/demo/seed/changed.md"), "v1\n");
  write(join(office, "packages/demo/seed/gone.md"), "v1\n");
  git(["init", "--quiet", office]);
  expect(await sync(loadOffice(office))).toContain("created changed.md from package demo");

  const lock = readFileSync(join(office, "office.lock"), "utf8");

  writePackage(join(office, "packages/demo/package.yaml"), "name: demo\n  description: [not, valid\n");
  write(join(office, "packages/demo/seed/changed.md"), "v2\n");
  rmSync(join(office, "packages/demo/seed/gone.md"));

  const changes = await sync(loadOffice(office));

  expect(changes.some((line) => line.startsWith("FAILED") && line.includes("demo"))).toBe(true);
  expect(changes.filter((line) => line.includes(".md"))).toEqual([]);
  expect(readFileSync(join(office, "changed.md"), "utf8")).toBe("v1\n");
  expect(readFileSync(join(office, "gone.md"), "utf8")).toBe("v1\n");
  expect(readFileSync(join(office, "office.lock"), "utf8")).toBe(lock);

  // Read again, the package's changes apply.
  writePackage(join(office, "packages/demo/package.yaml"), "{}\n");
  expect((await sync(loadOffice(office))).filter((line) => line.includes(".md"))).toEqual(["updated changed.md to package demo's new seed, as the file was unchanged", "kept gone.md, which package demo no longer seeds, and dropped its receipt"]);
});

test("a seed path the seeds: section couldn't hold is refused before copying, and the other files go ahead; an unreadable lock refuses before any copy", () => {
  const office = join(dir, "office");

  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: demo\n");
  writePackage(join(office, "packages/demo/package.yaml"), "{}\n");
  write(join(office, "packages/demo/seed/back\\slash.md"), "odd\n");
  write(join(office, "packages/demo/seed/plain.md"), "plain\n");

  const install = () => {
    const { loaded, result } = read(office, "demo");

    if (!result.ok) throw new Error(result.errors.join("\n"));

    return installPackage(loaded, result.value).filter((line) => !line.startsWith("wrote"));
  };

  // Runtime pins that can't be read: the receipts couldn't be saved, so nothing is copied.
  write(join(office, "office.lock"), "mise: [not, a, pin]\n");
  expect(install()).toEqual(["FAILED package demo's seed/back\\slash.md: not a plain office-relative path", expect.stringMatching(/^FAILED package demo's seed files: office\.lock is not valid/)]);
  expect(existsSync(join(office, "plain.md"))).toBe(false);

  rmSync(join(office, "office.lock"));
  expect(install()).toEqual(["FAILED package demo's seed/back\\slash.md: not a plain office-relative path", "created plain.md from package demo"]);
  expect(existsSync(join(office, "back\\slash.md"))).toBe(false);
  expect(Object.keys(receipts(office))).toEqual(["plain.md"]);
});

test("a pulled-in package deselected before a fresh clone installed it settles its receipts without its copy", async () => {
  const repo = join(dir, "repo");
  const office = join(dir, "office");

  writePackage(join(repo, "pkgs/demo/package.yaml"), manifest);
  write(join(repo, "pkgs/demo/seed/out/deleted.md"), "from the package\n");
  write(join(repo, "pkgs/demo/seed/out/kept.md"), "from the package\n");
  write(join(repo, "pkgs/demo/seed/out/edited.md"), "from the package\n");
  write(join(repo, "pkgs/demo/seed/mine.md"), "from the package\n");
  git(["init", "--quiet", repo]);
  git(["add", "-A"], repo);
  git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "one"], repo);

  write(join(office, "mine.md"), "the office's own\n");
  write(join(office, "office.yaml"), `name: t\npackages:\n  - name: demo\n    repo: ${repo}\n    path: pkgs/demo\n    ref: ${git(["rev-parse", "HEAD"], repo)}\n    settings: { url: https://example.com }\n`);
  git(["init", "--quiet", office]);
  await sync(loadOffice(office));
  rmSync(join(office, "out/deleted.md"));
  write(join(office, "out/edited.md"), "the office changed this\n");

  // Removed from office.yaml before the package was installed on another clone.
  const seeds = storedSeeds(office);

  expect(Object.keys(seeds)).toHaveLength(2);
  freshClone(office);
  write(join(office, "office.yaml"), "name: t\n");
  expect((await sync(loadOffice(office))).filter((line) => line.includes(".md") || line.includes("demo"))).toEqual([
    "kept out/edited.md, which changed since package demo wrote it",
    "deleted out/kept.md, which package demo created",
    "office.lock: removed demo",
  ]);
  expect(readFileSync(join(office, "mine.md"), "utf8")).toBe("the office's own\n");
  expect(readdirSync(join(office, "out"))).toEqual(["edited.md"]);
  expect(receipts(office)).toEqual({});
  // Office never deletes a stored seed.
  expect(storedSeeds(office)).toEqual(seeds);
});

test("sync locks a Git package's commit in office.lock, keeps the entry when a changed ref fails, and drops it with the package", async () => {
  const repo = join(dir, "repo");
  const office = join(dir, "office");
  const lock = join(office, "office.lock");
  const yaml = (ref: string) => `name: t\npackages:\n  - name: demo\n    repo: ${repo}\n    path: pkgs/demo\n    ref: ${ref}\n    settings: { url: https://example.com }\n`;

  const commit = () => {
    git(["add", "-A"], repo);
    git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "change"], repo);

    return git(["rev-parse", "HEAD"], repo);
  };

  writePackage(join(repo, "pkgs/demo/package.yaml"), manifest);
  git(["init", "--quiet", repo]);
  const first = commit();

  git(["tag", "v1"], repo);
  // An office with no Git packages and no office.lock gets none.
  write(join(office, "office.yaml"), "name: t\n");
  git(["init", "--quiet", office]);
  await sync(loadOffice(office), { scope: "packages" });
  expect(existsSync(lock)).toBe(false);

  write(join(office, "office.yaml"), yaml("v1"));
  expect(await sync(loadOffice(office), { scope: "packages" })).toContain(`office.lock: locked demo at ${first.slice(0, 12)}`);
  const locked = readFileSync(lock, "utf8");

  expect(readLockSection(office, "packages")).toEqual(new Map([["demo", { repo, path: "pkgs/demo", ref: "v1", commit: first }]]));
  expect(locked).not.toContain("opencode:");

  // A changed ref whose copy fails validation publishes nothing: the copy, its settings and the lock stay at v1.
  const record = join(office, ".office/packages/demo/.source.json");
  const installed = [readFileSync(record, "utf8"), readFileSync(join(office, ".office/packages/demo/.settings.json"), "utf8")];

  writePackage(join(repo, "pkgs/demo/office.ts"), "throw new Error('broken candidate')");
  const broken = commit();

  write(join(office, "office.yaml"), yaml(broken));
  expect((await sync(loadOffice(office), { scope: "packages" })).join("\n")).toContain("broken candidate");
  expect([readFileSync(record, "utf8"), readFileSync(join(office, ".office/packages/demo/.settings.json"), "utf8")]).toEqual(installed);
  expect(readFileSync(lock, "utf8")).toBe(locked);

  // A locked commit the repository no longer has fails, naming it, and changes neither the copy nor the lock.
  const gone = "0123456789abcdef".repeat(3).slice(0, 40);

  write(join(office, "office.yaml"), yaml("v1"));
  writeFileSync(lock, locked.replace(first, gone));
  const unreachable = readFileSync(lock, "utf8");
  const failed = (await sync(loadOffice(office), { scope: "packages" })).filter(line => line.startsWith("FAILED"));

  expect(failed.length).toBe(1);
  expect(failed[0]).toContain(`revision ${gone}`);
  expect(readFileSync(lock, "utf8")).toBe(unreachable);
  expect(readFileSync(record, "utf8")).toBe(installed[0]!);

  write(join(office, "office.yaml"), "name: t\n");
  expect(await sync(loadOffice(office), { scope: "packages" })).toContain("office.lock: removed demo");
  expect(existsSync(lock)).toBe(false);
});

test("an entry without repo is built-in when shipped and local otherwise; the required office package appears only once, a built-in can't come from another repository and no package is called sdk", () => {
  const office = join(dir, "office");

  write(
    join(office, "office.yaml"),
    [
      "name: t",
      "packages:",
      "  - name: knowledge",
      "  - name: mine",
      "  - name: office",
      "  - name: shared",
      "    repo: https://example.com/shared.git",
      "    path: packages/shared",
      "    ref: main",
      "  - name: sdk",
      "",
    ].join("\n"),
  );

  const { packages, problems } = resolvePackages(loadOffice(office));

  expect(packages.map((item) => [item.entry.name, item.kind, item.dir.slice(office.length + 1)])).toEqual([
    ["tooling", "built-in", ".office/packages/tooling"],
    ["mise-integration", "built-in", ".office/packages/mise-integration"],
    ["office", "built-in", ".office/packages/office"],
    ["references", "built-in", ".office/packages/references"],
    ["knowledge", "built-in", ".office/packages/knowledge"],
    ["mine", "local", "packages/mine"],
    ["shared", "remote", ".office/packages/shared"],
  ]);
  // A package called sdk would take @office/sdk's place in the package set.
  expect(problems).toEqual([{ packages: ["sdk"], message: "the name sdk is reserved for @office/sdk; rename the package" }]);
});

test("sync installs the built-in packages from the tool and restores an edited copy, keeping the office's records", async () => {
  const office = join(dir, "office");
  const skill = join(office, ".office/packages/office/skills/office/SKILL.md");

  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: knowledge\n");

  const installed = await sync(loadOffice(office));

  expect(installed).toContain("installed .office/packages/office, the built-in office package");
  expect(installed).toContain("installed .office/packages/knowledge, the built-in knowledge package");
  expect(installed).toContain("linked .opencode/plugins/office");
  expect(readlinkSync(join(office, ".opencode/plugins/office"))).toBe("../../.office/packages/office/plugin");
  expect(existsSync(join(office, ".office/packages/office/plugin/index.js"))).toBe(true);

  const original = readFileSync(skill, "utf8");
  const received = receipts(office);

  expect(Object.values(received).some((receipt) => receipt.package === "knowledge" && "sha256" in receipt)).toBe(true);

  write(skill, "edited\n");
  rmSync(join(office, ".office/packages/knowledge/README.md"));

  const restored = await sync(loadOffice(office));

  expect(restored).toHaveLength(2);
  expect(restored[0]).toStartWith("restored .office/packages/office, undoing edits to skills/office/SKILL.md (edited);");
  expect(restored[1]).toStartWith("restored .office/packages/knowledge, undoing edits to README.md (removed);");
  expect(readFileSync(skill, "utf8")).toBe(original);
  expect(receipts(office)).toEqual(received);
  expect(await sync(loadOffice(office))).toEqual([]);
});

test("the required office package ignores the Claude app's synced skills unless turned off, and takes more folders as a list", async () => {
  const office = join(dir, "office");
  const settings = join(office, ".office/packages/office/.settings.json");

  write(join(office, "office.yaml"), "name: t\n");
  await sync(loadOffice(office));

  expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ ignore_claude_synced_skills: true, ignore_skill_folders: [] });

  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: office\n    settings:\n      ignore_claude_synced_skills: false\n      ignore_skill_folders:\n        - ~/other/skills\n");

  expect(await sync(loadOffice(office))).toEqual(["wrote .office/packages/office/.settings.json"]);
  expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ ignore_claude_synced_skills: false, ignore_skill_folders: ["~/other/skills"] });

  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: office\n    settings:\n      ignore_skill_folders: ~/.claude/skills/synced\n");
  expect(read(office, "office").result).toMatchObject({ ok: false, errors: ["packages.office.settings.ignore_skill_folders: must be array"] });

  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: office\n    settings:\n      ignored: []\n");
  expect(read(office, "office").result).toMatchObject({ ok: false, errors: ["packages.office.settings.ignored: the package declares no such setting; remove it from office.yaml"] });

  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: office\n    repo: https://example.com/fork.git\n    path: packages/office\n    ref: main\n");
  expect(() => loadOffice(office)).toThrow("the required office package is built in: its entry can only configure settings and cron");

  // A skill a built-in package renamed, as an earlier executable's copy held it, leaves on the next sync.
  const skills = join(office, ".office/packages/office/skills");

  write(join(office, "office.yaml"), "name: t\n");
  write(join(skills, "skill-creator/SKILL.md"), readFileSync(join(skills, "openai-skill-creator/SKILL.md"), "utf8"));
  await sync(loadOffice(office));

  expect(existsSync(join(skills, "skill-creator"))).toBe(false);
  expect(readFileSync(join(skills, "openai-skill-creator/SKILL.md"), "utf8")).toContain("\nname: openai-skill-creator\n");
  expect(existsSync(join(skills, "openai-skill-creator/NOTICE"))).toBe(true);
  expect(existsSync(join(skills, "openai-skill-creator/license.txt"))).toBe(true);
});

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { CommandInputs, Entries, Registry, RegistryEntry, Settings, SyncInputs } from "@office/sdk";
import { checkoutFolder, ensureCheckout, resolveTrack } from "../git.ts";
import { skills } from "../handles.ts";
import { receiptFile } from "../links.ts";
import definition from "../office.ts";
import type { settingsSchema } from "../settings.ts";

/** The settings as the package gets them, defaults applied. */
type Given = Settings<typeof settingsSchema>;

let root: string;
let office: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "office-skills-"));
  office = join(root, "office");
  mkdirSync(office);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, text = "---\nname: x\ndescription: d\n---\n") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function git(args: string[], cwd: string) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A repository at `root/<name>` with `files` committed on main, tagged `tag` when given; returns the commit. */
function commit(name: string, files: Record<string, string | null>, tag?: string): string {
  const repo = join(root, name);

  if (!existsSync(repo)) {
    mkdirSync(repo);
    git(["init", "-q", "-b", "main"], repo);
  }

  for (const [file, text] of Object.entries(files)) {
    if (text === null) rmSync(join(repo, file), { recursive: true });
    else write(join(repo, file), text);
  }

  git(["add", "-A"], repo);
  git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "c", "--allow-empty"], repo);

  if (tag) git(["tag", tag], repo);

  return git(["rev-parse", "HEAD"], repo);
}

type Offered = { owner: string; root: string; directory: string };

/** Entries holding the skill offers `offered`, whatever else is asked for. */
function entriesOf(offered: Offered[] = []): Entries {
  return <Value extends RegistryEntry>(registry: Registry<Value>) => offered.flatMap(({ owner, root: at, directory }) => registry.id === skills.id ? [{ value: registry.parse({ directory }), owner, namespace: owner, settings: {}, folder: at, root: at }] : []);
}

const office_ = () => ({ dir: office, name: "test", mode: "container" as const, launcher: "office" });

type ExclusionChange = { add?: readonly string[]; remove?: readonly string[] };

/** Every immediate exclusion change asked for, in order. */
let updates: ExclusionChange[];

beforeEach(() => {
  updates = [];
});

const updateExcluded = (change: ExclusionChange) => {
  updates.push(change);

  return (change.remove ?? []).map(path => `stopped excluding /${path}`);
};

function syncInputs(settings: Given, offered: Offered[] = []) {
  const excluded: string[] = [];
  const inputs: SyncInputs<Given> = { office: office_(), entries: entriesOf(offered), settings, exclude: paths => excluded.push(...paths), updateExcluded };

  return { inputs, excluded };
}

function command(name: string, settings: Given, offered: Offered[] = [], replaceSetting: CommandInputs<Given>["replaceSetting"] = () => { throw new Error("no settings change expected"); }) {
  const found = definition.commands?.[name];

  if (found === undefined) throw new Error(`no command ${name}`);
  const inputs = { office: office_(), entries: entriesOf(offered), settings, args: [], replaceSetting, updateExcluded };

  return { found, inputs };
}

async function list(settings: Given, offered: Offered[] = []) {
  const err = spyOn(console, "error").mockImplementation(() => undefined);

  try {
    const { found, inputs } = command("skills list", settings, offered);

    if (!found.result) throw new Error("skills list returns its text");

    return { out: await found.result(inputs), err: err.mock.calls.map(call => String(call[0])) };
  } finally {
    err.mockRestore();
  }
}

async function sync(settings: Given, offered: Offered[] = []) {
  const { inputs, excluded } = syncInputs(settings, offered);

  return { lines: (await definition.sync?.(inputs)) ?? [], excluded };
}

const link = (id: string) => join(office, ".agents/skills", id);

const host = { timers: { set: () => [], clear: () => [], status: () => [] } };

test("skills.add takes only a package-relative folder ending in a skill ID", () => {
  expect(skills.parse({ directory: "skills/review" })).toEqual({ directory: "skills/review" });
  expect(() => skills.parse({ directory: "../review" })).toThrow("directory must be a relative path inside the package");
  expect(() => skills.parse({ directory: "skills/Review" })).toThrow("must end in a skill ID");
  expect(() => skills.parse({ directory: "skills/review", name: "x" })).toThrow("unknown key name");
});

test("list gives every offer's ID, source and status, sorted, from packages, a folder and a Git source, without fetching or writing", async () => {
  write(join(office, "skills/alpha/SKILL.md"));
  write(join(office, "skills/notes.md"), "not a skill folder\n");
  write(join(office, "skills/Bad Name/SKILL.md"));
  write(join(office, "skills/no-skill/README.md"), "no SKILL.md\n");
  write(join(office, "packages/tools/skills/zeta/SKILL.md"));

  const settings: Given = {
    sources: [{ folder: "skills" }, { repo: join(root, "absent"), ref: "a".repeat(40), skills: [{ name: "review", path: "engineering/review" }] }],
    enabled: ["alpha", "review"],
  };

  const { out, err } = await list(settings, [{ owner: "tools", root: join(office, "packages/tools"), directory: "skills/zeta" }]);

  const source = `${join(root, "absent")} at aaaaaaaaaaaa`;

  expect(out).toBe([`alpha   ${"folder skills".padEnd(source.length)}  enabled`, `review  ${source}  enabled`, `zeta    ${"package tools".padEnd(source.length)}  available`].join("\n"));
  expect(err).toEqual(["skills/Bad Name isn't offered: a skill ID is lowercase letters and digits, joined by single dashes", `${join(root, "absent")} at aaaaaaaaaaaa isn't fetched yet; office sync fetches it`]);
  expect(existsSync(join(office, ".office"))).toBe(false);
  expect(existsSync(join(office, ".agents"))).toBe(false);
});

test("list shows a conflicting ID on each of its rows, an enabled ID nobody offers, and nothing without sources", async () => {
  write(join(office, "skills/alpha/SKILL.md"));
  write(join(office, "packages/tools/skills/alpha/SKILL.md"));
  const offered = [{ owner: "tools", root: join(office, "packages/tools"), directory: "skills/alpha" }];

  expect((await list({ sources: [{ folder: "skills" }], enabled: ["alpha", "ghost"] }, offered)).out).toBe([
    "alpha  folder skills  enabled, conflicting",
    "alpha  package tools  enabled, conflicting",
    "ghost  -              enabled, offered by no source",
  ].join("\n"));
  // No source is scanned unless named, so a skills/ folder alone offers nothing.
  expect((await list({ sources: [], enabled: [] })).out).toBe("");
});

test("sync links only enabled skills as whole folders, records them, excludes them, and a second sync changes nothing", async () => {
  write(join(office, "skills/alpha/SKILL.md"));
  write(join(office, "skills/alpha/references/notes.md"), "support\n");
  write(join(office, "skills/beta/SKILL.md"));
  const settings = { sources: [{ folder: "skills" }], enabled: ["alpha"] };

  const first = await sync(settings);

  expect(first.lines).toEqual(["linked .agents/skills/alpha (folder skills)"]);
  expect(first.excluded).toEqual([".agents/skills/alpha"]);
  expect(readlinkSync(link("alpha"))).toBe("../../skills/alpha");
  expect(readFileSync(join(link("alpha"), "references/notes.md"), "utf8")).toBe("support\n");
  expect(existsSync(link("beta"))).toBe(false);
  expect(JSON.parse(readFileSync(join(office, receiptFile), "utf8"))).toEqual({ links: { ".agents/skills/alpha": "../../skills/alpha" } });

  expect(await sync(settings)).toEqual({ lines: [], excluded: [".agents/skills/alpha"] });
  expect(await definition.check?.({ ...syncInputs(settings).inputs, host })).toEqual([]);
});

test("disabling a skill removes only its link; a manual skill, a replaced link and the source stay", async () => {
  write(join(office, "skills/alpha/SKILL.md"));
  write(join(office, "skills/beta/SKILL.md"));
  write(join(office, ".agents/skills/manual/SKILL.md"));
  await sync({ sources: [{ folder: "skills" }], enabled: ["alpha", "beta"] });
  // The owner points beta elsewhere: it is theirs now.
  rmSync(link("beta"));
  symlinkSync("../../skills/alpha", link("beta"));

  const { lines, excluded } = await sync({ sources: [{ folder: "skills" }], enabled: [] });

  expect(lines).toEqual(["stopped excluding /.agents/skills/beta", "unlinked .agents/skills/alpha", "stopped managing .agents/skills/beta: it changed since this package linked it, so it is the owner's"]);
  expect(excluded).toEqual([]);
  expect(existsSync(link("alpha"))).toBe(false);
  expect(readlinkSync(link("beta"))).toBe("../../skills/alpha");
  expect(existsSync(join(office, "skills/alpha/SKILL.md"))).toBe(true);
  expect(existsSync(join(office, ".agents/skills/manual/SKILL.md"))).toBe(true);
  expect(JSON.parse(readFileSync(join(office, receiptFile), "utf8"))).toEqual({ links: {} });
});

test("an occupied destination, a dangling owner link, a lost receipt, a conflict or a missing offer stops sync before any link changes", async () => {
  write(join(office, "skills/alpha/SKILL.md"));
  write(join(office, "skills/beta/SKILL.md"));
  write(join(office, "skills/gamma/SKILL.md"));
  write(join(office, ".agents/skills/beta/SKILL.md"), "the owner's\n");
  mkdirSync(join(office, ".agents/skills"), { recursive: true });
  symlinkSync("../../nowhere", link("gamma"));
  await expect(sync({ sources: [{ folder: "skills" }], enabled: ["alpha", "beta", "gamma"] })).rejects.toThrow("no skill delivery changed: .agents/skills/beta is already there and isn't a delivery this package recorded; move it aside or disable that skill; .agents/skills/gamma is already there");
  expect(existsSync(link("alpha"))).toBe(false);
  await expect(sync({ sources: [{ folder: "skills" }], enabled: ["alpha", "ghost"] })).rejects.toThrow("skill ghost is enabled, but no source offers it");
  write(join(office, "packages/tools/skills/alpha/SKILL.md"));
  await expect(sync({ sources: [{ folder: "skills" }], enabled: ["alpha"] }, [{ owner: "tools", root: join(office, "packages/tools"), directory: "skills/alpha" }])).rejects.toThrow("skill alpha is offered by more than one source: package tools and folder skills");
  expect(existsSync(link("alpha"))).toBe(false);
  expect(readlinkSync(link("gamma"))).toBe("../../nowhere");

  // Linked, then the receipt is lost: the link is reported as occupied, never taken over.
  await sync({ sources: [{ folder: "skills" }], enabled: ["alpha"] });
  rmSync(join(office, receiptFile));
  await expect(sync({ sources: [{ folder: "skills" }], enabled: ["alpha"] })).rejects.toThrow(".agents/skills/alpha is already there and isn't a delivery this package recorded");
  const problems = await definition.check?.({ ...syncInputs({ sources: [{ folder: "skills" }], enabled: ["alpha"] }).inputs, host });

  expect(problems).toEqual([{ level: "failed", message: ".agents/skills/alpha is already there and isn't a delivery this package recorded; move it aside or disable that skill" }]);
});

test("a Git source is fetched once at its pinned commit and then used offline; its folders share that checkout", async () => {
  const first = commit("repo", { "engineering/review/SKILL.md": "review one\n", "engineering/review/notes.md": "one\n", "other/lint/SKILL.md": "lint\n" });
  const repo = join(root, "repo");
  const settings = { sources: [{ repo, ref: first, skills: [{ name: "review", path: "engineering/review" }, { name: "lint", path: "other/lint" }] }], enabled: ["review", "lint"] };

  expect((await sync(settings)).lines).toEqual([
    `fetched ${repo} at ${first.slice(0, 12)}`,
    `copied skill .agents/skills/review (${repo} at ${first.slice(0, 12)})`,
    `copied skill .agents/skills/lint (${repo} at ${first.slice(0, 12)})`,
  ]);
  expect(lstatSync(link("review")).isDirectory()).toBe(true);
  expect(readFileSync(join(link("review"), "notes.md"), "utf8")).toBe("one\n");

  // Upstream moves and then disappears: plain sync keeps the pin and needs no remote.
  commit("repo", { "engineering/review/notes.md": "two\n" });
  rmSync(repo, { recursive: true });
  expect((await sync(settings)).lines).toEqual([]);
  expect(readFileSync(join(link("review"), "notes.md"), "utf8")).toBe("one\n");
  expect(() => ensureCheckout(office, repo, "b".repeat(40))).toThrow(`could not fetch bbbbbbbbbbbb from ${repo}`);
  expect(existsSync(join(office, checkoutFolder(repo, "b".repeat(40))))).toBe(false);
});

test("a track resolves to a branch's commit or the highest stable tag matching its pattern", () => {
  commit("repo", {}, "v2.9.0");
  const tenth = commit("repo", {}, "v2.10.0");

  commit("repo", {}, "v2.11.0-rc.1");
  commit("repo", {}, "v3.0.0");
  const head = commit("repo", {});
  const repo = join(root, "repo");

  expect(resolveTrack(repo, "v2.*")).toEqual({ commit: tenth, via: "tag v2.10.0" });
  expect(resolveTrack(repo, "main")).toEqual({ commit: head, via: "branch main" });
  expect(() => resolveTrack(repo, "missing")).toThrow(`${repo} has no branch missing`);
  expect(() => resolveTrack(repo, "v9.*")).toThrow("no stable SemVer tag");
});

test("ties between equally versioned tags use lexical order, as package updates do", () => {
  commit("repo", {}, "a-1.2.3");
  const preferred = commit("repo", {}, "Z-1.2.3");

  expect(resolveTrack(join(root, "repo"), "*-1.*")).toEqual({ commit: preferred, via: "tag Z-1.2.3" });
});

test("update moves a tracked pin and copies at once; a candidate missing a skill keeps the pin and delivery", async () => {
  const first = commit("repo", { "review/SKILL.md": "one\n", "lint/SKILL.md": "lint\n" });
  const repo = join(root, "repo");
  const fixed = { repo, ref: first, skills: [{ name: "fixed", path: "review" }] };
  const tracked = (ref: string) => ({ repo, ref, track: "main", skills: [{ name: "review", path: "review" }, { name: "lint", path: "lint" }] });
  let settings: Given = { sources: [tracked(first), fixed], enabled: ["review"] };
  const edits: [readonly (string | number)[], string | number | boolean][] = [];

  const replaceSetting = (path: readonly (string | number)[], value: string | number | boolean) => {
    edits.push([path, value]);
    settings = { ...settings, sources: [tracked(String(value)), fixed] };

    return settings;
  };

  await sync(settings);
  updates.length = 0;
  const second = commit("repo", { "review/SKILL.md": "two\n" });
  const out = spyOn(console, "log").mockImplementation(() => undefined);

  try {
    const { found, inputs } = command("skills update", settings, [], replaceSetting);

    await found.run?.(inputs);
    expect(out.mock.calls.map(call => String(call[0]))).toEqual([
      `${repo}: pinned ${first.slice(0, 12)} → ${second} (branch main); skills review, lint`,
      `copied skill .agents/skills/review (${repo} at ${second.slice(0, 12)})`,
      `${repo}: pinned at ${first.slice(0, 12)} with no track, so left there`,
    ]);
    expect(edits).toEqual([[["sources", 0, "ref"], second]]);
    expect(readFileSync(join(link("review"), "SKILL.md"), "utf8")).toBe("two\n");
    expect(updates).toEqual([{ add: [".agents/skills/review/"] }]);

    // The next candidate drops lint, which isn't even enabled: nothing moves.
    const third = commit("repo", { lint: null });
    const next = command("skills update", settings, [], replaceSetting);

    expect(() => next.found.run?.(next.inputs)).toThrow(`skill lint from ${repo} at ${third.slice(0, 12)}: lint has no SKILL.md file at that commit; pin left at ${second.slice(0, 12)} and its skills unchanged`);
    expect(edits).toHaveLength(1);
    expect(readFileSync(join(link("review"), "SKILL.md"), "utf8")).toBe("two\n");
  } finally {
    out.mockRestore();
  }
});

test("an offer's SKILL.md must be a regular file inside its folder, and the folder inside its source, followed through links", async () => {
  write(join(root, "outside/escape/SKILL.md"));
  write(join(root, "outside/marker.md"));
  mkdirSync(join(office, "skills/folder/SKILL.md"), { recursive: true });
  mkdirSync(join(office, "skills/pointed"), { recursive: true });
  symlinkSync(join(root, "outside/marker.md"), join(office, "skills/pointed/SKILL.md"));
  symlinkSync(join(root, "outside/escape"), join(office, "skills/escape"));
  write(join(office, "skills/inner/SKILL.md"));
  const settings = (id: string) => ({ sources: [{ folder: "skills" }], enabled: [id] });

  await expect(sync(settings("folder"))).rejects.toThrow("skill folder from folder skills: skills/folder has no SKILL.md file");
  await expect(sync(settings("pointed"))).rejects.toThrow("skill pointed from folder skills: skills/pointed leads outside its source");
  await expect(sync(settings("escape"))).rejects.toThrow("skill escape from folder skills: skills/escape leads outside its source");
  expect(existsSync(join(office, ".agents"))).toBe(false);
  expect((await sync(settings("inner"))).lines).toEqual(["linked .agents/skills/inner (folder skills)"]);
});

test("sync checks every folder a Git source names, enabled or not, before any link changes", async () => {
  const ref = commit("repo", { "review/SKILL.md": "review\n" });
  const repo = join(root, "repo");

  await expect(sync({ sources: [{ repo, ref, skills: [{ name: "review", path: "review" }, { name: "lint", path: "lint" }] }], enabled: ["review"] })).rejects.toThrow(`no skill delivery changed: skill lint from ${repo} at ${ref.slice(0, 12)}: lint has no SKILL.md file at that commit`);
  expect(existsSync(link("review"))).toBe(false);
});

test("update checks the whole candidate, link conflicts included, before its pin moves", async () => {
  const first = commit("repo", { "review/SKILL.md": "one\n" });
  const repo = join(root, "repo");
  const settings: Given = { sources: [{ repo, ref: first, track: "main", skills: [{ name: "review", path: "review" }] }], enabled: ["review"] };

  // A folder without a receipt belongs to the owner.
  write(join(link("review"), "SKILL.md"), "the owner's\n");
  const second = commit("repo", { "review/SKILL.md": "two\n" });
  const { found, inputs } = command("skills update", settings);
  const out = spyOn(console, "log").mockImplementation(() => undefined);

  try {
    expect(() => found.run?.(inputs)).toThrow(`${repo} at ${second.slice(0, 12)} (branch main): no skill delivery changed: .agents/skills/review is already there and isn't a delivery this package recorded; move it aside or disable that skill; pin left at ${first.slice(0, 12)} and its skills unchanged`);
  } finally {
    out.mockRestore();
  }

  expect(readFileSync(join(link("review"), "SKILL.md"), "utf8")).toBe("the owner's\n");
  expect(updates).toEqual([]);
});

test("a refused sync releases the exclusion of each recorded link the owner replaced, with a folder, a file or another link, and of no other", async () => {
  for (const id of ["alpha", "beta", "gamma", "delta"]) write(join(office, `skills/${id}/SKILL.md`));
  const settings = { sources: [{ folder: "skills" }], enabled: ["alpha", "beta", "gamma", "delta"] };

  await sync(settings);
  rmSync(link("alpha"));
  write(join(link("alpha"), "SKILL.md"), "the owner's\n");
  rmSync(link("beta"));
  write(link("beta"), "a file\n");
  rmSync(link("gamma"));
  symlinkSync("../../nowhere", link("gamma"));

  await expect(sync(settings)).rejects.toThrow("no skill delivery changed: .agents/skills/alpha is already there");
  expect(updates).toEqual([{ remove: [".agents/skills/alpha", ".agents/skills/beta", ".agents/skills/gamma"] }]);
  expect(readlinkSync(link("delta"))).toBe("../../skills/delta");
  expect(readlinkSync(link("gamma"))).toBe("../../nowhere");
});

test("the receipt accepts only deliveries at .agents/skills/<id>", async () => {
  write(join(office, "skills/alpha/SKILL.md"));
  const settings = { sources: [{ folder: "skills" }], enabled: ["alpha"] };

  for (const links of [{ "../outside": "x" }, { ".agents/skills/alpha/inner": "x" }, { ".agents/skills/Alpha": "x" }, { ".agents/skills/alpha": 1 }]) {
    write(join(office, receiptFile), JSON.stringify({ links }));
    await expect(sync(settings)).rejects.toThrow(`${receiptFile} isn't a record of skill links and copies in .agents/skills/; move it aside`);
  }

  rmSync(join(office, receiptFile));
  mkdirSync(join(office, receiptFile));
  await expect(sync(settings)).rejects.toThrow(`${receiptFile} isn't a file; move it aside`);
  expect(existsSync(link("alpha"))).toBe(false);
});

/** A managed link the owner then replaced with a folder of their own, next to one still managed. */
async function replacedByOwner(sources: Given["sources"]) {
  write(join(office, "skills/alpha/SKILL.md"));
  write(join(office, "skills/beta/SKILL.md"));
  await sync({ sources: [{ folder: "skills" }], enabled: ["alpha", "beta"] });
  rmSync(link("alpha"));
  write(join(link("alpha"), "SKILL.md"), "the owner's\n");
  updates = [];

  return { sources: [{ folder: "skills" }, ...sources], enabled: ["alpha", "beta"] };
}

test("a sync whose Git source can't be fetched still releases only the exclusion of a link the owner replaced, then stops", async () => {
  const repo = join(root, "gone");
  const settings = await replacedByOwner([{ repo, ref: "c".repeat(40), skills: [{ name: "review", path: "review" }] }]);

  await expect(sync(settings)).rejects.toThrow(`could not fetch cccccccccccc from ${repo}; check the repository URL, the commit, the network and this machine's git credentials; stopped excluding /.agents/skills/alpha`);
  expect(updates).toEqual([{ remove: [".agents/skills/alpha"] }]);
  expect(readFileSync(join(link("alpha"), "SKILL.md"), "utf8")).toBe("the owner's\n");
  expect(readlinkSync(link("beta"))).toBe("../../skills/beta");
});

test("an update whose track or checkout fails still releases only the exclusion of a link the owner replaced, then stops with the pin left", async () => {
  const first = commit("repo", { "review/SKILL.md": "one\n" });
  const repo = join(root, "repo");
  const source = (track: string) => ({ repo, ref: first, track, skills: [{ name: "review", path: "review" }] });
  const out = spyOn(console, "log").mockImplementation(() => undefined);

  try {
    const missing = command("skills update", await replacedByOwner([source("missing")]));

    expect(() => missing.found.run?.(missing.inputs)).toThrow(`${repo}: ${repo} has no branch missing; pin left at ${first.slice(0, 12)}; stopped excluding /.agents/skills/alpha`);
    expect(updates).toEqual([{ remove: [".agents/skills/alpha"] }]);

    // The track's new commit has a folder there that isn't its checkout.
    const second = commit("repo", { "review/SKILL.md": "two\n" });

    mkdirSync(join(office, checkoutFolder(repo, second)), { recursive: true });
    updates = [];
    const occupied = command("skills update", { ...missing.inputs.settings, sources: [{ folder: "skills" }, source("main")] });

    expect(() => occupied.found.run?.(occupied.inputs)).toThrow(`${checkoutFolder(repo, second)} isn't a checkout of ${second.slice(0, 12)}; remove it and sync again; stopped excluding /.agents/skills/alpha`);
    expect(updates).toEqual([{ remove: [".agents/skills/alpha"] }]);
  } finally {
    out.mockRestore();
  }

  expect(readFileSync(join(link("alpha"), "SKILL.md"), "utf8")).toBe("the owner's\n");
  expect(readlinkSync(link("beta"))).toBe("../../skills/beta");
});

/** Every path under `dir` with its kind, size and modification time. */
function tree(dir: string): string[] {
  return execFileSync("find", [dir, "-printf", "%y %p %s %T@\n"], { encoding: "utf8" }).split("\n").sort();
}

test("check reports a cached checkout at the wrong commit, even with the same folders, without fetching or writing", async () => {
  const first = commit("repo", { "review/SKILL.md": "one\n" });
  const second = commit("repo", { "review/SKILL.md": "two\n" });
  const repo = join(root, "repo");
  const settings = { sources: [{ repo, ref: first, skills: [{ name: "review", path: "review" }] }], enabled: ["review"] };

  await sync(settings);
  ensureCheckout(office, repo, second);
  rmSync(join(office, checkoutFolder(repo, first)), { recursive: true });
  execFileSync("mv", [join(office, checkoutFolder(repo, second)), join(office, checkoutFolder(repo, first))]);
  rmSync(repo, { recursive: true });
  const before = tree(office);

  expect(await definition.check?.({ ...syncInputs(settings).inputs, host })).toContainEqual({ level: "failed", message: `${checkoutFolder(repo, first)} isn't a checkout of ${first.slice(0, 12)}; remove it and sync again` });
  expect(tree(office)).toEqual(before);
});

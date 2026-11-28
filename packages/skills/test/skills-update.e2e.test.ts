// Git skill pins in the compiled office: plain sync never moves one, `office skills update` and
// `office refresh` do, through the package's scalar edit of its own settings, and relink at once.
import { expect, test } from "bun:test";
import { readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../../src/git.ts";
import { definitionFixture } from "../../../test/support/package-definition.fixture.ts";

const { root, write, read, commit, fixture } = definitionFixture({ second: false });

const skill = (text: string) => `---\nname: x\ndescription: ${text}\n---\n${text}\n`;

function repository(name: string) {
  const repo = join(root, name);

  git(["init", "-q", "-b", "main", repo]);

  return repo;
}

test("plain sync keeps pins, offline once fetched; update moves tracked branch and tag pins with a review line, relinks, and changes only those scalars", () => {
  const f = fixture("tracked");
  git(["init", "-q", f.dir]);
  write(join(f.dir, "skills/alpha/SKILL.md"), skill("alpha"));
  const branchRepo = repository("tracked-branch");
  const tagRepo = repository("tracked-tags");
  write(join(branchRepo, "review/SKILL.md"), skill("review one"));
  const branchOne = commit(branchRepo);
  write(join(tagRepo, "skills/lint/SKILL.md"), skill("lint one"));
  const tagOne = commit(tagRepo);
  git(["tag", "v1.0.0"], tagRepo);

  const entry = `  - name: skills
    settings:
      sources:
        # The handbook follows main.
        - repo: ${branchRepo}
          ref: ${branchOne} # moved by office skills update
          track: main
          skills: [{name: review, path: review}]
        - {repo: ${tagRepo}, ref: ${tagOne}, track: 'v1.*', skills: [{name: lint, path: skills/lint}]}
        - folder: skills
      enabled: [review, lint]
`;

  f.select(entry);
  f.cli(0, "sync");
  const yaml = read(join(f.dir, "office.yaml"));
  const review = join(f.dir, ".agents/skills/review/SKILL.md");

  // Upstream advances: sync delivers the pinned commits, and needs no remote once they are fetched.
  write(join(branchRepo, "review/SKILL.md"), skill("review two"));
  const branchTwo = commit(branchRepo);
  write(join(tagRepo, "skills/lint/SKILL.md"), skill("lint two"));
  const tagTwo = commit(tagRepo);
  git(["tag", "v1.1.0"], tagRepo);
  renameSync(branchRepo, `${branchRepo}.away`);
  expect(f.cli(0, "sync")).not.toContain("package skills:");
  expect(read(join(f.dir, "office.yaml"))).toBe(yaml);
  expect(readFileSync(review, "utf8")).toBe(skill("review one"));
  renameSync(`${branchRepo}.away`, branchRepo);

  // Enabled since the last sync: update links it, and Git leaves the new link out at once.
  write(join(f.dir, "office.yaml"), yaml.replace("enabled: [review, lint]", "enabled: [review, lint, alpha]"));
  const updated = f.cli(0, "skills", "update");

  expect(updated).toContain("linked .agents/skills/alpha (folder skills)");
  expect(updated).toContain("excluded /.agents/skills/alpha from commits (info/exclude)");
  expect(git(["check-ignore", ".agents/skills/alpha"], f.dir)).toBe(".agents/skills/alpha");

  expect(updated).toContain(`${branchRepo}: pinned ${branchOne.slice(0, 12)} → ${branchTwo} (branch main); skills review`);
  expect(updated).toContain(`${tagRepo}: pinned ${tagOne.slice(0, 12)} → ${tagTwo} (tag v1.1.0); skills lint`);
  expect(updated).toContain(`copied skill .agents/skills/review (${branchRepo} at ${branchTwo.slice(0, 12)})`);
  expect(read(join(f.dir, "office.yaml"))).toBe(yaml.replace(branchOne, branchTwo).replace(tagOne, tagTwo).replace("enabled: [review, lint]", "enabled: [review, lint, alpha]"));
  expect(readFileSync(review, "utf8")).toBe(skill("review two"));
  expect(updated).toContain(`copied skill .agents/skills/lint (${tagRepo} at ${tagTwo.slice(0, 12)})`);
  expect(f.cli(0, "skills", "update")).toContain(`already at ${branchTwo.slice(0, 12)}`);

  // A candidate without a named skill moves nothing and fails the command.
  git(["rm", "-qr", "review"], branchRepo);
  write(join(branchRepo, "README.md"), "moved\n");
  const branchThree = commit(branchRepo);
  const refused = f.cli(1, "skills", "update");

  expect(refused).toContain(`skill review from ${branchRepo} at ${branchThree.slice(0, 12)}: review has no SKILL.md file at that commit`);
  expect(refused).toContain(`pin left at ${branchTwo.slice(0, 12)} and its skills unchanged`);
  expect(read(join(f.dir, "office.yaml"))).toContain(`ref: ${branchTwo} # moved by office skills update`);
  expect(readFileSync(review, "utf8")).toBe(skill("review two"));
}, 60_000);

test("refresh runs skills update when the package is selected and stops on its failure; without it the step is skipped; help follows the selection", () => {
  const f = fixture("refresh");
  const repo = repository("refresh-skills");
  write(join(repo, "review/SKILL.md"), skill("review one"));
  const one = commit(repo);
  const entry = (pin: string) => `  - name: skills\n    settings: {sources: [{repo: ${repo}, ref: ${pin}, track: main, skills: [{name: review, path: review}]}], enabled: [review]}\n`;

  // Without the package, `skills` is no command of the CLI's own, and refresh has nothing to update.
  expect(f.cli(2, "skills", "update")).toContain("skills update");
  expect(f.cli(0, "--help")).not.toContain("skills list");
  expect(f.cli(1, "refresh")).toContain("skills: done: the skills package isn't selected");

  // Selected but not synced since: refresh doesn't sync it first; its update can't run, so refresh stops.
  f.select(entry(one));
  const unsynced = f.cli(1, "refresh");

  expect(unsynced).toContain("package skills: not synced yet; run office sync");
  expect(unsynced).toContain("office skills update failed, so refresh stopped");
  f.cli(0, "sync");
  expect(f.cli(0, "--help")).toMatch(/skills list +List the standalone skills/);
  write(join(repo, "review/SKILL.md"), skill("review two"));
  const two = commit(repo);
  const refreshed = f.cli(1, "refresh");

  expect(refreshed).toContain(`pinned ${one.slice(0, 12)} → ${two}`);
  expect(refreshed).toContain("skills: done: office skills update finished");
  expect(refreshed).toContain("sync:");
  expect(readFileSync(join(f.dir, ".agents/skills/review/SKILL.md"), "utf8")).toBe(skill("review two"));

  // A failed update stops refresh before its sync.
  renameSync(repo, `${repo}.away`);
  const stopped = f.cli(1, "refresh");

  expect(stopped).toContain("could not list");
  expect(stopped).toContain("office skills update failed, so refresh stopped");
  expect(stopped).not.toContain("sync:");
  expect(read(join(f.dir, "office.yaml"))).toContain(`ref: ${two}`);
}, 60_000);

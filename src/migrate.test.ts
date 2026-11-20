import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { sync } from "./commands/sync.ts";
import { appFolders } from "./commands/apps.ts";
import { officeInstructions } from "../packages/office/plugin/instructions.ts";
import { git } from "./git.ts";
import { editedOfficeSkill, withoutExecutorEntry } from "./migrate.ts";
import { loadOffice, withoutItem } from "./office.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-migrate-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const executorEntry = `      // The office's Executor, which holds every service account. In the container,
      // OFFICE_EXECUTOR_URL is http://executor:4400.
      "office-executor": {
        "type": "remote",
        "url": "{env:OFFICE_EXECUTOR_URL}{file:office-executor.url}/mcp?elicitation_mode=browser",
        "oauth": false,
        "headers": { "Authorization": "Bearer {env:OFFICE_EXECUTOR_TOKEN}{file:office-executor.token}" },
      },
`;

const browserEntry = `      // Browser automation.
      "agent-browser": {
        "type": "local",
        "command": ["agent-browser", "mcp"],
      },
`;

const config = (servers: string) => `{\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {\n    "servers": {\n${servers}    },\n  },\n}\n`;

test("sync moves shared and desk Executor apps before scaffolding; instructions show each app once in scope", async () => {
  write(join(dir, "office.yaml"), "name: demo\ndesks: { work: {}, other: { app: false } }\nexecutor: { catalog_apps: [github, calendar] }\n");
  write(join(dir, "executor/apps/github/.office-catalog"), "github\n");
  write(join(dir, "executor/apps/github/package.json"), '{"description":"Browse issues."}');
  write(join(dir, "executor/notes"), "keep");
  write(join(dir, "work/executor/apps/work/package.json"), '{"description":"Save reports."}');
  write(join(dir, "work/executor/apps/work/index.ts"), "// customized");
  write(join(dir, "other/executor/apps/custom/package.json"), '{"executor":{"title":"Other desk tools"}}');
  const office = loadOffice(dir);

  expect(() => appFolders(office)).toThrow("run office sync");
  mkdirSync(join(dir, "other/executor-apps"));
  await expect(sync(office)).rejects.toThrow("both other/executor/apps and other/executor-apps exist");
  expect(existsSync(join(dir, "executor/apps/github/.office-catalog"))).toBe(true);
  rmSync(join(dir, "other/executor-apps"), { recursive: true });
  await sync(office);
  expect(await sync(office)).toEqual([]);
  expect(appFolders(office).map(app => [app.slug, app.adopted])).toEqual([["github", true], ["work", false], ["custom", false]]);
  expect(readFileSync(join(dir, "work/executor-apps/work/index.ts"), "utf8")).toBe("// customized");
  expect(readFileSync(join(dir, "executor/notes"), "utf8")).toBe("keep");
  expect(existsSync(join(dir, "work/executor"))).toBe(false);
  const desk = officeInstructions(join(dir, "work"));

  expect(desk.match(/github/g)).toHaveLength(1);
  expect(desk).toContain("`executor-apps/github/`: Browse issues.");
  expect(desk).toContain("`calendar` (catalog)");
  expect(desk).toContain("`work/executor-apps/work/`: Save reports.");
  expect(desk).not.toContain("Other desk tools");
  expect(officeInstructions(dir)).toContain("`other/executor-apps/custom/`: Other desk tools");
});

test("the office-executor entry goes with its template comment and comma, leaving every other character of opencode.jsonc", () => {
  expect(withoutExecutorEntry(config(`${executorEntry}${browserEntry}`))).toBe(config(browserEntry));
  // Last, without a comma of its own: the entry before it keeps its comma, which JSONC allows.
  expect(withoutExecutorEntry(config(`${browserEntry}${executorEntry.replace(/},\n$/, "}\n")}`))).toBe(config(browserEntry));
  expect(withoutExecutorEntry(config(`${executorEntry}${executorEntry}`))).toBeUndefined();
});

test("an item leaves a block list with its line, and the comment above stays", () => {
  const text = "name: t\nskills:\n  # Enabled everywhere.\n  enabled:\n    - office\n    - other # kept\n";

  expect(withoutItem(text, ["skills", "enabled"], "office")).toBe("name: t\nskills:\n  # Enabled everywhere.\n  enabled:\n    - other # kept\n");
});

test("one sync moves an office from the earlier layout, a second changes nothing, and an edited office skill stays", async () => {
  const office = join(dir, "office");
  const knowledge = join(office, "packages/knowledge");

  write(
    join(office, "office.yaml"),
    [
      "name: t",
      "skills:",
      "  enabled: [office, other]",
      "packages:",
      "  # Lists the articles.",
      "  - name: knowledge",
      "    repo: https://github.com/meeaster/opencode-office.git # the tool",
      "    path: packages/knowledge",
      "    ref: 0123456789abcdef0123456789abcdef01234567",
      "  # Next.",
      "",
    ].join("\n"),
  );
  write(join(office, "skills/other/SKILL.md"), "---\nname: other\ndescription: Other.\n---\n");
  write(join(office, "skills/office/SKILL.md"), "---\nname: office\ndescription: The office's own version.\n---\n");
  write(join(office, ".opencode/opencode.jsonc"), config(`${executorEntry}${browserEntry}`));
  write(join(office, ".opencode/plugins/office/index.js"), "// @bun\n// The office tool's office plugin, bundled from its plugins/office/. `office sync` replaces this copy; change the tool's.\n");
  const manifest = "name: knowledge\ndescription: An older copy.\n";
  const files = { "package.yaml": new Bun.CryptoHasher("sha256").update(manifest).digest("hex") };

  write(join(knowledge, "package.yaml"), manifest);
  write(join(knowledge, ".source.json"), JSON.stringify({ repo: "https://github.com/meeaster/opencode-office.git", path: "packages/knowledge", ref: "0123456789abcdef0123456789abcdef01234567", commit: "0123456789abcdef0123456789abcdef01234567", files }));
  write(join(knowledge, ".settings.json"), "{}\n");
  // The template file it already handled, which the office deleted: it must stay deleted.
  write(join(knowledge, ".template.json"), '[\n  "knowledge/README.md"\n]\n');
  mkdirSync(join(office, ".opencode/skills"), { recursive: true });
  symlinkSync("../../skills/office", join(office, ".opencode/skills/office"));
  symlinkSync("../../packages/knowledge/plugin", join(office, ".opencode/plugins/knowledge"));
  git(["init", "--quiet", office]);

  const changes = await sync(loadOffice(office));

  expect(changes).toEqual(
    expect.arrayContaining([
      "made knowledge a built-in package in office.yaml: dropped its repo, path and ref, so it follows this office executable",
      editedOfficeSkill,
      "removed the office-executor MCP server from .opencode/opencode.jsonc; the office package registers it now",
      "removed .opencode/plugins/office/, the copy of the tool's plugin earlier releases of office wrote; the office package's plugin replaces it",
      "moved packages/knowledge/ to .office/packages/knowledge/, where packages pulled into the office live (copied from https://github.com/meeaster/opencode-office.git)",
      expect.stringMatching(/^updated \.office\/packages\/knowledge from https:\/\/github\.com\/meeaster\/opencode-office\.git packages\/knowledge at 0123456789ab /),
      "linked .opencode/plugins/office",
      // The earlier link is Office's by its target; the package moved, so a running server needs a restart.
      "relinked .opencode/plugins/knowledge to ../../.office/packages/knowledge/plugin; restart OpenCode to pick up knowledge: a running server keeps loading a plugin from where it first found it",
    ]),
  );
  expect(readFileSync(join(office, "office.yaml"), "utf8")).toBe(
    ["name: t", "skills:", "  enabled: [office, other]", "packages:", "  # Lists the articles.", "  - name: knowledge", "  # Next.", ""].join("\n"),
  );
  expect(readFileSync(join(office, ".opencode/opencode.jsonc"), "utf8")).toBe(config(browserEntry));
  expect(readlinkSync(join(office, ".opencode/plugins/knowledge"))).toBe("../../.office/packages/knowledge/plugin");
  expect(JSON.parse(readFileSync(join(office, ".office/packages/knowledge/.template.json"), "utf8"))).toEqual(["knowledge/AGENTS.md", "knowledge/README.md", "knowledge/origins.md"]);
  expect(readFileSync(join(office, "knowledge/AGENTS.md"), "utf8")).toContain("knowledge-base-format: 2");
  expect(existsSync(join(office, "knowledge/origins.md"))).toBe(true);
  expect(existsSync(join(office, "knowledge/README.md"))).toBe(false);
  expect(existsSync(join(office, "skills/office/SKILL.md"))).toBe(true);
  expect(await sync(loadOffice(office))).toEqual([editedOfficeSkill]);
});

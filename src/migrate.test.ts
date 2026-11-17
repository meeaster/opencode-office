import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { sync } from "./commands/sync.ts";
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
  write(join(office, ".opencode/plugins/office/index.js"), "// the old copy\n");
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
      "linked .opencode/plugins/knowledge",
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

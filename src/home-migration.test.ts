import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrateHome } from "./home-migration.ts";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "office-home-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

test("stored folders under /home/assistant move to the home, keyed rows included, once", () => {
  const path = join(home, ".local/share/opencode/opencode.db");

  mkdirSync(join(home, ".local/share/opencode"), { recursive: true });

  const seed = new Database(path);

  seed.run("create table project (id text primary key, worktree text not null)");
  seed.run("create table project_directory (project_id text, directory text, primary key (project_id, directory))");
  seed.run("create table session_v2 (id text primary key, directory text not null, path text, title text)");
  seed.run("insert into project values ('p', '/home/assistant/workspace'), ('h', '/home/assistant'), ('t', '/tmp'), ('x', '/home/assistantx')");
  seed.run("insert into project_directory values ('p', '/home/assistant/workspace')");
  seed.run("insert into session_v2 values ('s', '/home/assistant/workspace/desk', 'desk', 'in /home/assistant/workspace')");
  seed.close();

  mkdirSync(join(home, ".claude/projects/-home-assistant-workspace-desk"), { recursive: true });
  mkdirSync(join(home, ".claude/projects/-tmp"), { recursive: true });

  expect(migrateHome(home)).toEqual([
    `moved 4 stored folders in ${path} from /home/assistant to ${home} (backup ${path}.before-home-move)`,
    `renamed ${join(home, ".claude/projects/-home-assistant-workspace-desk")} to ${home.replaceAll("/", "-")}-workspace-desk`,
  ]);

  const db = new Database(path);

  expect(db.query("select id, worktree from project order by id").all()).toEqual([
    { id: "h", worktree: home },
    { id: "p", worktree: `${home}/workspace` },
    { id: "t", worktree: "/tmp" },
    { id: "x", worktree: "/home/assistantx" },
  ]);
  expect(db.query("select directory from project_directory").all()).toEqual([{ directory: `${home}/workspace` }]);
  // Only folder columns move; text that mentions the old home stays as it was written.
  expect(db.query("select directory, path, title from session_v2").all()).toEqual([{ directory: `${home}/workspace/desk`, path: "desk", title: "in /home/assistant/workspace" }]);
  db.close();

  expect(existsSync(`${path}.before-home-move`)).toBe(true);
  expect(existsSync(join(home, ".claude/projects/-tmp"))).toBe(true);
  expect(migrateHome(home)).toEqual([]);
});

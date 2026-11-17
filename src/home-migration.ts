// The container user was `assistant` with home /home/assistant before it became `office`. The
// home volume keeps absolute paths from then: OpenCode's projects and sessions name their folders,
// and Claude Code files its sessions by working folder. The entrypoint runs this before OpenCode
// starts, so those move to /home/office and existing sessions stay listed and resumable. It changes
// nothing once nothing names the old home.
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

const oldHome = "/home/assistant";

/** OpenCode's database, with every column holding an absolute folder rewritten. */
function migrateOpencode(home: string): string[] {
  const path = join(home, ".local/share/opencode/opencode.db");

  if (!existsSync(path)) return [];

  const db = new Database(path);

  try {
    // By column name rather than a fixed list of tables, so a newer OpenCode schema is covered too.
    const columns = db
      .query<{ table: string; column: string }, []>(
        "select m.name as \"table\", c.name as \"column\" from sqlite_master m join pragma_table_info(m.name) c where m.type = 'table' and c.name in ('directory', 'worktree')",
      )
      .all();

    const under = (column: string) => `"${column}" = ?1 or "${column}" like ?1 || '/%'`;
    const counts = columns.map(({ table, column }) => db.query<{ n: number }, [string]>(`select count(*) as n from "${table}" where ${under(column)}`).get(oldHome)?.n ?? 0);
    const total = counts.reduce((sum, n) => sum + n, 0);

    if (total === 0) return [];

    const backup = `${path}.before-home-move`;

    // The first move's backup holds the original; VACUUM INTO refuses an existing file anyway.
    if (!existsSync(backup)) db.run("vacuum into ?", [backup]);

    db.transaction(() => {
      for (const { table, column } of columns) {
        // OR REPLACE: a folder can be part of a key (project_directory, worktree), where the new
        // path may already have a row.
        db.run(`update or replace "${table}" set "${column}" = ?2 || substr("${column}", length(?1) + 1) where ${under(column)}`, [oldHome, home]);
      }
    })();

    return [`moved ${total} stored folders in ${path} from ${oldHome} to ${home} (backup ${backup})`];
  } finally {
    db.close();
  }
}

/** Claude Code's per-folder session stores, named by the folder with each `/` as `-`. */
function migrateClaude(home: string): string[] {
  const projects = join(home, ".claude/projects");
  const oldPrefix = oldHome.replaceAll("/", "-");
  const newPrefix = home.replaceAll("/", "-");

  if (!existsSync(projects)) return [];

  return readdirSync(projects)
    .filter((name) => name === oldPrefix || name.startsWith(`${oldPrefix}-`))
    .map((name) => {
      const target = `${newPrefix}${name.slice(oldPrefix.length)}`;

      if (existsSync(join(projects, target))) return `left ${join(projects, name)}: ${target} already exists`;

      renameSync(join(projects, name), join(projects, target));

      return `renamed ${join(projects, name)} to ${target}`;
    });
}

/** Moves what the home volume stores under the old home to `home`; returns one line per change. */
export function migrateHome(home: string): string[] {
  return [...migrateOpencode(home), ...migrateClaude(home)];
}

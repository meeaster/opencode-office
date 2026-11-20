import type { PackageContext } from "./package-context.ts";

export default {
  name: "office",
  description: "What every office needs from OpenCode, given by its plugin; the guidance for a session's folder, the office skill and the office-executor MCP server; and the tools the office CLI itself runs.",
  settings_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      ignore_claude_synced_skills: {
        description: "Whether the office's sessions leave out the skills in ~/.claude/skills/synced, the folder the Claude desktop app syncs account skills into. On unless an office sets it to false; other skills under ~/.claude/skills still load either way",
        type: "boolean",
        default: true,
      },
      ignore_skill_folders: {
        description: "More folders outside the office whose skills its sessions don't get, while other skills beside them still load. They add to the folder ignore_claude_synced_skills covers. Each is an absolute path, one starting with ~ (the home of the server the sessions run on), or one relative to the office root. Every skill found in them is removed from the office's sessions, including one added later; a skill with the ID of one a package of the office provides is left in place",
        type: "array",
        items: { type: "string", minLength: 1 },
        uniqueItems: true,
        default: [],
      },
    },
  },
  // CLI build-time floors, also used by sync to maintain machine.packages.toml.
  tools: { sops: "3.13.3", age: "1.3.2", gh: "2.104.0", "pre-commit": "4.7.0" },
  cron_setup: true,
  setup(ctx: PackageContext) {
    if (!ctx.cron.mode) return;

    ctx.cron.job("update-references", { schedule: "0 6 * * *", script: "scripts/update-references.sh" });
    ctx.cron.job("upgrade-tools", { schedule: "30 6 * * *", script: "scripts/upgrade-tools.sh" });

    if (ctx.cron.mode === "managed-host") {
      ctx.cron.job("update-agent-clis", { schedule: "30 7 * * *", script: "scripts/update-agent-clis.sh" });
    } else {
      ctx.cron.job("update-agent-clis", false);
    }
  },
};

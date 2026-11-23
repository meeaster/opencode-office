import { cron } from "@office/cron";
import { Package } from "@office/sdk";
import { requirements } from "@office/tooling/requirements";
import { floors } from "./floors.ts";

export default Package.define({
  settings: {
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
  setup(ctx) {
    for (const [name, minimumVersion] of Object.entries(floors)) ctx.add(requirements, { name, minimumVersion });
    cron.add(ctx, { name: "update-references", schedule: "0 6 * * *", script: "scripts/update-references.sh" });
    cron.add(ctx, { name: "upgrade-tools", schedule: "30 6 * * *", script: "scripts/upgrade-tools.sh" });
    cron.add(ctx, { name: "update-agent-clis", schedule: "30 7 * * *", script: "scripts/update-agent-clis.sh", when: "managed-host" });
  },
});

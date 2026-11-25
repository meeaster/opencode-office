import { Package } from "@office/sdk";
import { skills } from "@office/skills";
import type definition from "./office.ts";

export default Package.integration<typeof definition>()({
  setup(ctx) {
    if (ctx.settings.skills !== false) skills.add(ctx, { directory: "skills/review-checklist" });
  },
});

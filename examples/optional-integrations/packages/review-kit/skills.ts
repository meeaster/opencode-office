import { Package } from "@office/sdk";
import { skills } from "@office/skills";
import type definition from "./office.ts";

export default Package.integration<typeof definition>()({
  setup(ctx) {
    skills.add(ctx, { directory: "skills/review-checklist" });
  },
});

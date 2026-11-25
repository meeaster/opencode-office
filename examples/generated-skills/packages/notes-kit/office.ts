import { Package } from "@office/sdk";
import { skills } from "@office/skills";

export default Package.define({
  setup(ctx) {
    skills.add(ctx, { directory: "skills/meeting-notes" });
  },
});

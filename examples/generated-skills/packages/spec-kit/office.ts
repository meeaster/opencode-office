import { execFileSync } from "node:child_process";
import { Package } from "@office/sdk";
import { skills } from "@office/skills";
import { tools } from "@office/tools";

export default Package.define({
  setup(ctx) {
    const cli = tools.require(ctx, { name: "npm:spec-cli", minimum: "1.4.0", bin: "spec" });

    skills.sources.generated(ctx, {
      id: "spec",
      tool: cli,
      revision: "1",
      inputs: () => ({ profile: process.env.SPEC_PROFILE ?? "default" }),
      generate({ executable, output, inputs }) {
        execFileSync(executable, ["skills", "--profile", inputs.profile, "--out", output]);
      },
    });
  },
});

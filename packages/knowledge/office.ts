import { opencode } from "@office/opencode";
import { Package } from "@office/sdk";
import { seeds } from "@office/seeds";

export default Package.define({
  setup(ctx) {
    opencode.plugins.add(ctx, { directory: "plugin" });
    seeds.add(ctx, { destination: "knowledge", source: "seed/knowledge" });
  },
});

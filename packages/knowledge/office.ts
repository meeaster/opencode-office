import { Package } from "@office/sdk";
import { seeds } from "@office/seeds";

export default Package.define({
  setup(ctx) {
    seeds.add(ctx, { destination: "knowledge", source: "seed/knowledge" });
  },
});

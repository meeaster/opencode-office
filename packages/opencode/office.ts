import { Package } from "@office/sdk";
import { opencode } from "./handles.ts";

export default Package.define({
  setup(ctx) {
    ctx.registry(opencode.plugins);
    ctx.registry(opencode.panels);
  },
});

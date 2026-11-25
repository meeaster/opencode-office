import { Package } from "@office/sdk";
import { tools } from "./handles.ts";

export default Package.define({
  setup(ctx) {
    ctx.registry(tools.requirements);
    ctx.registry(tools.providers);
  },
});

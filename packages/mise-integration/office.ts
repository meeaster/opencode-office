import { Package } from "@office/sdk";
import { installs, recipes, tasks } from "./claims.ts";

export default Package.define({
  setup(ctx) {
    ctx.registry(tasks);
    ctx.registry(installs);
    ctx.registry(recipes);
  },
});

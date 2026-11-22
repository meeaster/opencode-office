import type { PackageContext } from "@office/office/context";
import { installs, recipes, tasks } from "./claims.ts";

export default {
  name: "mise-integration",
  description: "Deliver namespaced tasks, host installs and opt-in native system recipes to mise.",
  setup(ctx: PackageContext) {
    ctx.collection(tasks);
    ctx.collection(installs);
    ctx.collection(recipes);
  },
};

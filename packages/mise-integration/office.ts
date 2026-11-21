import type { PackageContext } from "../office/package-context.ts";
import { installs, recipes, tasks } from "./exports/claims.ts";

export default {
  name: "mise-integration",
  description: "Deliver namespaced tasks, host installs and opt-in native system recipes to mise.",
  setup(ctx: PackageContext) {
    ctx.collection(tasks);
    ctx.collection(installs);
    ctx.collection(recipes);
  },
};

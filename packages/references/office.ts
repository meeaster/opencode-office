import type { PackageContext } from "../office/package-context.ts";
import { listing } from "./commands/list.ts";

export default {
  name: "references",
  description: "List the office's resolved reference checkouts and their sources.",
  setup(ctx: PackageContext) {
    ctx.command(listing);
  },
};

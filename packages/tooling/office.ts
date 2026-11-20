import type { PackageContext } from "../office/package-context.ts";
import { requirements } from "./requirements.ts";

export default {
  name: "tooling",
  description: "Collect the tested minimum versions of tools required by office packages.",
  setup(ctx: PackageContext) { ctx.collection(requirements); },
};

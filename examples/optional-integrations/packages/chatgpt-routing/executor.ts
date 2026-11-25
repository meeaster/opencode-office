import { apps } from "@office/mock-executor/apps";
import { Package } from "@office/sdk";
import type definition from "./office.ts";

export default Package.integration<typeof definition>()({
  setup(ctx) {
    const { routes, executor } = ctx.settings;

    if (!executor.app) return;
    ctx.add(apps, { app: executor.name, tools: routes.gmail === "executor" || routes.gmail === "both" ? [{ name: "gmail.search", readOnly: true }] : [] });
  },
});

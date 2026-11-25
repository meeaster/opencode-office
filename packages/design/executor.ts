import { apps } from "@office/executor/apps";
import { Package } from "@office/sdk";
import type definition from "./office.ts";

// The doop app, offered while the office routes Doop through Executor; office.ts refuses that route without executor.
export default Package.integration<typeof definition>()({
  setup(ctx) {
    if (ctx.settings.executor_app) apps.add(ctx, { directory: "executor-app" });
  },
});

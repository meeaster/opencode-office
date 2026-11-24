// Each statement here must fail to typecheck: src/optional-integrations-types.test.ts names the diagnostics.
import { apps } from "@office/mock-executor/apps";
import { Package } from "@office/sdk";
import { skills } from "@office/skills";
import type definition from "../packages/chatgpt-routing/office.ts";

export default Package.integration<typeof definition>()({
  setup(ctx) {
    ctx.add(apps, { app: ctx.settings.executor.name, tools: [{ name: "gmail.search", readOnly: "yes" }] });
    ctx.add(apps, { app: ctx.settings.rotues.gmail, tools: [] });
    skills.add(ctx, { folder: "skills/review" });
  },
});

export const policy = Package.define({
  settings: { type: "object", additionalProperties: false, properties: { executor: { type: "object", default: {}, properties: { app: { type: "boolean", default: false } } } } },
  integrations: { "@office/mock-executor": { requested: settings => settings.executer.app } },
});

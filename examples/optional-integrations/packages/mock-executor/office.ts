import { Package } from "@office/sdk";
import { apps } from "./apps.ts";

export default Package.define({
  setup(ctx) {
    ctx.registry(apps);
  },
  commands: {
    "mock-executor apps": { summary: "List the apps packages add, as JSON", result: ({ entries }) => JSON.stringify(entries(apps).map(entry => ({ owner: entry.owner, namespace: entry.namespace, ...entry.value }))) },
  },
});

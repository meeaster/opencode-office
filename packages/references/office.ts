import { Package } from "@office/sdk";
import { listReferences } from "./commands/list.ts";
import { repositories } from "./repositories.ts";

export default Package.define({
  commands: {
    "references list": { summary: "Show desired references and their claimants without fetching", result: listReferences },
  },
  setup(ctx) {
    ctx.registry(repositories);
  },
});

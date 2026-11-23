import { Package } from "@office/sdk";
import { diffCommand, settleCommand } from "./commands.ts";
import { seeds } from "./handles.ts";
import { applySeeds, seedProblems } from "./seeds.ts";

export default Package.define({
  committed: [".office/seeds/"],
  commands: {
    "seeds diff": {
      summary: "For a seeded file whose package changed its seed after you edited it, show what the package changed and what you changed; without a path, list them",
      usage: "[<path>]",
      run: diffCommand,
    },
    "seeds settle": {
      summary: "Record the package's current seed for a path as dealt with; the file is left as it is",
      usage: "<path>",
      run: settleCommand,
    },
  },
  setup(ctx) {
    ctx.registry(seeds);
  },
  sync({ office, entries }) {
    return applySeeds(office.dir, entries(seeds));
  },
  check({ office, entries }) {
    return seedProblems(office.dir, entries(seeds));
  },
});

import { type CommandInputs, type Entries, type ExecutorAccess, Package, type Problem } from "@office/sdk";

import { apps } from "./apps.ts";
import { adoptCatalog } from "./catalog.ts";
import { deploy, frameworkProblems, type Reporting } from "./deploy.ts";
import { appFolders } from "./inventory.ts";
import { ready } from "./ready.ts";
import { recordContributed, sessionText } from "./session.ts";

const settings = {
  type: "object",
  additionalProperties: false,
  properties: {
    catalog_apps: {
      type: "array",
      items: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
      uniqueItems: true,
      default: [],
      description: "Official Executor catalog apps, by catalog ID, that office apps deploy and office up install when missing",
    },
  },
} as const;

/** The office's Executor, or a plain failure naming what is missing. */
function required(executor: ExecutorAccess | undefined): ExecutorAccess {
  if (executor === undefined) throw new Error("the office has no Executor token, so the executor package can't reach Executor; office setup saves the office's key");

  return executor;
}

type Settings = { readonly catalog_apps: readonly string[] };

/** Every app source of the office, checked from files alone before any request. */
const inventory = ({ office, settings, entries }: { office: { dir: string }; settings: Settings; entries: Entries }) => appFolders(office.dir, settings.catalog_apps, entries(apps));

const terminal = (verbose: boolean): Reporting => ({ line: text => console.log(text), progress: text => verbose && console.error(text), verbose });

async function deployCommand(inputs: CommandInputs<Settings>) {
  const { settings, args, executor } = inputs;

  if (args.length > 1 || (args.length === 1 && args[0] !== "--verbose")) throw new Error("usage: office apps deploy [--verbose]");

  console.log(await deploy(required(executor), inventory(inputs), settings.catalog_apps, terminal(args[0] === "--verbose")));
}

export default Package.define({
  settings,
  commands: {
    "apps deploy": {
      summary: "Install missing catalog apps and deploy changed Executor apps: the office's executor-apps/ and those packages offer",
      usage: "[--verbose]",
      run: deployCommand,
    },
    "apps adopt": {
      summary: "Copy an installed catalog app's source into executor-apps/<catalog-id>",
      usage: "<catalog-id>",
      async run(inputs) {
        const { office, settings, args, executor } = inputs;

        if (args.length !== 1) throw new Error("usage: office apps adopt <catalog-id>");

        console.log(await adoptCatalog(office.dir, settings.catalog_apps, args[0], required(executor), inventory(inputs)));
      },
    },
  },
  setup(ctx) {
    ctx.registry(apps);
  },
  sync({ office, entries }) {
    recordContributed(office.dir, entries(apps));
  },
  session({ office, settings }) {
    return sessionText(office.dir, settings.catalog_apps);
  },
  async up(inputs) {
    const folders = inventory(inputs);
    const access = required(inputs.executor);
    const lines: string[] = [];

    await ready(access);
    lines.push(await deploy(access, folders, inputs.settings.catalog_apps, { line: text => lines.push(text), progress: () => {}, verbose: false }));

    return lines;
  },
  async check(inputs): Promise<Problem[]> {
    const { settings, executor } = inputs;

    // Without a token there is nothing to compare: office check reports the missing token itself.
    if (executor === undefined) return [];

    try {
      const { version, problems } = await frameworkProblems(executor, inventory(inputs), settings.catalog_apps);

      return problems.length === 0 ? [] : [{ level: "failed", message: `Executor serves apps@${version}: ${problems.join("; ")}; run office apps deploy` }];
    } catch (error) {
      return [{ level: "failed", message: `Executor apps: ${error instanceof Error ? error.message : String(error)}` }];
    }
  },
});

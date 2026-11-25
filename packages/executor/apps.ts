// What other packages import: the apps registry. A package offers an Executor app from its adapter
// for `@office/executor` with `apps.add(ctx, { directory: "executor-app" })`; the app deploys under
// the package's namespace, with its settings, which office attaches to the entry.
import { Registry, type RegistryEntry, type SetupContext } from "@office/sdk";

/** An app a package offers: a folder of its own holding the app's `package.json`. */
export type App = { directory: string };

function parse(input: RegistryEntry): App {
  const { directory, ...rest } = input;

  if (typeof directory !== "string" || directory === "") throw new Error("an Executor app is { directory }: a folder in the adding package");

  if (Object.keys(rest).length) throw new Error(`Executor app ${directory}: unknown key ${Object.keys(rest).join(", ")}; an app has only directory`);

  return { directory };
}

const registry = Registry.define<App>({ id: "executor.apps", parse });

/** The apps registry, with `add`, which offers one folder of the adding package as an Executor app. */
export const apps = {
  ...registry,
  add(ctx: Pick<SetupContext, "add">, app: App): void {
    ctx.add(registry, app);
  },
};

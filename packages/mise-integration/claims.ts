import { Registry, type RegistryEntry } from "@office/sdk";

export type Task = { name: string; script: string; description: string };

export type Install = Task & { destination: string; ready: string; executable: boolean };

export type Recipe = { name: string; setting: string; description: string; platforms: string[]; prepare?: string; verify?: string; bootstrap: string; ready: string[]; env: Record<string, string> };

function packagePath(path: string) {
  return /^[\w.-]+(?:\/[\w.-]+)*$/.test(path) && !path.split("/").includes("..");
}

function homePath(path: string) {
  return path.startsWith("~/") && packagePath(path.slice(2)) && !path.split("/").includes(".");
}

export const tasks = Registry.define<Task>({
  identity: "package",
  id: "mise-integration.tasks",
  parse({ name, script, description }: RegistryEntry): Task {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || typeof script !== "string" || !packagePath(script) || !/\.(sh|ts)$/.test(script) || typeof description !== "string" || !description.trim() || /[\r\n]/.test(description)) throw new Error(`invalid task ${name}`);

    return { name, script, description };
  },
});

export const installs = Registry.define<Install>({
  identity: "package",
  id: "mise-integration.installs",
  parse(input: RegistryEntry): Install {
    const task = tasks.parse(input);
    const { destination, ready, executable } = input;

    if (!task.script.endsWith(".ts") || typeof destination !== "string" || !homePath(destination) || typeof ready !== "string" || !homePath(ready) || typeof executable !== "boolean") throw new Error(`invalid host install ${task.name}`);

    return { ...task, destination, ready, executable };
  },
});

function strings(value: RegistryEntry[string]): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function variables(value: RegistryEntry[string]): value is Record<string, string> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(item => typeof item === "string");
}

export const recipes = Registry.define<Recipe>({
  identity: "package",
  id: "mise-integration.recipes",
  parse({ name, setting, description, platforms, prepare, verify, bootstrap, ready, env }: RegistryEntry): Recipe {
    if (typeof setting !== "string" || typeof description !== "string" || !strings(platforms) || (prepare !== undefined && typeof prepare !== "string") || (verify !== undefined && typeof verify !== "string") || typeof bootstrap !== "string" || !strings(ready) || !variables(env)) throw new Error(`invalid system recipe ${name}`);

    const recipe: Recipe = { name, setting, description, platforms, bootstrap, ready, env };

    if (prepare !== undefined) recipe.prepare = prepare;

    if (verify !== undefined) recipe.verify = verify;

    return recipe;
  },
});

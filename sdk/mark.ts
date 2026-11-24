// Which objects `Package.define` returned. Not exported to packages: only the office executable
// asks, through its own copy of this module.
import type { Integration } from "./index.ts";

const defined = new WeakSet<object>();

/** Records `definition` as made by `Package.define` and returns it. */
export function mark<Definition extends object>(definition: Definition): Definition {
  defined.add(definition);

  return definition;
}

/** Whether `value` is an object this module's `Package.define` returned. */
export function marked(value: unknown): boolean {
  return typeof value === "object" && value !== null && defined.has(value);
}

const integrations = new WeakSet<object>();

/** Records `integration` as made by `Package.integration` and returns it. */
export function markIntegration<Integration extends object>(integration: Integration): Integration {
  integrations.add(integration);

  return integration;
}

/** Whether `value` is an object this module's `Package.integration` returned. */
export function markedIntegration(value: unknown): value is Integration {
  return value instanceof Object && integrations.has(value);
}

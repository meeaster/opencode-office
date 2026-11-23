// Which objects `Package.define` returned. Not exported to packages: only the office executable
// asks, through its own copy of this module.
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

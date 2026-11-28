// Locate the JSON value in the source so changing the pin keeps all other bytes.
function propertyOffset(source: string, start: number, key: string): number | undefined {
  const tokens = /("(?:[^"\\]|\\.)*")(\s*:\s*)?|[[\]{}]/g;
  tokens.lastIndex = start + 1;
  let depth = 0;
  let offset: number | undefined;

  for (let token = tokens.exec(source); token !== null; token = tokens.exec(source)) {
    const [text, string, colon] = token;

    if (text === "}" && depth === 0) return offset;

    if (text === "{" || text === "[") depth++;

    if (text === "}" || text === "]") depth--;

    if (depth === 0 && colon !== undefined && JSON.parse(string) === key) offset = tokens.lastIndex;
  }

  return undefined;
}

/** Edits only the string value at `dependencies.apps`; a correct pin keeps its original spelling. */
export function withFramework(source: string, version: string, path: string) {
  JSON.parse(source);
  const root = source.search(/\S/);
  const dependencies = source[root] === "{" ? propertyOffset(source, root, "dependencies") : undefined;
  const offset = dependencies !== undefined && source[dependencies] === "{" ? propertyOffset(source, dependencies, "apps") : undefined;
  const value = /"(?:[^"\\]|\\.)*"/y;
  value.lastIndex = offset ?? 0;
  const token = offset === undefined ? null : value.exec(source);

  if (token === null) throw new Error(`${path} must declare dependencies.apps as a version string`);

  const previous: string = JSON.parse(token[0]);
  const text = previous === version ? source : source.slice(0, token.index) + JSON.stringify(version) + source.slice(value.lastIndex);

  return { text, previous };
}

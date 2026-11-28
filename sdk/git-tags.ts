/** A tag as `git ls-remote --tags` lists it: its name and the commit it points to. */
export type RemoteTag = { name: string; commit: string };

// A stable version at the end of a tag, after a prefix that ends in neither a digit nor a dot.
const stableTag = /^(?:.*[^0-9.])?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function compare(left: number[], right: number[]): number {
  for (const [index, part] of left.entries()) {
    if (part !== right[index]) return part > right[index] ? 1 : -1;
  }

  return 0;
}

/** The highest stable version matching `pattern`, and the number of matches. Ties use the lowest tag name in code-point order. */
export function highestTag(pattern: string, tags: readonly RemoteTag[]): { tag: RemoteTag; matched: number } | undefined {
  const glob = new RegExp(`^${pattern.split("*").map(part => part.replaceAll(/[.+?^${}()|[\]\\/]/g, "\\$&")).join(".*")}$`);
  let best: { tag: RemoteTag; version: number[] } | undefined;
  let matched = 0;

  for (const tag of tags) {
    const parts = stableTag.exec(tag.name);

    if (parts === null || !glob.test(tag.name)) continue;
    matched += 1;
    const version = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
    const order = best === undefined ? 1 : compare(version, best.version) || (tag.name < best.tag.name ? 1 : -1);

    if (order > 0) best = { tag, version };
  }

  return best === undefined ? undefined : { tag: best.tag, matched };
}

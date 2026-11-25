// Ordering the versions packages and offices name. It imports nothing, so a package's script or
// plugin can use it through `@office/tools/applied` as delivered.

// A version office can order: dotted numbers, optionally a `v` before them, a prerelease after a
// `-`, and build metadata after a `+`, which doesn't count. Every package's version is one
// (src/schema.ts); the office's line may be anything mise takes, such as "2" or "latest".
const orderable = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Compares dotted identifiers, numerically where both are numbers, a missing one first. */
function compareParts(left: string[], right: string[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const [a, b] = [left[index], right[index]];

    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;

    const order = /^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) - Number(b) : a < b ? -1 : a > b ? 1 : 0;

    if (order !== 0) return Math.sign(order);
  }

  return 0;
}

/**
 * Orders two versions SemVer-like: release numbers part by part (1.10 after 1.9, 1.2 before
 * 1.2.1), a prerelease before its release, build metadata ignored. Undefined when either isn't
 * such a version: office then doesn't guess, and keeps the office's line.
 */
export function compareToolVersions(left: string, right: string): number | undefined {
  const [a, b] = [orderable.exec(left), orderable.exec(right)];

  if (a === null || b === null) return undefined;

  const core = compareParts(a[1].split("."), b[1].split("."));

  if (core !== 0) return core;

  if (a[2] === undefined || b[2] === undefined) return a[2] === b[2] ? 0 : a[2] === undefined ? 1 : -1;

  return compareParts(a[2].split("."), b[2].split("."));
}

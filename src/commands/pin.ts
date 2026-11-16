// `office pin`: rewrites office.lock for the versions office.yaml asks for. A version the lock
// already holds, or the tool's own default, needs no network; any other is looked up on GitHub or
// the registry, which also confirms it exists.
import type { Office } from "../office.ts";
import { pinFor } from "../releases.ts";
import { type Lock, pinnedTools } from "../schema.ts";
import { defaultPins, lockFile, readLock, wantedVersion, writeLock } from "../versions.ts";

export async function pin(office: Office): Promise<string[]> {
  const before = readLock(office.dir);
  const lock: Lock = { ...defaultPins };
  const lines: string[] = [];

  for (const tool of pinnedTools) {
    const version = wantedVersion(office, tool);
    const held = before?.[tool];

    if (held?.version === version) lock[tool] = held;
    else if (defaultPins[tool].version === version) lock[tool] = defaultPins[tool];
    else lock[tool] = await pinFor(tool, version);

    if (held?.version !== lock[tool].version || held.digest !== lock[tool].digest) lines.push(`${tool} ${held?.version ?? "(none)"} → ${version} ${lock[tool].digest}`);
  }

  writeLock(office.dir, lock);

  return lines.length === 0 ? [`${lockFile} already matches office.yaml`] : lines.map((line) => `pinned ${line}`);
}

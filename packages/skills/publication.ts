// What office up does with a generated source beyond what sync does: generates a new generation
// when the key changed, and removes the source's earlier generations once one is published. Only
// generations the source recorded in its inventory are ever removed, and only inside its own
// `generations/` folder, each folder on the way checked to be a real one: an unowned folder beside
// them, another source's folder, a folder a link leads to, or anything else stays as it is. One up
// at a time does this in an office.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Declared, type Generation, generatedFolder, generationFolder, generationsFolder, newGenerationName, ownedFolder, type Published, readInventory, sourceFolder, writeGenerationRecord, writeInventory } from "./generation.ts";
import { skillId } from "./settings.ts";

/** The skill folders a generation holds: a real folder named by a skill ID holding a regular SKILL.md. Anything else in it isn't offered. */
export function admitted(folder: string): string[] {
  return readdirSync(folder).sort().filter(name => {
    if (!skillId.test(name) || !lstatSync(join(folder, name)).isDirectory()) return false;

    return lstatSync(join(folder, name, "SKILL.md"), { throwIfNoEntry: false })?.isFile() === true;
  });
}

/** Removes the recorded generations `remove` of source `id`, each a real folder in its own `generations/`, and their inventory lines. */
function removeRecorded(office: string, id: string, remove: readonly string[]): void {
  if (!ownedFolder(office, sourceFolder(id))) return;
  const recorded = readInventory(office, id);
  const there = ownedFolder(office, generationsFolder(id));

  for (const name of remove) {
    const folder = join(office, generationFolder(id, name));

    if (there && recorded.includes(name) && lstatSync(folder, { throwIfNoEntry: false })?.isDirectory()) rmSync(folder, { recursive: true });
  }

  writeInventory(office, id, recorded.filter(name => !remove.includes(name)));
}

/** Removes an unpublished generation of source `id` and its inventory line. */
export function discard(office: string, id: string, generation: string): void {
  removeRecorded(office, id, [generation]);
}

/**
 * Runs the source's generator into a fresh generation, recorded in the inventory before it is
 * created and created only where nothing was, then records its key and skill IDs in it and returns
 * what publishing it would publish. A failing generator leaves nothing and throws naming the source.
 */
export async function generate(office: string, { source, label }: Declared, next: Generation, runtimes: () => readonly string[]): Promise<Published> {
  const generation = newGenerationName(next.key);
  const output = join(office, generationFolder(source.id, generation));

  ownedFolder(office, generationsFolder(source.id), true);
  const recorded = readInventory(office, source.id);

  writeInventory(office, source.id, [...recorded, generation]);

  try {
    mkdirSync(output);
  } catch (error) {
    writeInventory(office, source.id, recorded);
    throw error;
  }

  try {
    await next.generate({ office, executable: next.executable, output, inputs: next.inputs, runtimes: runtimes() });
    const published = { key: next.key, generation, skills: admitted(output) };

    writeGenerationRecord(office, source.id, published);

    return published;
  } catch (error) {
    discard(office, source.id, generation);

    throw new Error(`${label}: its generator failed with ${source.tool.name} ${next.version}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** Removes source `id`'s recorded generations other than `published`; returns what it said. */
export function cleanup(office: string, id: string, published: string): string[] {
  const earlier = readInventory(office, id).filter(name => name !== published);

  if (earlier.length === 0) return [];
  removeRecorded(office, id, earlier);

  return [`generated source ${id}: removed ${earlier.length} earlier ${earlier.length === 1 ? "generation" : "generations"}`];
}

/** The office-relative lock one up holds while it generates, publishes and cleans up. */
export const lockFile = `${generatedFolder}/.lock`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The office-relative guard an up holds only while it takes over a lock whose process is gone. */
export const takeoverFile = `${lockFile}.takeover`;

const holderOf = (path: string) => Number.parseInt(readFileSync(path, "utf8"), 10);

function busy(holder: number): Error {
  return new Error(`another office up${Number.isInteger(holder) ? ` (process ${holder})` : ""} is generating skills in this office; wait for it and run office up again, or remove ${lockFile} if none is running`);
}

/**
 * Takes the office's generated-skills lock, a file naming this process made only where none was,
 * and returns its release. A lock whose process is gone is taken over only under the takeover
 * guard, made the same way, and only while the lock still names that process, so of two ups taking
 * over the same stale lock one acquires and the other finds the first's lock or guard and fails;
 * a lock held by a running process fails, naming it. `step` marks the takeover's steps for tests.
 */
export function acquire(office: string, step: (at: "stale" | "guarded") => void = () => {}): () => void {
  ownedFolder(office, generatedFolder, true);
  const path = join(office, lockFile);
  const take = () => writeFileSync(path, `${process.pid}\n`, { flag: "wx" });
  const release = () => rmSync(path, { force: true });

  try {
    take();

    return release;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const holder = holderOf(path);

  if (!Number.isInteger(holder) || holder <= 0 || alive(holder)) throw busy(holder);
  step("stale");
  const guard = join(office, takeoverFile);

  try {
    writeFileSync(guard, `${process.pid}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

    throw new Error(`another office up is taking over ${lockFile} in this office; wait for it and run office up again, or remove ${takeoverFile} if none is running`);
  }

  try {
    step("guarded");
    const now = existsSync(path) ? holderOf(path) : undefined;

    if (now !== undefined && now !== holder) throw busy(now);
    rmSync(path, { force: true });
    take();

    return release;
  } finally {
    rmSync(guard, { force: true });
  }
}

/** Runs `act` holding the office's generated-skills lock (acquire), so one up's cleanup can't remove another's candidate. */
export async function exclusively<T>(office: string, act: () => Promise<T>): Promise<T> {
  const release = acquire(office);

  try {
    return await act();
  } finally {
    release();
  }
}

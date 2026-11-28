import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { type Declared, type Generation, generatedFolder, outputFolder, outputRecord, ownedFolder, type Published, readPublished, sourceFolder } from "./generated.ts";
import { skillId } from "./settings.ts";

/** The skill folders a generator wrote, each named by a skill ID and holding a regular SKILL.md. */
function admitted(folder: string): string[] {
  return readdirSync(folder).sort().filter(name => {
    if (!skillId.test(name) || !lstatSync(join(folder, name)).isDirectory()) return false;

    return lstatSync(join(folder, name, "SKILL.md"), { throwIfNoEntry: false })?.isFile() === true;
  });
}

export function discard(office: string, folder: string): void {
  if (ownedFolder(office, folder)) rmSync(join(office, folder), { recursive: true });
}

export async function generate(office: string, { source, label }: Declared, next: Generation, runtimes: () => readonly string[]): Promise<Published> {
  const parent = sourceFolder(source.id);

  ownedFolder(office, parent, true);
  const output = mkdtempSync(join(office, parent, ".stage-"));
  const folder = relative(office, output);

  try {
    await next.generate({ office, executable: next.executable, output, inputs: next.inputs, runtimes: runtimes() });
    ownedFolder(office, folder);
    const record = { key: next.key, skills: admitted(output) };

    writeFileSync(join(output, outputRecord), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });

    return { ...record, folder };
  } catch (error) {
    discard(office, folder);

    throw new Error(`${label}: its generator failed with ${source.tool.name} ${next.version}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export function publish(office: string, id: string, folder: string): void {
  const target = join(office, outputFolder(id));
  const aside = join(office, sourceFolder(id), `.old-${basename(folder)}`);
  const previous = readPublished(office, id);

  if (previous) renameSync(target, aside);
  renameSync(join(office, folder), target);

  if (previous) rmSync(aside, { recursive: true });
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

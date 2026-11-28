import { closeSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { bindPaths } from "../../bound-paths.ts";
import type { Office } from "../../office.ts";
import { startReader } from "../worker.ts";
import { checkInstalled, hasPublishedSet, installedRoot } from "./paths.ts";

/**
 * Runs `args` in a reader bound to the published package set, and prints a package command's
 * result once the reader exits 0; undefined when the office has none.
 */
export async function runReader(dir: string, args: string[]) {
  checkInstalled(dir);

  if (!hasPublishedSet(dir)) return;
  let status: number;
  let bytes: Uint8Array;

  {
    // A process started by the reader can hold the pipe open past the reader's exit.
    using child = startReader(dir, args);
    const { pipe, exited } = child;
    const result = new Response(Bun.file(pipe).stream()).bytes().finally(() => closeSync(pipe));
    status = await exited;
    bytes = await result;
  }

  if (status === 0 && bytes.length) await Bun.write(Bun.stdout, bytes);

  return status;
}

/** Binds this process to the installed or staged set, whose rejected copies don't load. */
export function bindReader(dir: string, folder = installedRoot(dir)) {
  const file = join(folder, "unavailable.json");
  const unavailable = new Set(existsSync(file) ? v.parse(v.array(v.string()), JSON.parse(readFileSync(file, "utf8"))) : []);
  bindPaths(dir, folder, unavailable, !Bun.isStandaloneExecutable && folder !== installedRoot(dir));
}

/** The selection a set is published with, as its selection.json holds it. */
export function selectionText(office: Pick<Office, "packages">) {
  return JSON.stringify(office.packages.map(({ name, settings, source }) => ({ name, settings, ...source })));
}

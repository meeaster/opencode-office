import { createHash } from "node:crypto";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Entries, Registry, RegistryEntry, SetupContext } from "@office/sdk";

export function write(path: string, text = "---\nname: x\ndescription: d\n---\n") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export const spec = { name: "npm:@fission-ai/openspec", minimum: "2.1.0", bin: "openspec" };

export type Added = { id: string; value: RegistryEntry }[];

/** A setup context that keeps what a package added, as JSON, the way office clones setup entries. */
export function recorder() {
  const added: Added = [];
  const ctx: Pick<SetupContext, "add"> = { add: (handle, value) => void added.push({ id: handle.id, value: structuredClone(value) }) };

  return { ctx, added };
}

/** Entries as office gives them to the skills package, from what `owner`'s setup added. */
export function entriesOf(office: string, owner: string, added: Added): Entries {
  return <Value extends RegistryEntry>(registry: Registry<Value>) => added.flatMap(({ id, value }) => id === registry.id ? [{ value: registry.parse(value), owner, namespace: owner, settings: {}, folder: office, root: office }] : []);
}

export const officeInfo = (office: string) => ({ dir: office, name: "test", mode: "host" as const, launcher: "office" });
export const host = { timers: { set: () => [], clear: () => [], status: () => [] } };

/** Applies `version` of `spec`'s tool in a fresh tools folder, its executable as activated unless `drift`. */
export function applyTool(office: string, version: string, drift = false) {
  const folder = join(office, ".state/tools");
  const text = "#!/bin/sh\necho openspec\n";
  const bin = join(folder, "generations/g1/bin/openspec");
  const sha256 = `sha256:${createHash("sha256").update(text).digest("hex")}`;
  const identity = `openspec ${sha256}`;

  rmSync(folder, { recursive: true, force: true });
  write(bin, text);
  symlinkSync("generations/g1", join(folder, "current"));
  write(join(folder, "generations/g1/applied.json"), JSON.stringify({ tools: { [spec.name]: { version, identity, names: [spec.name], bin: { openspec: { path: join(folder, "current/bin/openspec"), sha256 } } } }, highest: { [spec.name]: version } }));
  write(join(office, ".office/runtime/tools.json"), JSON.stringify({ mode: "host", tools: folder }));

  if (drift) writeFileSync(bin, "#!/bin/sh\necho changed\n");

  return { identity };
}

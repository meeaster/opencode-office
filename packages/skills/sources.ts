// Generated sources: a package registers a generator of skills against the tool handle its own
// `tools.require` returned, in the same setup. The handle is described by its shape, so packages
// that offer only folders typecheck without the tools package.
//
// A generator is a function, which no registry entry can hold: `generated` keeps it in a table of
// this process under a fresh token and adds the token. The process that runs office up finds it
// again through `generatedSources.generator`, after its own setup ran; a token never outlives the
// process that made it.
import { randomUUID } from "node:crypto";
import { type JsonValue, Registry, type RegistryEntry, type SetupContext } from "@office/sdk";
import { skillId } from "./settings.ts";

/** The tool a generator runs: the handle `tools.require` returns, a minimum and one executable. */
export type GeneratorTool = { readonly name: string; readonly bin: readonly string[]; readonly minimum?: string };

/**
 * One generation: the office, the tool's executable office up applied, the empty folder to write
 * one `<id>/SKILL.md` folder per skill into, what `inputs` returned for this generation, and the
 * folders of the runtimes (node, pnpm) to put first on the tool's PATH: those the office's pinned
 * mise resolves in a host-mode office, those on the container's PATH in a container-mode one.
 */
export type GenerateRun<Inputs extends JsonValue = JsonValue> = { office: string; executable: string; output: string; inputs: Inputs; runtimes: readonly string[] };

export type Generate<Inputs extends JsonValue = JsonValue> = (run: GenerateRun<Inputs>) => void | Promise<void>;

/**
 * What a package's `setup` passes to `skills.sources.generated`. `revision` changes whenever
 * `generate` would write something else for the same tool and inputs; `inputs` returns everything
 * else the output depends on, such as the tool's profile, read without generating. Generation
 * reruns only when the applied tool, the revision or the inputs change.
 */
export type GeneratedOptions<Inputs extends JsonValue = null> = { id: string; tool: GeneratorTool; revision: string; inputs?: (office: string) => Inputs; generate: Generate<Inputs> };

/** A generated source as registered: its tool as `resolveTool` takes it, and the token of its functions in this process. */
export type GeneratedSource = { id: string; tool: { name: string; minimum: string; bin: string }; revision: string; generator: string };

type Generator = { generate: Generate; inputs: (office: string) => JsonValue };

// One table per process, whichever copy of this module a package's import reached.
declare global {
  var officeSkillGenerators: Map<string, Generator> | undefined;
}

const generators = (globalThis.officeSkillGenerators ??= new Map<string, Generator>());

function text(value: RegistryEntry[string] | undefined): value is string {
  return typeof value === "string";
}

function parse(input: RegistryEntry): GeneratedSource {
  const { id, tool, revision, generator } = input;
  const what = `generated skill source ${text(id) ? id : "(unnamed)"}`;
  const unknown = Object.keys(input).filter(key => !["id", "tool", "revision", "generator"].includes(key));

  if (unknown.length) throw new Error(`${what}: unknown key ${unknown.join(", ")}; it has id, tool, revision and generator`);

  if (!text(id) || !skillId.test(id)) throw new Error(`${what}: id must be lowercase letters and digits, joined by single dashes`);

  if (tool === null || typeof tool !== "object" || Array.isArray(tool) || !text(tool.name) || !text(tool.minimum) || !text(tool.bin) || Object.keys(tool).length !== 3) throw new Error(`${what}: tool must be the handle tools.require returned`);

  if (!text(revision) || revision === "") throw new Error(`${what}: revision must be a nonempty string, such as 1`);

  if (!text(generator) || !generators.has(generator)) throw new Error(`${what}: generator must be the function given to skills.sources.generated`);

  return { id, tool: { name: tool.name, minimum: tool.minimum, bin: tool.bin }, revision, generator };
}

const registry = Registry.define<GeneratedSource>({ id: "skills.generated", key: entry => entry.id, parse });

/** The generated sources registry, and the functions `generated` kept for a token in this process. */
export const generatedSources = {
  ...registry,
  generator(token: string): Generator | undefined {
    return generators.get(token);
  },
};

/**
 * Registers a generated source. Throws naming the source unless `tool` is a requirement handle with
 * a minimum and exactly one executable: a provider's handle has no minimum, and a tool with several
 * executables leaves which one generates unsaid.
 */
export function generated<Inputs extends JsonValue = null>(ctx: Pick<SetupContext, "add">, options: GeneratedOptions<Inputs>): void {
  const { id, tool, revision, generate } = options;
  const inputs = options.inputs ?? (() => null);
  const what = `generated skill source ${id}`;

  if (typeof tool?.minimum !== "string") throw new Error(`${what}: tool ${tool?.name} has no minimum; pass the handle tools.require returned`);

  if (!Array.isArray(tool.bin) || tool.bin.length !== 1) throw new Error(`${what}: tool ${tool.name} must expose exactly one executable, the one that generates; it names ${tool.bin?.length ?? 0}`);

  if (typeof generate !== "function" || typeof inputs !== "function") throw new Error(`${what}: generate and inputs must be functions`);
  const token = randomUUID();

  generators.set(token, { generate: generate as Generate, inputs });
  ctx.add(registry, { id, tool: { name: tool.name, minimum: tool.minimum, bin: tool.bin[0] }, revision, generator: token });
}

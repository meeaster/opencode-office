// The repositories packages declare they read or push to, for `office setup`'s GitHub plan and
// reads and `office check`'s login checks. A package declares them in a module of its own, the one
// its package.json names in `office.access`, so they are known before any package set exists:
// a fresh office's first setup plans access from office.yaml's settings as they are now, before it
// clones anything or loads any definition. Built-in packages' declarations come from this
// executable and local packages' from `packages/`; a Git package's code isn't fetched yet and
// isn't asked. The modules run in an evaluator process of their own, as package code always does.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as v from "valibot";

import type { SettingValue } from "../../sdk/index.ts";
import { OfficeError, type Office } from "../office.ts";
import { readPackageJson } from "./package-manifest.ts";
import { runEvaluator } from "./package-operation.ts";
import { resolvePackages } from "./packages.ts";
import { check } from "../schema.ts";
import { accessWithSdk, registerSdk } from "../sdk.ts";
import { builtinFiles, toolPath } from "../tool.ts";

/** A repository a package declared, under the package's name. */
export type DeclaredAccess = { owner: string; name: string; url: string; access: "read" | "read-write" };

type Request = { owner: string; module: string; settings: Readonly<Record<string, SettingValue>> };

const sourceSchema = v.strictObject({
  name: v.pipe(v.string(), v.nonEmpty()),
  url: v.pipe(v.string(), v.nonEmpty()),
  access: v.picklist(["read", "read-write"]),
});

const answerSchema = v.array(v.union([
  v.object({ owner: v.string(), sources: v.array(sourceSchema) }),
  v.object({ owner: v.string(), error: v.string() }),
]));

/** Whether a built-in package's package.json names an access declaration, read without unpacking the package. */
function builtinDeclares(name: string): boolean {
  try {
    const json: unknown = JSON.parse(readFileSync(toolPath(`packages/${name}/package.json`), "utf8"));

    return v.is(v.object({ office: v.object({ access: v.string() }) }), json);
  } catch {
    return false;
  }
}

/** Whether the package.json in `dir` has an `office.access` field, whatever its value. */
function namesAccess(dir: string): boolean {
  try {
    const json: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

    return v.is(v.object({ office: v.looseObject({ access: v.unknown() }) }), json) && json.office.access !== undefined;
  } catch {
    return false;
  }
}

/** Writes a built-in package's files into `folder`, as an office would hold them. */
async function unpack(name: string, folder: string) {
  for (const [file, content] of await builtinFiles(name)) {
    mkdirSync(dirname(join(folder, file)), { recursive: true });
    writeFileSync(join(folder, file), content);
  }
}

/**
 * The repositories the selected built-in and local packages declare, from office.yaml's settings
 * now, and a problem for each declaration that doesn't read or run. Loads no definition.
 */
export async function declaredAccess(office: Office): Promise<{ sources: DeclaredAccess[]; problems: string[] }> {
  const selection = resolvePackages(office);
  const temporary = mkdtempSync(join(tmpdir(), "office-access-"));
  const requests: Request[] = [];
  const problems: string[] = [];

  try {
    for (const item of selection.packages) {
      const name = item.entry.name;

      if (item.kind === "remote" || (item.kind === "built-in" && !builtinDeclares(name))) continue;
      let dir = item.dir;

      if (item.kind === "built-in") {
        dir = join(temporary, "packages", name);
        await unpack(name, dir);
      }

      const json = readPackageJson(dir, name, item.kind);

      // A package.json that names an access declaration but doesn't read is no proof the package
      // needs no access: it stops setup. One without the field is sync's to report.
      if (!json.ok) {
        if (namesAccess(dir)) problems.push(`package ${name}: its access declaration can't be read: ${json.errors.join("; ")}`);
        continue;
      }

      if (json.value.access === undefined) continue;
      requests.push({ owner: name, module: join(dir, json.value.access), settings: item.entry.settings ?? {} });
    }

    if (requests.length === 0) return { sources: [], problems };
    writeFileSync(join(temporary, "input"), JSON.stringify(requests));
    const status = await runEvaluator(["--package-access", temporary]);

    if (status !== 0) throw new OfficeError(`the access evaluator exited ${status}`);
    const answers = check(v.safeParse(answerSchema, JSON.parse(readFileSync(join(temporary, "output"), "utf8"))));

    if (!answers.ok) throw new OfficeError(`the access evaluator's answer doesn't read: ${answers.errors.join("; ")}`);
    const sources: DeclaredAccess[] = [];

    for (const answer of answers.value) {
      if ("error" in answer) problems.push(`package ${answer.owner}: its access declaration ${answer.error}`);
      else sources.push(...answer.sources.map(source => ({ owner: answer.owner, ...source })));
    }

    return { sources, problems };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** The evaluator: runs each declaration with its package's settings, writing what each returned or why it failed. */
export async function evaluateAccess(temporary: string) {
  const requests: Request[] = JSON.parse(readFileSync(join(temporary, "input"), "utf8"));
  const answers: v.InferOutput<typeof answerSchema> = [];

  registerSdk();

  for (const { owner, module, settings } of requests) {
    try {
      const declared: unknown = (await import(module)).default;

      if (!accessWithSdk(declared)) throw new Error("must be the result of Package.access from @office/sdk");
      const sources = check(v.safeParse(v.array(sourceSchema), declared(structuredClone(settings))));

      if (!sources.ok) throw new Error(`must return a list of { name, url, access: "read" | "read-write" }: ${sources.errors.join("; ")}`);
      answers.push({ owner, sources: sources.value });
    } catch (error) {
      answers.push({ owner, error: `failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  writeFileSync(join(temporary, "output"), JSON.stringify(answers));
}

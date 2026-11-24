// A package's optional integrations: each provider it can use without requiring it, mapped in its
// package.json's `office.integrations` to a module inside the package, with its definition's policy
// for when that integration is active. Whether one is active is decided from the package's
// validated settings and the selection being gathered (office.yaml's, or sync's candidate), never
// from which links a package set holds. Only an active integration's module is imported, and its
// setup adds entries as its package, with its package's settings.
import { join } from "node:path";
import * as v from "valibot";
import type { Integration, IntegrationPolicy, SettingValue } from "../sdk/index.ts";
import { type PackageJson, scope } from "./package-manifest.ts";
import type { Parsed, PackageManifest } from "./schema.ts";
import { integrationWithSdk, registerSdk } from "./sdk.ts";

/** One optional provider of a package, by name without the scope, its module inside the package and its definition's policy. */
export type OptionalIntegration = { provider: string; module: string; policy: IntegrationPolicy };

/** The packages being gathered select, and those of them that didn't load. */
export type Selection = { selected: ReadonlySet<string>; unread: ReadonlySet<string> };

/** An integration that is requested but can't run, or whose policy or module is malformed: names the provider and module. */
function problem({ provider, module }: OptionalIntegration, what: string) {
  return new Error(`integration ${scope}${provider} (${module}): ${what}`);
}

/** An integration whose policy, module or setup threw: names the provider and module, and keeps what was thrown, `undefined` included, as its `cause`. */
function failure({ provider, module }: OptionalIntegration, what: string, cause: unknown) {
  return new Error(`integration ${scope}${provider} (${module}): ${what}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
}

/** Pairs each provider package.json maps with the definition's policy for it; a policy for a provider package.json doesn't map is a problem. */
export function declaredIntegrations(json: Pick<PackageJson, "integrations">, manifest: Pick<PackageManifest, "integrations">): Parsed<OptionalIntegration[]> {
  const errors = Object.keys(manifest.integrations).flatMap(key => json.integrations.has(key.slice(scope.length)) ? [] : [`integrations: ${key} isn't in package.json's office.integrations; map it to its module there, or remove its policy`]);

  if (errors.length) return { ok: false, errors };

  return { ok: true, value: [...json.integrations].map(([provider, module]) => ({ provider, module, policy: manifest.integrations[`${scope}${provider}`] ?? {} })) };
}

/**
 * The integrations of `consumer` its validated `settings` and the selection make active. One its
 * policy requests is active, and throws when office.yaml doesn't select the provider or the
 * provider didn't load; one its policy turns off isn't, whatever `enabledByDefault` says; otherwise
 * `enabledByDefault` activates one whose provider is selected. Nothing is imported here.
 */
export function activeIntegrations(consumer: string, integrations: readonly OptionalIntegration[], settings: Readonly<Record<string, SettingValue>>, selection: Selection): OptionalIntegration[] {
  return integrations.filter(integration => {
    const { provider, policy } = integration;
    let requested: unknown;

    try {
      requested = policy.requested?.(structuredClone(settings));
    } catch (error) {
      throw failure(integration, "its requested policy failed", error);
    }

    if (v.is(v.promise(), requested)) {
      // Never awaited: a policy is synchronous. Handled, so its rejection can't outlive this diagnostic.
      requested.catch(() => undefined);

      throw problem(integration, "its requested policy must return true, false or undefined synchronously, not a Promise; don't make it async");
    }

    if (requested !== undefined && !v.is(v.boolean(), requested)) throw problem(integration, "its requested policy must return true, false or undefined");

    if (!(requested ?? (policy.enabledByDefault === true && selection.selected.has(provider)))) return false;

    if (!selection.selected.has(provider)) throw problem(integration, `requested by package ${consumer}'s settings, but office.yaml doesn't select package ${provider}; add ${provider} to office.yaml, or change ${consumer}'s settings so they don't request it`);

    if (selection.unread.has(provider)) throw problem(integration, `package ${provider} is selected but didn't load, so this integration can't run; fix package ${provider}`);

    return true;
  });
}

/**
 * Imports each of `active` from `folder`, where its package loads from in this run, and returns its
 * setup, which names the integration when it throws. Throws for a module that doesn't load or isn't
 * made with `Package.integration`.
 */
export function loadIntegrations(folder: string, active: readonly OptionalIntegration[]): Integration[] {
  if (active.length) registerSdk();

  return active.map(integration => {
    let exported: unknown;

    try {
      // Bun loads external TypeScript synchronously, as a definition is.
      exported = require(join(folder, integration.module)).default;
    } catch (error) {
      throw failure(integration, "its module failed to load", error);
    }

    const malformed = "its default export must be the result of Package.integration from @office/sdk, with a setup function";

    if (!integrationWithSdk(exported)) throw problem(integration, malformed);

    const loaded = exported;
    let setup: unknown;

    // Read once: a getter could give a different function, or throw, on a second read.
    try {
      setup = loaded.setup;
    } catch (error) {
      throw failure(integration, "its setup failed", error);
    }

    if (!v.is(v.function(), setup)) throw problem(integration, malformed);
    const run = setup;

    return {
      async setup(ctx) {
        try {
          await run.call(loaded, ctx);
        } catch (error) {
          throw failure(integration, "its setup failed", error);
        }
      },
    };
  });
}

// A package's optional integrations: each provider it can use without requiring it, mapped in its
// package.json's `office.integrations` to a module inside the package. One runs whenever the
// selection being gathered (office.yaml's, or sync's candidate) selects its provider, never from
// which links a package set holds; its module is imported then, and its setup decides from its
// package's settings whether to add anything, as its package.
import { join } from "node:path";
import * as v from "valibot";
import type { Integration } from "../../sdk/index.ts";
import { scope } from "./package-manifest.ts";
import { integrationWithSdk, registerSdk } from "../sdk.ts";

/** One optional provider of a package, by name without the scope, and its module inside the package. */
export type OptionalIntegration = { provider: string; module: string };

/** The packages being gathered select, and those of them that didn't load. */
export type Selection = { selected: ReadonlySet<string>; unread: ReadonlySet<string> };

/** An integration that can't run, or whose module is malformed: names the provider and module. */
function problem({ provider, module }: OptionalIntegration, what: string) {
  return new Error(`integration ${scope}${provider} (${module}): ${what}`);
}

/** An integration whose module or setup threw: names the provider and module, and keeps what was thrown, `undefined` included, as its `cause`. */
function failure({ provider, module }: OptionalIntegration, what: string, cause: unknown) {
  return new Error(`integration ${scope}${provider} (${module}): ${what}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
}

/**
 * The integrations whose provider the selection selects. Throws for one whose provider is selected
 * but didn't load, whatever the consumer's settings would add: that is the provider's failure, not
 * its absence. Nothing is imported here.
 */
export function selectedIntegrations(integrations: readonly OptionalIntegration[], selection: Selection): OptionalIntegration[] {
  return integrations.filter(integration => {
    const { provider } = integration;

    if (!selection.selected.has(provider)) return false;

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

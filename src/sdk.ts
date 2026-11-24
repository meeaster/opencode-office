// The executable's own @office/sdk, as every package gets it. A package's `import ... from
// "@office/sdk"` resolves here at runtime, whatever is on disk under that name: the redirect is
// registered in each process (and worker) before its first definition is required.
import { Package, Registry } from "../sdk/index.ts";

/** Whether a value was made by this process's `Package.define`, and by its `Package.integration`. */
export { marked as madeWithSdk, markedIntegration as integrationWithSdk } from "../sdk/mark.ts";

let registered = false;

/** Registers the redirect of `@office/sdk` to this process's SDK. Idempotent. */
export function registerSdk() {
  if (registered) return;

  Bun.plugin({
    name: "@office/sdk",
    setup(build) {
      build.module("@office/sdk", () => ({ exports: { Package, Registry }, loader: "object" }));
    },
  });
  registered = true;
}

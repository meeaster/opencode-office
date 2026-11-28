// The executable's own package API and shared Git rules, regardless of what is on disk under
// @office/sdk. Each process registers the redirects before its first definition is required.
import { Package, Registry } from "../../../sdk/index.ts";
import { highestTag } from "../../../sdk/git-tags.ts";
import { redactUrl } from "../../../sdk/redact-url.ts";

export { markedAccess as accessWithSdk } from "../../../sdk/mark.ts";

let registered = false;

/** Registers the SDK modules backed by the executable. Idempotent. */
export function registerSdk() {
  if (registered) return;

  Bun.plugin({
    name: "@office/sdk",
    setup(build) {
      build.module("@office/sdk", () => ({ exports: { Package, Registry }, loader: "object" }));
      build.module("@office/sdk/git-tags", () => ({ exports: { highestTag }, loader: "object" }));
      build.module("@office/sdk/redact-url", () => ({ exports: { redactUrl }, loader: "object" }));
    },
  });
  registered = true;
}

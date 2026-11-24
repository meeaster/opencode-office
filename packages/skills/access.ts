// The Git repositories the skills package reads, which `office setup` reads with this host's
// credentials before the package's sync fetches them. It runs before any package set exists, on
// office.yaml's settings as written, so it takes only what it can read and leaves the rest to the
// schema check sync runs.
import { Package } from "@office/sdk";

export default Package.access((settings) => {
  const sources = Array.isArray(settings.sources) ? settings.sources : [];

  return sources.flatMap((source, index) => {
    const repo = typeof source === "object" && source !== null && !Array.isArray(source) ? source.repo : undefined;

    return typeof repo === "string" ? [{ name: `source ${index + 1}`, url: repo, access: "read" as const }] : [];
  });
});

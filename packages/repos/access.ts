// What `office setup` reads before cloning anything: each working repository with a URL, read-write
// because the office pushes to it. A local-only entry declares nothing. Settings here are
// office.yaml's as written, not yet checked; a wrong entry stops setup, naming it, before any clone.
import { Package } from "@office/sdk";
import { readEntries } from "./settings.ts";

export default Package.access(settings => readEntries(settings).flatMap(({ name, url }) => url === undefined ? [] : [{ name, url, access: "read-write" as const }]));

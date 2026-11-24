// A stand-in for the package's runtime, such as a bridge: it reads the settings the last sync
// applied, never office.yaml, and prints what it would serve. Run it with `bun --no-install`.
import { dirname } from "node:path";
import { officeRootOf, readAppliedSettings } from "@office/sdk/applied-settings";
import { directConnectors } from "./routes.ts";

const settings = readAppliedSettings(officeRootOf(dirname(import.meta.path)), "chatgpt-routing");
const { routes, executor } = settings;

if (typeof routes !== "object" || routes === null || Array.isArray(routes) || typeof executor !== "object" || executor === null || Array.isArray(executor)) throw new Error("chatgpt-routing: applied settings without routes or executor");

const { gmail, calendar } = routes;

if (typeof gmail !== "string" || typeof calendar !== "string") throw new Error("chatgpt-routing: applied routes without gmail or calendar");

console.log(JSON.stringify({ direct: directConnectors({ gmail, calendar }), app: executor.app === true ? executor.name : null }));

import { parentPort, workerData } from "node:worker_threads";
import type { Office } from "./office.ts";
import { type ResolvedPackage, validateReplacement } from "./packages.ts";

const { office, resolved, expectedBuiltins }: { office: Office; resolved: ResolvedPackage; expectedBuiltins: Map<string, string> } = workerData;

await validateReplacement(office, resolved, true, expectedBuiltins);

parentPort!.postMessage("validated");

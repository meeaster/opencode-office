import { parentPort, workerData } from "node:worker_threads";
import type { Office } from "./office.ts";
import { type ResolvedPackage, validateReplacement } from "./packages.ts";

const { office, resolved }: { office: Office; resolved: ResolvedPackage } = workerData;

await validateReplacement(office, resolved, true);

parentPort!.postMessage("validated");

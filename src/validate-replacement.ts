import { parentPort, workerData } from "node:worker_threads";
import type { Office } from "./office.ts";
import { type ResolvedPackage, validateReplacement, validateSetupOverrides } from "./packages.ts";

const { office, resolved }: { office: Office; resolved: ResolvedPackage } = workerData;

await validateSetupOverrides(validateReplacement(office, resolved));

parentPort!.postMessage("validated");

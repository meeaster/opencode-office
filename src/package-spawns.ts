// Docker resources a package's services create themselves through the Docker socket, which
// `docker compose down` knows nothing of. A package declares the label they carry (`spawns:` in
// package.yaml); `office up` keeps it, interpolated, beside the applied copy of the package's
// compose file (src/package-services.ts), so it is still known once the package leaves office.yaml.
//
// A sweep removes the labelled containers before Compose stops the package's services, since a
// running one attached to the office's network keeps Compose from removing that network, then the
// labelled networks once Compose is done. Labelled volumes stay, as the package's own named
// volumes do: nothing in office removes a package's data.
import { spawnSync } from "node:child_process";

import { say, warn } from "./report/index.ts";
import { spawnsOfficeName } from "./schema.ts";

/** A package's declared label for one office. */
export function spawnsLabel(label: string, officeName: string): string {
  return label.replace(spawnsOfficeName, officeName);
}

export type SpawnedKind = "container" | "network" | "volume";

/** One Docker resource found by one of the labels. */
export type Spawned = { kind: SpawnedKind; name: string; label: string };

/** What a sweep removes, in order: containers before Compose stops the services, networks after; volumes stay. */
export type Sweep = { containers: string[]; networks: string[]; kept: string[] };

/**
 * What to remove of `found`, a listing of labelled resources: only what carries one of `labels`,
 * each once, in name order.
 */
export function planSweep(labels: string[], found: Spawned[]): Sweep {
  const wanted = new Set(labels);
  const names = (kind: SpawnedKind) => [...new Set(found.flatMap((item) => (item.kind === kind && wanted.has(item.label) ? [item.name] : [])))].sort();

  return { containers: names("container"), networks: names("network"), kept: names("volume") };
}

/** Whether a sweep has nothing to remove. */
export function sweepIsEmpty(sweep: Sweep): boolean {
  return sweep.containers.length === 0 && sweep.networks.length === 0;
}

/** The docker command that lists one kind of resource with a label, by name. */
const listing: Record<SpawnedKind, (label: string) => string[]> = {
  container: (label) => ["ps", "--all", "--filter", `label=${label}`, "--format", "{{.Names}}"],
  network: (label) => ["network", "ls", "--filter", `label=${label}`, "--format", "{{.Name}}"],
  volume: (label) => ["volume", "ls", "--filter", `label=${label}`, "--format", "{{.Name}}"],
};

function docker(args: string[]) {
  const result = spawnSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  return { ok: result.status === 0, output: result.error === undefined ? `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() : result.error.message };
}

/** The resources Docker holds with each of `labels`; `errors` says what couldn't be listed. */
export function listSpawned(labels: string[]) {
  const found: Spawned[] = [];
  const errors: string[] = [];

  for (const label of labels) {
    for (const kind of ["container", "network", "volume"] as const) {
      const result = docker(listing[kind](label));

      if (!result.ok) {
        errors.push(`couldn't list ${kind}s labelled ${label}: ${result.output}`);

        continue;
      }

      for (const name of result.output.split("\n").filter(Boolean)) found.push({ kind, name, label });
    }
  }

  return { found, errors };
}

/** Removes each of `names` with `docker <args> <name>`; returns one line per failure. */
function remove(kind: SpawnedKind, args: string[], names: string[]): string[] {
  const failures: string[] = [];

  for (const name of names) {
    const result = docker([...args, name]);

    if (result.ok) say(`removed the ${kind} ${name}`, "office: ");
    else failures.push(`couldn't remove the ${kind} ${name}: ${result.output}`);
  }

  return failures;
}

/**
 * Starts a sweep of `labels` around a Compose command: lists what carries them and removes the
 * containers now. Returns what removes the networks once Compose is done. Docker failures are
 * warnings, so Compose still runs.
 */
export function sweepSpawned(labels: string[], why: string): () => void {
  if (labels.length === 0) return () => {};

  const { found, errors } = listSpawned(labels);
  const sweep = planSweep(labels, found);

  const report = (failures: string[]) => {
    const text = `${why}: ${failures.join("; ")}`;

    if (failures.length > 0) warn(text, `office: ${text}`);
  };

  report([...errors, ...remove("container", ["rm", "--force"], sweep.containers)]);

  return () => {
    report(remove("network", ["network", "rm"], sweep.networks));

    if (sweep.kept.length > 0) say(`kept the volumes ${sweep.kept.join(", ")}, as package volumes are`, "office: ");
  };
}

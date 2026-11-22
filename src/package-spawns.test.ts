import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import * as v from "valibot";
import { parse } from "yaml";

import { loadOffice } from "./office.ts";
import { appliedSpawns, preparePackageServices } from "./package-services.ts";
import { planSweep, type Spawned, spawnsLabel } from "./package-spawns.ts";
import { check, packageManifestSchema } from "./schema.ts";
import { recordRequiredBuiltins } from "./test-builtin-record.ts";
import { writePackage } from "./test-package.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-package-spawns-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Writes `path`; an office.yaml's office gets its required built-ins, as a synced office has. */
function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);

  if (basename(path) === "office.yaml") recordRequiredBuiltins(dirname(path));
}

const manifest = (head: string, label: string) => check(v.safeParse(packageManifestSchema, parse(`${head}description: d\nspawns:\n  label: "${label}"\n`)));

test("a spawns label is one key=value naming the office and the package's namespace", () => {
  expect(manifest("name: aws-emulator\nnamespace: floci\n", "floci_namespace=office-${OFFICE_NAME}-floci")).toMatchObject({ ok: true, value: { spawns: { label: "floci_namespace=office-${OFFICE_NAME}-floci" } } });
  expect(manifest("name: tool\n", "io.example.owner=${OFFICE_NAME}.tool")).toMatchObject({ ok: true });

  const officeError = ["spawns.label: its value must hold ${OFFICE_NAME} once and nothing else to interpolate, so it names only this office's resources"];

  // A fixed value would match the same tool's resources in every other office.
  expect(manifest("name: tool\n", "tool_namespace=tool")).toEqual({ ok: false, errors: officeError });
  expect(manifest("name: tool\n", "tool_namespace=${OFFICE_NAME}-${OFFICE_NAME}-tool")).toEqual({ ok: false, errors: officeError });
  expect(manifest("name: tool\n", "tool_namespace=${OFFICE_NAME}-${TOOL_PORT}-tool")).toEqual({ ok: false, errors: officeError });

  // Without the namespace, another package of the office could declare the same label.
  const namespaceError = ["spawns.label: its value must name the package's namespace (its name unless it sets namespace:) as a part between - _ or ., such as office-${OFFICE_NAME}-tool"];

  expect(manifest("name: tool\n", "tool_namespace=office-${OFFICE_NAME}")).toEqual({ ok: false, errors: namespaceError });
  expect(manifest("name: tool\n", "tool_namespace=office-${OFFICE_NAME}-toolbox")).toEqual({ ok: false, errors: namespaceError });
  expect(manifest("name: aws-emulator\nnamespace: floci\n", "ns=office-${OFFICE_NAME}-aws-emulator")).toEqual({ ok: false, errors: namespaceError });

  // Compose's own project label would match the office's own containers.
  expect(manifest("name: tool\n", "com.docker.compose.project=office-${OFFICE_NAME}-tool")).toMatchObject({ ok: false, errors: ["spawns.label: must not use a com.docker. key, which Docker and Compose set themselves"] });

  for (const label of ["office-${OFFICE_NAME}-tool", "a=b=office-${OFFICE_NAME}-tool", "a=office-${OFFICE_NAME}-tool b=c", "=office-${OFFICE_NAME}-tool"]) {
    expect(manifest("name: tool\n", label)).toMatchObject({ ok: false, errors: [expect.stringContaining("must be one key=value label")] });
  }

  expect(spawnsLabel("floci_namespace=office-${OFFICE_NAME}-floci", "personal")).toBe("floci_namespace=office-personal-floci");
});

test("a sweep removes only what carries a declared label: containers before Compose, networks after, and keeps volumes", () => {
  const ours = "floci_namespace=office-t-floci";

  const found: Spawned[] = [
    { kind: "network", name: "office-t-floci-vpc-1", label: ours },
    { kind: "container", name: "office-t-floci-ec2-b", label: ours },
    { kind: "container", name: "office-t-floci-ec2-a", label: ours },
    { kind: "container", name: "office-t-floci-ec2-a", label: ours },
    { kind: "volume", name: "floci-aws-office-t-floci-ec2-volumes", label: ours },
    // Another install's resources, listed by mistake, stay.
    { kind: "container", name: "eks-lab-node", label: "floci_namespace=eks-lab" },
    { kind: "network", name: "eks-lab-vpc", label: "floci_namespace=eks-lab" },
  ];

  expect(planSweep([ours], found)).toEqual({
    containers: ["office-t-floci-ec2-a", "office-t-floci-ec2-b"],
    networks: ["office-t-floci-vpc-1"],
    kept: ["floci-aws-office-t-floci-ec2-volumes"],
  });

  expect(planSweep([], found)).toEqual({ containers: [], networks: [], kept: [] });
});

test("office up keeps a package's spawns label beside its applied copy and hands it over once the package leaves", async () => {
  const office = join(dir, "office");
  const label = join(office, "state/packages/tool/spawns.label");

  write(join(office, "office.yaml"), "name: t\nstate: state\npackages:\n  - name: tool\n  - name: plain\n");
  writePackage(join(office, "packages/tool/package.yaml"), 'name: tool\ndescription: d\nspawns:\n  label: "tool_ns=office-${OFFICE_NAME}-tool"\n');
  write(join(office, "packages/tool/compose.yaml"), "services:\n  tool:\n    image: busybox\n");
  writePackage(join(office, "packages/plain/package.yaml"), "name: plain\ndescription: d\n");
  write(join(office, "packages/plain/compose.yaml"), "services:\n  plain:\n    image: busybox\n");

  expect((await preparePackageServices(loadOffice(office), false)).apply()).toEqual([]);
  expect(readFileSync(label, "utf8")).toBe("tool_ns=office-t-tool\n");
  expect(appliedSpawns(loadOffice(office))).toEqual(new Map([["tool", "tool_ns=office-t-tool"]]));

  // A changed label waits with its compose file for --upgrade: it describes what the applied copy runs.
  writePackage(join(office, "packages/tool/package.yaml"), 'name: tool\ndescription: d\nspawns:\n  label: "tool_ns=${OFFICE_NAME}.tool"\n');
  write(join(office, "packages/tool/compose.yaml"), "services:\n  tool:\n    image: busybox:1\n");
  (await preparePackageServices(loadOffice(office), false)).apply();
  expect(readFileSync(label, "utf8")).toBe("tool_ns=office-t-tool\n");
  (await preparePackageServices(loadOffice(office), true)).apply();
  expect(readFileSync(label, "utf8")).toBe("tool_ns=t.tool\n");

  // Once the package leaves office.yaml, its label comes back for the sweep and its state goes.
  write(join(office, "office.yaml"), "name: t\nstate: state\npackages:\n  - name: plain\n");
  expect((await preparePackageServices(loadOffice(office), false)).apply()).toEqual(["tool_ns=t.tool"]);
  expect(existsSync(label)).toBe(false);
  expect(appliedSpawns(loadOffice(office))).toEqual(new Map());
});

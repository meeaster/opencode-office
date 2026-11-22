import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import * as v from "valibot";
import { parse } from "yaml";

import { compose, composeArguments } from "./commands/compose.ts";
import { loadOffice } from "./office.ts";
import { composeProblems, ensureSecrets, packageSecret, planServices, preparePackageServices, secretsPath } from "./package-services.ts";
import { check, packageManifestSchema } from "./schema.ts";
import { recordRequiredBuiltins } from "./test-builtin-record.ts";
import { writePackage } from "./test-package.ts";

let dir: string;
let cache: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-package-services-"));
  cache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = join(dir, "cache");
});

afterEach(() => {
  if (cache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = cache;

  rmSync(dir, { recursive: true, force: true });
});

/** Writes `path`; an office.yaml's office gets its required built-ins, as a synced office has. */
function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);

  if (basename(path) === "office.yaml") recordRequiredBuiltins(dirname(path));
}

test("a package's compose file may name only its own resources and publish only on 127.0.0.1", () => {
  const valid = `services:
  doop:
    build: .
    ports:
      - "127.0.0.1:\${DOOP_PORT:-3000}:3000"
      - target: 80
        host_ip: 127.0.0.1
        published: 8080
    expose: ["5432"]
  doop-db:
    image: postgres
volumes:
  doop-data:
`;

  expect(composeProblems("doop", valid)).toEqual([]);

  const invalid = `services:
  executor:
    image: x
  doop:
    ports: ["8080:80", 3000, { target: 80 }]
  doop-host:
    network_mode: host
volumes:
  data:
networks:
  doopnet:
`;

  expect(composeProblems("doop", invalid)).toEqual([
    "services.executor: must be named doop or doop-*",
    "volumes.data: must be named doop or doop-*",
    "networks.doopnet: must be named doop or doop-*",
    'services.doop.ports[0]: must bind 127.0.0.1, such as "127.0.0.1:8080:80" or host_ip: 127.0.0.1',
    'services.doop.ports[1]: must bind 127.0.0.1, such as "127.0.0.1:8080:80" or host_ip: 127.0.0.1',
    'services.doop.ports[2]: must bind 127.0.0.1, such as "127.0.0.1:8080:80" or host_ip: 127.0.0.1',
    "services.doop-host: network_mode host would publish every port beyond 127.0.0.1",
  ]);

  expect(composeProblems("executor", "services:\n  executor-x:\n    image: x\n")).toEqual(["executor is one of the office's own services, so a package with that namespace can't have a compose.yaml"]);
});

test("a package's secrets carry its namespace, its name by default, and don't take a setting's variable", () => {
  const manifest = (head: string, secrets: string) => check(v.safeParse(packageManifestSchema, parse(`${head}description: d\nsettings:\n  url:\n    description: u\n    default: x\nsecrets:\n${secrets}`)));
  const prefixError = { ok: false as const, errors: ["secrets: each name must start with the package's namespace (its name unless it sets namespace:) in capitals and _ for -, such as DOOP_"] };

  expect(manifest("name: my-pkg\n", "  MY_PKG_KEY:\n    generate: hex\n    bytes: 32\n")).toMatchObject({ ok: true, value: { namespace: "my-pkg" } });
  expect(manifest("name: my-pkg\n", "  KEY:\n    generate: hex\n    bytes: 32\n")).toEqual(prefixError);
  expect(manifest("name: my-pkg\n", "  MY_PKG_URL:\n    generate: hex\n    bytes: 32\n")).toEqual({ ok: false, errors: ["secrets: a name is also the variable of one of the package's settings"] });

  expect(manifest("name: design\nnamespace: doop\n", "  DOOP_KEY:\n    generate: hex\n    bytes: 32\n")).toMatchObject({ ok: true, value: { name: "design", namespace: "doop" } });
  expect(manifest("name: design\nnamespace: doop\n", "  DESIGN_KEY:\n    generate: hex\n    bytes: 32\n")).toEqual(prefixError);
  expect(manifest("name: design\nnamespace: doop\n", "  DOOP_URL:\n    generate: hex\n    bytes: 32\n")).toEqual({ ok: false, errors: ["secrets: a name is also the variable of one of the package's settings"] });
});

test("a namespaced package's services and settings follow its namespace, and two packages can't claim one", async () => {
  const office = join(dir, "office");

  write(join(office, "office.yaml"), "name: t\nstate: state\npackages:\n  - name: canvas\n    settings:\n      url: https://example.com\n");
  writePackage(join(office, "packages/canvas/package.yaml"), "name: canvas\nnamespace: doop\ndescription: d\nsettings:\n  url:\n    description: u\n    required: true\n");
  write(join(office, "packages/canvas/compose.yaml"), "services:\n  design:\n    image: busybox\n");
  await expect(preparePackageServices(loadOffice(office), false)).rejects.toThrow("package canvas: compose.yaml: services.design: must be named doop or doop-*");

  write(join(office, "packages/canvas/compose.yaml"), "services:\n  doop:\n    image: busybox\n  doop-db:\n    image: postgres\n");
  (await preparePackageServices(loadOffice(office), false)).apply();
  expect(readFileSync(join(office, "state/packages/canvas/settings.env"), "utf8")).toBe("DOOP_URL='https://example.com'\n");

  write(join(office, "office.yaml"), "name: t\nstate: state\npackages:\n  - name: canvas\n    settings:\n      url: https://example.com\n  - name: doop\n");
  writePackage(join(office, "packages/doop/package.yaml"), "name: doop\ndescription: d\n");
  await expect(preparePackageServices(loadOffice(office), false)).rejects.toThrow("packages canvas and doop claim the same namespace, doop");
});

test("a package without services gets declared secrets on up, and get reveals only current declarations", async () => {
  write(join(dir, "office.yaml"), "name: t\nstate: state\npackages:\n  - name: notes\n  - name: plain\n");
  writePackage(join(dir, "packages/notes/package.yaml"), "name: notes\ndescription: test\nsecrets:\n  NOTES_KEY:\n    generate: hex\n    bytes: 32\n");
  writePackage(join(dir, "packages/plain/package.yaml"), "name: plain\ndescription: test\n");
  const office = loadOffice(dir);

  expect(() => packageSecret(office, "notes", "NOTES_KEY")).toThrow("run office up");
  (await preparePackageServices(office, false)).apply();
  const key = packageSecret(office, "notes", "NOTES_KEY");

  expect(key).toMatch(/^[0-9a-f]{64}$/);
  expect(existsSync(secretsPath(office, "plain"))).toBe(false);
  expect(existsSync(join(office.state, "packages/notes/include.yaml"))).toBe(false);
  (await preparePackageServices(office, false)).apply();
  expect(packageSecret(office, "notes", "NOTES_KEY")).toBe(key);
  writePackage(join(dir, "packages/notes/package.yaml"), "name: notes\ndescription: test\n");
  expect(() => packageSecret(office, "notes", "NOTES_KEY")).toThrow("declares");
});

test("secrets are generated once: a later run adds only new ones and keeps every value", () => {
  const path = join(dir, "doop.env");

  expect(ensureSecrets(path, { DOOP_AUTH: { generate: "hex", bytes: 32 } })).toEqual(["DOOP_AUTH"]);

  const first = readFileSync(path, "utf8");

  expect(first).toMatch(/^DOOP_AUTH=[0-9a-f]{64}\n$/);
  expect(statSync(path).mode & 0o777).toBe(0o600);

  expect(ensureSecrets(path, { DOOP_AUTH: { generate: "hex", bytes: 32 }, DOOP_KEYS: { generate: "base64", bytes: 32, prefix: "k1:" } })).toEqual(["DOOP_KEYS"]);

  const [auth, keys] = readFileSync(path, "utf8").split("\n");

  expect(`${auth}\n`).toBe(first);
  expect(Buffer.from(keys.replace(/^DOOP_KEYS=k1:/, ""), "base64")).toHaveLength(32);
  expect(ensureSecrets(path, { DOOP_AUTH: { generate: "hex", bytes: 32 } })).toEqual([]);
});

test.skipIf(Bun.which("docker") === null)("Compose uses applied package settings despite conflicting shell and project env values", async () => {
  const office = join(dir, "office");
  const before = process.env.CANVAS_PORT;

  write(join(office, "office.yaml"), "name: precedence\nstate: state\npackages:\n  - name: canvas\n    settings:\n      port: 43219\n      title: Cost = lunch\n");
  writePackage(join(office, "packages/canvas/package.yaml"), "name: canvas\ndescription: d\nsettings:\n  port:\n    description: p\n    default: 3000\n  title:\n    description: t\n    default: x\n");
  write(join(office, "packages/canvas/compose.yaml"), 'services:\n  canvas:\n    image: busybox\n    environment:\n      TITLE: ${CANVAS_TITLE}\n    ports: ["127.0.0.1:${CANVAS_PORT}:${CANVAS_PORT}"]\n');
  write(join(office, "packages/canvas/.env"), "CANVAS_PORT=11111\n");
  write(join(office, "state/secrets.env"), "OPENCODE_PASSWORD=test\n");

  const loaded = loadOffice(office);

  (await preparePackageServices(loaded, false)).apply();
  process.env.CANVAS_PORT = "22222";

  try {
    const config = JSON.parse(compose(loaded, ["config", "--format", "json"], { capture: true }));

    expect(config.services.canvas.ports).toEqual([{ mode: "ingress", host_ip: "127.0.0.1", target: 43219, published: "43219", protocol: "tcp" }]);
    expect(config.services.canvas.environment.TITLE).toBe("Cost = lunch");
  } finally {
    if (before === undefined) delete process.env.CANVAS_PORT;
    else process.env.CANVAS_PORT = before;
  }
});

test("a new package applies at once, a changed file waits for --upgrade, and a removed package stops without it", () => {
  const listed = new Set(["new", "changed", "same", "broken", "dropped-file"]);

  const current = new Map<string, string | undefined>([
    ["new", "a"],
    ["changed", "b2"],
    ["same", "c"],
    ["dropped-file", undefined],
  ]);

  // "broken" is listed but can't be read, so it keeps its copy; "gone" left office.yaml.
  const applied = new Map([
    ["changed", "b1"],
    ["same", "c"],
    ["broken", "d"],
    ["dropped-file", "e"],
    ["gone", "f"],
  ]);

  expect(planServices(current, applied, listed, false)).toEqual({
    apply: [
      { name: "gone", from: "f", to: undefined },
      { name: "new", from: undefined, to: "a" },
    ],
    pending: ["changed", "dropped-file"],
  });

  expect(planServices(current, applied, listed, true).apply.map((change) => change.name)).toEqual(["changed", "dropped-file", "gone", "new"]);
});

test("office up runs the applied copy through an include in the package's folder, between the tool's files and the office's", async () => {
  const office = join(dir, "office");
  const services = "services:\n  demo:\n    image: busybox\nvolumes:\n  demo-data:\n";

  write(join(office, "office.yaml"), "name: t\nstate: state\npackages:\n  - name: zeta\n  - name: demo\n    settings:\n      url: https://example.com\n");
  write(join(office, "compose.yaml"), "services: {}\n");

  for (const name of ["demo", "zeta"]) write(join(office, `packages/${name}/compose.yaml`), services.replaceAll("demo", name));

  writePackage(join(office, "packages/demo/package.yaml"), "name: demo\ndescription: d\nsettings:\n  url:\n    description: u\n    required: true\nsecrets:\n  DEMO_KEY:\n    generate: hex\n    bytes: 16\n");
  writePackage(join(office, "packages/zeta/package.yaml"), "name: zeta\ndescription: z\n");

  const loaded = loadOffice(office);
  const first = await preparePackageServices(loaded, false);

  expect(first.upgraded).toEqual([]);
  first.apply();

  const state = join(office, "state/packages");
  const include = parse(readFileSync(join(state, "demo/include.yaml"), "utf8"));

  expect(include).toEqual({ include: [{ path: join(state, "demo/compose.yaml"), project_directory: join(office, "packages/demo"), env_file: [join(state, "demo.env"), join(state, "demo/settings.env")] }] });
  expect(readFileSync(join(state, "demo/settings.env"), "utf8")).toBe("DEMO_URL='https://example.com'\n");
  expect(statSync(state).mode & 0o777).toBe(0o700);

  const files = composeArguments(loaded, []).filter((_, index, args) => args[index - 1] === "-f");

  expect(files.slice(-3)).toEqual([join(state, "demo/include.yaml"), join(state, "zeta/include.yaml"), join(office, "compose.yaml")]);

  // A change waits: the applied copy stays until --upgrade, which names what to back up.
  write(join(office, "packages/demo/compose.yaml"), `${services}# changed\n`);
  (await preparePackageServices(loaded, false)).apply();
  expect(readFileSync(join(state, "demo/compose.yaml"), "utf8")).toBe(services);

  const upgrade = await preparePackageServices(loaded, true);

  expect(upgrade.upgraded).toEqual([{ name: "demo", services: ["demo"], volumes: ["office-t_demo-data"] }]);
  upgrade.apply();
  expect(readFileSync(join(state, "demo/compose.yaml"), "utf8")).toBe(`${services}# changed\n`);

  // Converting a still-selected package to a broken TS definition isn't a service removal.
  rmSync(join(office, "packages/demo/package.yaml"));
  writePackage(join(office, "packages/demo/office.ts"), 'throw new Error("cannot load demo");');
  rmSync(join(office, "packages/demo/compose.yaml"));
  (await preparePackageServices(loaded, true)).apply();
  expect(readFileSync(join(state, "demo/compose.yaml"), "utf8")).toBe(`${services}# changed\n`);
  expect(readFileSync(join(state, "demo/settings.env"), "utf8")).toBe("DEMO_URL='https://example.com'\n");

  // An invalid file is refused rather than applied.
  write(join(office, "packages/zeta/compose.yaml"), "services:\n  web:\n    ports: ['80:80']\n");
  await expect(preparePackageServices(loaded, true)).rejects.toThrow("package zeta: compose.yaml: services.web: must be named zeta or zeta-*");

  // A removed package stops contributing; its secrets stay.
  write(join(office, "office.yaml"), "name: t\nstate: state\npackages:\n  - name: zeta\n");
  write(join(office, "packages/zeta/compose.yaml"), services.replaceAll("demo", "zeta"));
  (await preparePackageServices(loadOffice(office), false)).apply();
  expect(composeArguments(loadOffice(office), []).filter((arg) => arg.includes("include.yaml"))).toEqual([join(state, "zeta/include.yaml")]);
  expect(readFileSync(secretsPath(loaded, "demo"), "utf8")).toMatch(/^DEMO_KEY=[0-9a-f]{32}\n$/);
});

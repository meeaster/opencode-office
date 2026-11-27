import { beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile, runtime } from "../../src/build.ts";

// An end-to-end test spawns the compiled office many times; under a parallel run it gets 30s, not Bun's 5s.
setDefaultTimeout(30_000);

// A compiled executable reads bunfig.toml and .env from the folder it runs in unless the build turns
// that off. Neither may run code or set variables before office's own code does, nor may the
// folder's package.json, which office's build reads.
const root = mkdtempSync(join(tmpdir(), "office-working-directory-"));
const folder = join(root, "folder");
const ran = join(root, "preload-ran");

beforeAll(() => {
  mkdirSync(folder);
  writeFileSync(join(folder, "preload.ts"), `require("node:fs").writeFileSync(${JSON.stringify(ran)}, "ran");\n`);
  writeFileSync(join(folder, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
  writeFileSync(join(folder, ".env"), "OFFICE_PROBE_FROM_DOTENV=loaded\n");
  // The compiled office reads package.json files (for packages' exports); the folder's own changes nothing.
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name: "folder", type: "commonjs", main: "./preload.ts", imports: { "#preload": "./preload.ts" } }));
});

const runIn = (exe: string, args: string[] = []) => Bun.spawnSync([exe, ...args], { cwd: folder, env: { PATH: process.env.PATH, HOME: root } });

/** A probe compiled with `options`: it prints whether the folder's .env reached it. */
async function probe(name: string, options: Record<string, unknown>) {
  const entry = join(root, `${name}.ts`);
  const outfile = join(root, name);

  writeFileSync(entry, "console.log(process.env.OFFICE_PROBE_FROM_DOTENV ?? 'unset');\n");
  const result = await Bun.build({ entrypoints: [entry], compile: { outfile, ...options } });

  if (!result.success) throw new AggregateError(result.logs, "probe build failed");

  return outfile;
}

test("without the runtime options, a compiled executable runs the folder's preload and reads its .env", async () => {
  rmSync(ran, { force: true });
  const out = runIn(await probe("control", {}));

  expect(out.stdout.toString().trim()).toBe("loaded");
  expect(existsSync(ran)).toBe(true);
}, 60_000);

test("with office's runtime options, the folder's preload doesn't run and its .env isn't read", async () => {
  rmSync(ran, { force: true });
  const out = runIn(await probe("guarded", runtime));

  expect(out.stdout.toString().trim()).toBe("unset");
  expect(existsSync(ran)).toBe(false);
}, 60_000);

test("the compiled office doesn't run the folder's preload", async () => {
  rmSync(ran, { force: true });
  const exe = join(root, "bin/office");

  await compile(exe);
  const out = runIn(exe, ["--version"]);

  expect(out.exitCode).toBe(0);
  expect(out.stdout.toString()).toStartWith("office ");
  expect(existsSync(ran)).toBe(false);
}, 120_000);

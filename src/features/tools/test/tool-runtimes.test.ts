import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runtimeFolders } from "../host.ts";
import { miseShims } from "../../machine/host-env.ts";
import { upRuntimes } from "../../../lifecycle-inputs.ts";
import type { Office } from "../../../office.ts";

let dir: string;
const dataDir = process.env.MISE_DATA_DIR;

// mise's shims are found through MISE_DATA_DIR: point it into the test's folder, never the machine's.
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-runtimes-"));
  process.env.MISE_DATA_DIR = join(dir, "mise");
});

afterEach(() => {
  if (dataDir === undefined) delete process.env.MISE_DATA_DIR;
  else process.env.MISE_DATA_DIR = dataDir;
  rmSync(dir, { recursive: true, force: true });
});

function executable(path: string, text: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

test("on a host whose node only mise resolves, with nothing but mise's shims on PATH, the runtimes are the folders the office's mise names", () => {
  const office = join(dir, "office");
  const installs = join(dir, "installs/node/26/bin");
  const mise = join(dir, "pinned/mise");

  mkdirSync(office);
  executable(join(installs, "node"), "#!/bin/sh\n");
  executable(join(miseShims(), "node"), "#!/bin/sh\nexit 1\n");
  executable(mise, `#!/bin/sh\n[ "$1" = which ] && [ "$2" = node ] && [ "$PWD" = "${office}" ] && echo "${installs}/node" && exit 0\nexit 1\n`);

  expect(runtimeFolders({ dir: office }, mise, { PATH: miseShims(), HOME: dir })).toEqual([installs]);
});

const officeIn = (mode: "host" | "container", folder: string) => ({ dir: folder, opencode: { mode }, tools: {} }) as unknown as Office;

test("a host-mode office's up gets only the runtimes its pinned mise resolves, never one on PATH", () => {
  const office = join(dir, "office");
  const onPath = join(dir, "path/bin");
  const mise = join(dir, "pinned/mise");

  mkdirSync(office);
  executable(join(onPath, "node"), "#!/bin/sh\n");
  executable(join(onPath, "pnpm"), "#!/bin/sh\n");
  executable(mise, "#!/bin/sh\nexit 1\n");

  expect(upRuntimes(officeIn("host", office), { PATH: onPath, HOME: dir }, () => mise)).toEqual([]);
});

test("a container-mode office's up gets the runtimes on PATH outside mise's shims, without asking mise", () => {
  const onPath = join(dir, "usr/bin");

  executable(join(miseShims(), "node"), "#!/bin/sh\nexit 1\n");
  executable(join(onPath, "node"), "#!/bin/sh\n");

  expect(upRuntimes(officeIn("container", dir), { PATH: `${miseShims()}:${onPath}` }, () => { throw new Error("mise isn't asked in container mode"); })).toEqual([onPath]);
});

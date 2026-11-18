import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { containerEnvironment, envScript, releaseAgeVariables, sfwLayout, shellQuote, wrapperFiles } from "./sfw.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-sfw-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function executable(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

/** Runs `script` in `shell` with only `path` on PATH; stdout and stderr, and the exit status. */
function run(shell: string, script: string, path: string, env: Record<string, string> = {}) {
  const result = spawnSync(shell, ["-c", script], { encoding: "utf8", env: { PATH: path, HOME: dir, ...env } });

  return { out: result.stdout, err: result.stderr, status: result.status };
}

function available(shell: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${shell}`]).status === 0;
}

/** A layout in the scratch folder, with a fake sfw and a fake mise that print what they were run with. */
function fakes() {
  const layout = sfwLayout(join(dir, "office/sfw"), join(dir, "office/sfw/sfw"), join(dir, "real/mise"));
  const files = wrapperFiles(layout);
  const tools = join(dir, "tools");

  executable(layout.sfw, `#!/bin/sh\necho "sfw $* behind=$OFFICE_BEHIND_SFW path=$PATH"\nexec "$@"\n`);
  // A script can't see the name it was run as (the kernel passes the interpreter its path), so the
  // fake shows only how it was run; the real mise's use of its name is proven against mise itself.
  executable(layout.mise, `#!/bin/sh\necho "mise $*"\n`);
  executable(files.script.path, files.script.text);
  executable(files.mise.path, files.mise.text);

  for (const link of files.links) symlinkSync(link.target, link.path);

  // The real npm, which runs npm again as an npm script does.
  executable(join(tools, "npm"), `#!/bin/sh\necho "real npm $* behind=$OFFICE_BEHIND_SFW"\n[ "$1" = nested ] && npm inner\nexit 0\n`);

  return { layout, tools };
}

test("each package manager's wrapper runs the real command through sfw once, nested calls included", () => {
  const { layout, tools } = fakes();
  const path = `${layout.bin}:${tools}:/usr/bin:/bin`;

  expect(run("sh", "npm install left-pad", path).out).toBe(`sfw npm install left-pad behind=1 path=${tools}:/usr/bin:/bin\nreal npm install left-pad behind=1\n`);

  // An npm script that runs npm reaches the real one, even with the wrappers back on PATH.
  expect(run("sh", "npm nested", path).out).toBe(`sfw npm nested behind=1 path=${tools}:/usr/bin:/bin\nreal npm nested behind=1\nreal npm inner behind=1\n`);
  expect(run("sh", "npm direct", path, { OFFICE_BEHIND_SFW: "1" }).out).toBe("real npm direct behind=1\n");
});

test("the mise wrapper runs installs through sfw, reshim without its folder, and everything else as the name it was called by", () => {
  const { layout, tools } = fakes();
  const path = `${layout.bin}:${tools}:/usr/bin:/bin`;
  const mise = join(layout.bin, "mise");

  expect(run("sh", "mise install node@24", path).out).toBe(`sfw ${layout.mise} install node@24 behind=1 path=${tools}:/usr/bin:/bin\nmise install node@24\n`);
  expect(run("sh", "mise use -g jq", path).out).toStartWith(`sfw ${layout.mise} use -g jq behind=1`);
  expect(run("sh", "mise ls", path).out).toBe("mise ls\n");
  expect(run("sh", "OFFICE_BEHIND_SFW=1 mise install", path).out).toBe("mise install\n");

  // reshim runs without the wrappers' folder on PATH, so mise points its shims at the real mise.
  writeFileSync(layout.mise, `#!/bin/sh\necho "mise $* path=$PATH"\n`);
  expect(run("sh", "mise reshim", path).out).toBe(`mise reshim path=${tools}:/usr/bin:/bin\n`);
  expect(run("sh", "mise ls", path).out).toBe(`mise ls path=${path}\n`);

  // A shim mise made pointing at the wrapper runs the real mise, not sfw.
  symlinkSync(mise, join(dir, "node"));
  expect(run("sh", `${shellQuote(join(dir, "node"))} install`, path).out).toBe(`mise install path=${path}\n`);
});

const environment = { path: ["/opt/office/sfw/bin", "/home/u/.local/share/mise/shims", "/home/u/.opencode/bin", "/opt/it's here"], variables: [["NPM_CONFIG_MIN_RELEASE_AGE", "3"], ["QUOTED", "a 'b' $c `d`"]] satisfies [string, string][] };

for (const shell of ["sh", "bash", "zsh"]) {
  test.skipIf(!available(shell))(`the environment file sourced twice in ${shell} puts its PATH entries first once, sets the variables and prints nothing`, () => {
    const file = join(dir, "env.sh");

    writeFileSync(file, envScript("test", file, environment));

    const start = "/usr/bin:/home/u/.opencode/bin:/bin";
    const script = `. ${shellQuote(file)}; . ${shellQuote(file)}; printf '%s|%s|%s|%s' "$PATH" "$NPM_CONFIG_MIN_RELEASE_AGE" "$QUOTED" "$OFFICE_ENV_FILE"`;

    expect(run(shell, script, start)).toEqual({ out: `${environment.path.join(":")}:/usr/bin:/bin|3|a 'b' $c \`d\`|${file}`, err: "", status: 0 });
    expect(run(shell, `PATH=; . ${shellQuote(file)}; printf '%s' "$PATH"`, start).out).toBe(environment.path.join(":"));
  });
}

test("the container's environment has the wrappers only while the firewall is on, and the release ages either way", () => {
  expect(containerEnvironment(true)).toEqual({ path: ["/usr/local/lib/office/sfw/bin", "/home/office/.local/share/mise/shims"], variables: Object.entries(releaseAgeVariables) });
  expect(containerEnvironment(false).path).toEqual(["/home/office/.local/share/mise/shims"]);
});

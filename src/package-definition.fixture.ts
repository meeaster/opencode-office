// The compiled-office fixture the package-definition end-to-end files share. Each file calls
// definitionFixture() once, at the top level: it registers that file's own beforeAll/afterAll, so
// files run in parallel each get their own executables and scratch folder.
import { afterAll, beforeAll, expect, setDefaultTimeout } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compile } from "./build.ts";
import { git } from "./git.ts";
import { writePackage } from "./test-package.ts";
import type officePlugin from "../packages/office/plugin/index.ts";

export function definitionFixture() {
  // Each test spawns the compiled office many times; under a parallel run it gets 30s, not Bun's 5s.
  setDefaultTimeout(30_000);

  const root = mkdtempSync(join(tmpdir(), "office-definition-"));
  const fixtureMarker = join(root, ".compiled-office-test");

  writeFileSync(fixtureMarker, import.meta.url);

  const bin = join(root, "bin");
  const exe = join(bin, "office");
  const variant = join(root, "distribution/target/office");
  const marker = `import {appendFileSync} from "node:fs"; appendFileSync(process.env.PROBE, "imported\\n");`;

  function write(path: string, text: string, mode = 0o644) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, { mode });
  }

  const read = (path: string) => readFileSync(path, "utf8");

  function commit(repo: string) {
    git(["add", "-A"], repo);
    git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"], repo);

    return git(["rev-parse", "HEAD"], repo);
  }

  beforeAll(async () => {
    mkdirSync(bin);
    await compile(exe);
    const gitPath = Bun.which("git");

    if (!gitPath) throw new Error("git required for the pinned package fixture");

    symlinkSync(gitPath, join(bin, "git"));
    // Only the unrelated health checks get stand-ins: an empty list of containers and tool versions.
    write(join(bin, "docker"), '#!/bin/sh\ncase "$*" in "compose "*" ps --status running --format {{.Service}}") exit 0;; *) exit 1;; esac\n', 0o755);

    for (const name of ["sops", "age", "age-keygen"]) write(join(bin, name), '#!/bin/sh\n[ "$1" = --version ] && echo 1.0.0\n', 0o755);

    // Build a second distribution, without modifying the checkout's packages or template.
    const dist = join(root, "distribution");
    const checkout = dirname(import.meta.dir);
    git(["init", "-q", dist]);

    for (const path of ["src", "standard", "packages", "template", "image", "compose.yaml", "LICENSE", "package.json"]) cpSync(join(checkout, path), join(dist, path), { recursive: true });
    writePackage(join(dist, "packages/arrival/office.ts"), `${marker} export default { name: "arrival", description: "Newly shipped" }`);
    writePackage(join(dist, "packages/legacy/package.yaml"), "name: legacy\ndescription: Legacy YAML fixture\n");
    const aws = join(dist, "packages/aws-emulator/office.ts");
    write(aws, read(aws).replace("if (!includeSource) return;", 'throw Error("changed built-in collector");'));
    const commands = join(dist, "packages/references/office.ts");
    write(commands, read(commands).replace("ctx.command(listing)", 'ctx.command({ ...listing, run(inputs) { console.log("variant package handler"); listing.run(inputs) } })'));
    const changed = join(dist, "packages/artifact-share");
    write(join(changed, "office.ts"), 'import title from "./missing.ts"; export default {name:"artifact-share", description:title}');
    write(join(changed, "plugin/index.ts"), "// replacement");
    const template = join(dist, "template/office/office.yaml");
    write(template, `${read(template)}  - name: artifact-share\n`);
    commit(dist);
    symlinkSync(join(checkout, "node_modules"), join(dist, "node_modules"));
    const built = Bun.spawnSync([process.execPath, "src/build.ts"], { cwd: dist, env: { ...process.env, HOME: root } });
    expect(built.exitCode, built.stderr.toString()).toBe(0);
  }, 60_000);

  afterAll(() => {
    if (read(fixtureMarker) !== import.meta.url) throw new Error(`refusing cleanup of unmarked fixture ${root}`);
    rmSync(root, { recursive: true, force: true });
  });

  // Exercise the installed bundle through the same prompt hook that writes the session entry.
  async function prompt(dir: string, folder: string) {
    const plugin: typeof officePlugin = (await import(join(dir, ".opencode/plugins/office/index.js"))).default;
    const hooks: ((event: { sessionID: string }) => Promise<void>)[] = [];
    const registration = { dispose: async () => {} };
    let text = "";

    const close = await plugin.setup({
      location: { directory: folder },
      session: {
        async hook(_, handler) {
          hooks.push(handler);

          return registration;
        },
        instructions: { entry: { async put(entry) {
          expect(entry.key).toBe("office");
          text = entry.value;
        } } },
        compact: async () => ({}),
      },
      skill: { transform: async () => registration, list: async () => ({ data: [] }), reload: async () => {} },
      mcp: { transform: async () => registration },
      tool: { transform: async () => registration },
    });

    try {
      for (const hook of hooks) await hook({ sessionID: "fixture" });

      return text;
    } finally {
      close?.();
    }
  }

  function fixture(name: string) {
    const dir = join(root, name);
    const home = join(root, `${name}-home`);
    mkdirSync(home);

    const probe = join(home, "imports");

    const env = {
      HOME: home, PATH: `${home}/bin:${bin}`, NO_COLOR: "1", TMPDIR: root, GIT_ALLOW_PROTOCOL: "file",
      DOCKER_HOST: `unix://${home}/absent.sock`, DBUS_SESSION_BUS_ADDRESS: `unix:path=${home}/absent-bus`,
      OFFICE_MACHINE_RECORD: join(home, "record.json"), OFFICE_MISE_CONFIG_DIR: join(home, "mise"), OFFICE_MACHINE_DIR: join(home, "machine"),
      OFFICE_APP_CONFIG_DIR: join(home, "app"), OFFICE_APP_PANELS_DIR: join(home, "panels"), OFFICE_SYSTEMD_USER_DIR: join(home, "units"), PROBE: probe,
    };

    const run = (binary: string, status: number, ...args: string[]) => {
      const result = Bun.spawnSync([binary, ...args], { cwd: root, env });
      const output = result.stdout.toString() + result.stderr.toString();

      expect(result.exitCode, output).toBe(status);

      return output;
    };

    run(exe, 0, "init", dir);
    const config = join(dir, "office.yaml");
    const initial = read(config);
    const cli = (status: number, ...args: string[]) => run(exe, status, "--office", dir, ...args);
    const newer = (status: number, ...args: string[]) => run(variant, status, "--office", dir, ...args);

    return { dir, home, env, probe, cli, newer, run, select: (entries: string) => write(config, initial + entries) };
  }

  /**
   * What sync last published in .office/current/references.json, one reference per line as
   * `office references list` prints it. That command loads packages live, so tests of sync's
   * publication read the saved file.
   */
  function published(dir: string) {
    type Row = { name: string; url: string; ref?: string };
    const saved: { owner: Row[]; contributors: { name: string; stale: boolean; entries: { id: string; value: Row }[] }[] } = JSON.parse(read(join(dir, ".office/resolved/references.json")));
    const line = (row: Row, owner: string) => `${row.name}\t${row.url}${row.ref ? ` @ ${row.ref}` : ""}\t${owner}`;

    return [
      ...saved.owner.map(row => line(row, "office.yaml")),
      ...saved.contributors.flatMap(group => group.entries.filter(entry => entry.id === "references.repository").map(entry => line(entry.value, `package ${group.name}${group.stale ? " (stale)" : ""}`))),
    ].map(row => `${row}\n`).join("");
  }

  function collector(url: string, ref = "main", after = "") {
    const value = JSON.stringify({ name: "docs", url, ref });

    return `export default {name:"docs",description:"Docs",async setup({add}) {add({registry:"references.repository",value:${value}});${after}}}`;
  }

  /** Pause this invocation after real Git finished each network fetch, before Office can apply. */
  async function pausedRefresh(f: ReturnType<typeof fixture>, count = 1) {
    const gate = mkdtempSync(join(root, "fetch-gate-"));
    write(join(f.home, "bin/git"), `#!/bin/sh
  set -eu
  if [ "$1" != fetch ] || [ -z "\${FETCH_GATE:-}" ]; then exec "${bin}/git" "$@"; fi
  "${bin}/git" "$@"
  : > "$FETCH_GATE/\${PWD##*/}"
  while [ ! -f "$FETCH_GATE/go" ]; do /bin/sleep 0.02; done
  `, 0o755);

    const process = Bun.spawn([exe, "--office", f.dir, "sync", "--references"], {
      cwd: f.dir, env: { ...f.env, FETCH_GATE: gate }, stdout: "pipe", stderr: "pipe",
    });

    const output = Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text()]);

    for (let i = 0; i < 500 && readdirSync(gate).length < count && process.exitCode === null; i++) await Bun.sleep(20);

    if (readdirSync(gate).length !== count) {
      write(join(gate, "go"), "");
      process.kill();
      throw new Error(`fetch barrier not reached: ${(await output).join("")}`);
    }

    return {
      async resume(expected: number) {
        write(join(gate, "go"), "");
        const status = await process.exited;
        const text = (await output).join("");
        expect(status, text).toBe(expected);

        return text;
      },
      interrupt() { process.kill("SIGINT"); },
    };
  }


  return { root, bin, exe, variant, marker, write, read, commit, prompt, fixture, collector, pausedRefresh, published };
}

export type DefinitionFixture = ReturnType<ReturnType<typeof definitionFixture>["fixture"]>;

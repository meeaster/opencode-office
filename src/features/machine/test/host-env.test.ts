import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { machineFixture, makeEnvironmentOffice as makeOffice, write } from "../../../../test/support/machine.fixture.ts";
import { syncLines as sync } from "../../../../test/support/sync.fixture.ts";
import { definitionText, writePackage } from "../../../../test/support/test-package.ts";
import { gatherPackages } from "../../../gather.ts";
import { loadOffice } from "../../../office.ts";
import { parseManifest } from "../../../loader/sources/manifest-schema.ts";
import { globalConfD } from "../../mise-integration/machine-files.ts";
import { projectionPath } from "../../tools/applied.ts";
import { hostWrappers } from "../../tools/sfw.ts";
import { hostEnvironment, sourcedBy, sourceLine } from "../host-env.ts";
import { envFilePath } from "../paths.ts";
import { grantConsent } from "../record.ts";
import { configureStartup } from "../shell-startup.ts";

const fixture = machineFixture({ scratchHome: true });

test("setup adds bash activation before an existing office source and doesn't prompt twice", async () => {
  const { dir } = fixture;

  const file = join(dir, "home/.bashrc");
  const original = `# eval "$(mise activate bash)"\nsource '${envFilePath()}'\n`;
  write(file, original);
  expect(await configureStartup("bash", "mise", async () => "no")).toBe(true);
  expect(readFileSync(file, "utf8")).toBe(original);
  expect(await configureStartup("bash", "mise", async () => "yes")).toBe(false);
  expect(readFileSync(file, "utf8")).toBe(original.replace("\nsource", '\neval "$(mise activate bash)"\nsource'));
  expect(await configureStartup("bash", "mise")).toBe(false);
});

test("setup follows zsh's sourced activation and updates the linked rc in ZDOTDIR", async () => {
  const { dir } = fixture;

  const folder = join(dir, "zsh");
  const linked = join(folder, "dotfile");
  process.env.ZDOTDIR = folder;
  write(join(dir, "home/tools"), 'eval "$(mise activate zsh)"\n');
  write(linked, 'source "$HOME/tools"');
  symlinkSync(linked, join(folder, ".zshrc"));
  expect(await configureStartup("zsh", "mise", async () => "yes")).toBe(false);
  expect(readFileSync(linked, "utf8")).toBe(`source "$HOME/tools"\n${sourceLine()}\n`);
  expect(await configureStartup("zsh", "mise")).toBe(false);
});

test("the environment file carries the office's minimum release age, and sync rewrites it when the age changes", async () => {
  const { office } = fixture;

  makeOffice(office, { tools: "minimum_release_age: 36h\n" });
  grantConsent(loadOffice(office), "");
  await sync(loadOffice(office));

  const variables = () => Bun.spawnSync(["sh", "-c", `. '${envFilePath()}'; printf '%s|%s|%s|%s|%s' "$NPM_CONFIG_MIN_RELEASE_AGE" "$pnpm_config_minimum_release_age" "\${UV_EXCLUDE_NEWER-unset}" "\${PIP_UPLOADED_PRIOR_TO-unset}" "$MISE_MINIMUM_RELEASE_AGE"`], { env: { PATH: "/usr/bin:/bin" } }).stdout.toString();

  expect(variables()).toBe("2|2160|36 hours|P2D|36h");

  makeOffice(office, { tools: "minimum_release_age: 0d\n" });
  expect(await sync(loadOffice(office))).toContain(`rewrote ${envFilePath()}, the office's environment file`);
  expect(variables()).toBe("0|0|unset|unset|0d");

  // With the firewall off the ages still apply.
  makeOffice(office, { firewall: false });
  await sync(loadOffice(office));
  expect(variables()).toBe("3|4320|3 days|P3D|3d");
});

test("a package's host PATH entries add package-relative, home-relative and absolute folders", async () => {
  const { dir, office } = fixture;

  makeOffice(office, { path: ["bin", "~/.local/bin", "/opt/demo/bin"] });
  grantConsent(loadOffice(office), "");
  await sync(loadOffice(office));

  const env = readFileSync(envFilePath(), "utf8");

  expect(env).toContain(`__office_path '${join(office, "packages/demo/bin")}'`);
  expect(env).toContain(`__office_path '${join(dir, "home/.local/bin")}'`);

  const sourced = Bun.spawnSync(["sh", "-c", `. '${envFilePath()}'; printf '%s' "$PATH"`], { env: { PATH: "/usr/bin:/bin" } }).stdout.toString();

  expect(sourced).toBe(`${hostWrappers()}:${projectionPath(loadOffice(office))}:${join(process.env.MISE_DATA_DIR || join(dir, "home/.local/share/mise"), "shims")}:${join(dir, "home/.opencode/bin")}:${join(office, "packages/demo/bin")}:${join(dir, "home/.local/bin")}:/opt/demo/bin:/usr/bin:/bin`);

  const manifest = join(office, "packages/demo/package.json");
  const json = readFileSync(manifest, "utf8");
  write(manifest, "{");
  expect((await sync(loadOffice(office))).join("\n")).toContain("FAILED package demo: package.json: JSON Parse error");
  expect(readFileSync(envFilePath(), "utf8")).toBe(env);
  write(manifest, json);
});

test("a required package can contribute a host PATH entry without a settings entry in office.yaml", async () => {
  const { office: dir } = fixture;

  makeOffice(dir);
  const office = loadOffice(dir);
  await sync(office);

  const { packages } = await gatherPackages(office);
  const tools = packages.find(item => item.entry.name === "tools");

  if (!tools) throw new Error("required tools package did not load");
  tools.manifest.host = { path: ["bin"] };

  expect(hostEnvironment(office, packages).environment.path).toContain(join(tools.dir, "bin"));
});

test("a package that fails to read stops sync: a deselected package's machine inputs stay with everyone else's", async () => {
  const { office } = fixture;

  const host = (name: string) => definitionText(`{
    host: { path: ["${name}-bin"] },
    setup(ctx) {
      ctx.add(installs, { name: "install", description: "Install", destination: "~/.local/bin/${name}", ready: "~/.local/bin/${name}", script: "install.ts", executable: true });
    },
  }`, 'const installs = { id: "mise-integration.installs", parse: value => value };');

  makeOffice(office, { firewall: false });
  const config = join(office, "office.yaml");
  const initial = readFileSync(config, "utf8");
  write(config, `${initial}  - name: other\n`);

  for (const name of ["demo", "other"]) {
    writePackage(join(office, `packages/${name}/office.ts`), host(name));
    write(join(office, `packages/${name}/install.ts`), "");
  }

  grantConsent(loadOffice(office), "");
  const run = () => sync(loadOffice(office), { scope: "packages" });
  expect((await run()).join("\n")).not.toContain("FAILED");
  const link = (name: string) => join(globalConfD(), `office-t-1-${name}.toml`);
  const before = readFileSync(link("demo"), "utf8");
  expect(readFileSync(link("other"), "utf8")).toContain("other:install");
  expect(readFileSync(envFilePath(), "utf8")).toContain("/other/other-bin");
  write(config, initial);
  writePackage(join(office, "packages/demo/office.ts"), "[bad");
  const env = readFileSync(envFilePath(), "utf8");
  expect((await run()).join("\n")).toContain("FAILED package demo");
  expect(readFileSync(link("demo"), "utf8")).toBe(before);
  expect(readFileSync(link("other"), "utf8")).toContain("other:install");
  expect(existsSync(join(office, ".office/mise/other.toml"))).toBe(true);
  expect(readFileSync(envFilePath(), "utf8")).toBe(env);
  // Fixed, the next sync withdraws the deselected package's inputs.
  writePackage(join(office, "packages/demo/office.ts"), host("demo"));
  expect((await run()).join("\n")).not.toContain("FAILED");
  expect(lstatSync(link("other"), { throwIfNoEntry: false })).toBeUndefined();
  expect(readFileSync(envFilePath(), "utf8")).not.toContain("/other/other-bin");
  expect(readFileSync(envFilePath(), "utf8")).toContain("/demo/demo-bin");
});

test("host PATH entries cannot contain shell code, PATH separators or parent traversal", () => {
  const errors = (path: string[]) => {
    const result = parseManifest("bad", { host: { path } });

    return result.ok ? [] : result.errors;
  };

  expect(errors(["$HOME/bin"])).toEqual([expect.stringContaining("host.path[0]: must be a folder such as ~/.local/bin")]);
  expect(errors(["a:b"])).toHaveLength(1);
  expect(errors(["../elsewhere"])).toEqual(["host.path[0]: must not climb out with .."]);
  expect(errors(["bin", "~/x", "/opt/y"])).toEqual([]);
});

test("check finds the line that sources the environment file through a linked startup file, or a file it sources, or the shell's own variable", () => {
  const { dir } = fixture;

  const home = join(dir, "home");
  const dotfiles = join(dir, "dotfiles");

  expect(sourceLine()).toBe(`[ -r '${envFilePath()}' ] && . '${envFilePath()}'`);
  expect(sourcedBy()).toBeUndefined();

  // ~/.zshrc is a link into a dotfiles repository, which sources another file that names it.
  write(join(dotfiles, "zshrc"), `# . ${envFilePath()} is commented here\nsource ~/.config/zsh/office.zsh\n`);
  mkdirSync(home, { recursive: true });
  symlinkSync(join(dotfiles, "zshrc"), join(home, ".zshrc"));

  expect(sourcedBy()).toBeUndefined();

  write(join(home, ".config/zsh/office.zsh"), `${sourceLine()}\n`);
  expect(sourcedBy()).toBe(`${join(home, ".config/zsh/office.zsh")}, which ${join(home, ".zshrc")} sources`);

  write(join(dotfiles, "zshrc"), `${sourceLine()}\n`);
  expect(sourcedBy()).toBe(join(home, ".zshrc"));

  rmSync(join(home, ".zshrc"));
  process.env.OFFICE_ENV_FILE = envFilePath();
  expect(sourcedBy()).toBe("this shell's environment (OFFICE_ENV_FILE)");
});

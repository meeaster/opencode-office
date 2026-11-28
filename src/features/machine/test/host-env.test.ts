import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { machineFixture, makeEnvironmentOffice as makeOffice, write } from "../../../../test/support/machine.fixture.ts";
import { syncLines as sync } from "../../../../test/support/sync.fixture.ts";
import { writePackage } from "../../../../test/support/test-package.ts";
import { loadOffice } from "../../../office.ts";
import { parseManifest } from "../../../schema.ts";
import { globalConfD } from "../../mise-integration/machine-files.ts";
import { projectionPath } from "../../tools/applied.ts";
import { hostWrappers } from "../../tools/sfw.ts";
import { sourcedBy, sourceLine } from "../host-env.ts";
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

test("a package's host block adds folders and variables to the environment file; two packages setting one variable fail", async () => {
  const { dir, office } = fixture;

  makeOffice(office, { host: "host:\n  path: [bin, ~/.local/bin, /opt/demo/bin]\n  env:\n    DEMO_MODE: \"it's on\"\n    DEMO_PORT: 8080\n" });
  grantConsent(loadOffice(office), "");
  await sync(loadOffice(office));

  const env = readFileSync(envFilePath(), "utf8");

  expect(env).toContain(`__office_path '${join(office, "packages/demo/bin")}'`);
  expect(env).toContain(`__office_path '${join(dir, "home/.local/bin")}'`);
  expect(env).toContain("export DEMO_MODE='it'\\''s on'\nexport DEMO_PORT='8080'\n");

  const sourced = Bun.spawnSync(["sh", "-c", `. '${envFilePath()}'; printf '%s|%s' "$PATH" "$DEMO_MODE"`], { env: { PATH: "/usr/bin:/bin" } }).stdout.toString();

  expect(sourced).toBe(`${hostWrappers()}:${projectionPath(loadOffice(office))}:${join(process.env.MISE_DATA_DIR || join(dir, "home/.local/share/mise"), "shims")}:${join(dir, "home/.opencode/bin")}:${join(office, "packages/demo/bin")}:${join(dir, "home/.local/bin")}:/opt/demo/bin:/usr/bin:/bin|it's on`);

  const manifest = join(office, "packages/demo/package.json");
  const json = readFileSync(manifest, "utf8");
  write(manifest, "{");
  expect((await sync(loadOffice(office))).join("\n")).toContain("FAILED package demo: package.json: JSON Parse error");
  expect(readFileSync(envFilePath(), "utf8")).toBe(env);
  write(manifest, json);

  write(join(office, "office.yaml"), `${readFileSync(join(office, "office.yaml"), "utf8")}  - name: other\n`);
  writePackage(join(office, "packages/other/package.yaml"), "host:\n  env:\n    DEMO_MODE: off\n");

  expect(await sync(loadOffice(office))).toContain(`FAILED packages demo and other both set DEMO_MODE in their host or system block, so ${envFilePath()} sets neither; remove it from one`);
  expect(readFileSync(envFilePath(), "utf8")).not.toContain("DEMO_MODE");
});

test("a package that fails to read stops sync: a deselected package's machine inputs stay with everyone else's", async () => {
  const { office } = fixture;

  const host = (name: string) => `host:\n  path: [${name}-bin]\n  env: { ${name.toUpperCase()}_MODE: ok }\n  install: {description: Install, creates: ~/.local/bin/${name}, script: install.ts}\n`;
  makeOffice(office, { firewall: false, host: host("demo") });
  const config = join(office, "office.yaml");
  const initial = readFileSync(config, "utf8");
  write(config, `${initial}  - name: other\n`);
  writePackage(join(office, "packages/other/package.yaml"), `${host("other")}`);

  for (const name of ["demo", "other"]) write(join(office, `packages/${name}/install.ts`), "");
  grantConsent(loadOffice(office), "");
  const run = () => sync(loadOffice(office), { scope: "packages" });
  expect((await run()).join("\n")).not.toContain("FAILED");
  const link = (name: string) => join(globalConfD(), `office-t-1-${name}.toml`);
  const before = readFileSync(link("demo"), "utf8");
  expect(readFileSync(link("other"), "utf8")).toContain("other:install");
  expect(readFileSync(envFilePath(), "utf8")).toContain("OTHER_MODE");
  write(config, initial);
  writePackage(join(office, "packages/demo/package.yaml"), "[bad");
  const env = readFileSync(envFilePath(), "utf8");
  expect((await run()).join("\n")).toContain("FAILED package demo");
  expect(readFileSync(link("demo"), "utf8")).toBe(before);
  expect(readFileSync(link("other"), "utf8")).toContain("other:install");
  expect(existsSync(join(office, ".office/mise/other.toml"))).toBe(true);
  expect(readFileSync(envFilePath(), "utf8")).toBe(env);
  // Fixed, the next sync withdraws the deselected package's inputs.
  writePackage(join(office, "packages/demo/package.yaml"), host("demo"));
  expect((await run()).join("\n")).not.toContain("FAILED");
  expect(lstatSync(link("other"), { throwIfNoEntry: false })).toBeUndefined();
  expect(readFileSync(envFilePath(), "utf8")).not.toContain("OTHER_MODE");
  expect(readFileSync(envFilePath(), "utf8")).toContain("export DEMO_MODE='ok'");
});

test("a host block's folders and variables are plain: no shell code, PATH separators or variables office sets", () => {
  const errors = (host: string) => {
    const result = parseManifest("bad", Bun.YAML.parse(`host:\n${host}`));

    return result.ok ? [] : result.errors;
  };

  expect(errors("  path: [\"$HOME/bin\"]\n")).toEqual([expect.stringContaining("host.path[0]: must be a folder such as ~/.local/bin")]);
  expect(errors("  path: [\"a:b\"]\n")).toHaveLength(1);
  expect(errors("  path: [../elsewhere]\n")).toEqual(["host.path[0]: must not climb out with .."]);
  expect(errors("  env:\n    PATH: /bin\n")).toEqual([expect.stringContaining("is set by office itself")]);
  expect(errors("  env:\n    MISE_MINIMUM_RELEASE_AGE: 1h\n")).toEqual([expect.stringContaining("is set by office itself")]);
  expect(errors("  env:\n    OFFICE_X: y\n")).toHaveLength(1);
  expect(errors("  env:\n    \"A B\": y\n")).toEqual([expect.stringContaining("must be an environment variable name")]);
  expect(errors("  env:\n    MULTI: \"a\\nb\"\n")).toEqual([expect.stringContaining("must be one line of plain text")]);
  expect(errors("  path: [bin, ~/x, /opt/y]\n  env:\n    OK: \"$not expanded`\"\n")).toEqual([]);
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

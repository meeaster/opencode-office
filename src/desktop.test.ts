import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type AppMachine, installPanel, locate, panelState, type Probe, register, withPlugin } from "./desktop.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-desktop-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A machine with the given files and commands; any other command fails. */
function probe({ env = {}, files = {}, commands = {} }: { env?: Record<string, string>; files?: Record<string, string>; commands?: Record<string, (args: string[]) => string> }): Probe {
  return {
    env,
    home: "/home/someone",
    exists: (path) => path in files,
    read: (path) => {
      const content = files[path];

      if (content === undefined) throw new Error(`ENOENT: ${path}`);

      return content;
    },
    run: (command, args) => {
      const run = commands[command];

      if (run === undefined) throw new Error(`${command}: not found`);

      return run(args);
    },
  };
}

const wslKernel = { "/proc/version": "Linux version 6.18.58.1-microsoft-standard-WSL2 (gcc 13.2.0)" };

const windowsCommands = {
  "/mnt/c/Windows/System32/cmd.exe": () => "C:\\Users\\Some One|C:\\Users\\Some One\\AppData\\Local\r\n",
  wslpath: ([, path = ""]: string[]) => `/mnt/c/${path.slice(3).replaceAll("\\", "/")}\n`,
};

test("in WSL, Windows' folders come through cmd.exe off the PATH and wslpath, and the panel URL is Windows'", () => {
  const where = locate(probe({ files: wslKernel, commands: windowsCommands }));

  if (where.kind !== "app") throw new Error(`expected an app machine, got ${where.kind}`);

  expect(where.machine.configDir).toBe("/mnt/c/Users/Some One/.config/opencode");
  expect(where.machine.panelsDir).toBe("/mnt/c/Users/Some One/AppData/Local/office/gui");
  expect(where.machine.url("tracks")).toBe("file:///C:/Users/Some%20One/AppData/Local/office/gui/tracks");
});

test("WSL is recognised by its interop entry when the kernel version doesn't say", () => {
  const where = locate(probe({ files: { "/proc/sys/fs/binfmt_misc/WSLInterop": "" }, commands: windowsCommands }));

  expect(where.kind === "app" && where.machine.label).toBe("Windows");
});

test("in WSL without a reachable Windows, the reason is reported instead of a folder", () => {
  const where = locate(probe({ files: wslKernel }));

  expect(where.kind).toBe("unreachable");
  expect(where.kind === "unreachable" && where.reason).toContain("Windows couldn't be asked");
});

test("inside a container there is no app machine; on a plain host it is this one, under its XDG folders", () => {
  expect(locate(probe({ files: { "/.dockerenv": "", ...wslKernel }, commands: windowsCommands })).kind).toBe("container");

  const host = locate(probe({ env: { XDG_DATA_HOME: "/data" } }));

  expect(host.kind === "app" && [host.machine.configDir, host.machine.panelsDir, host.machine.url("tracks")]).toEqual(["/home/someone/.config/opencode", "/data/office/gui", "file:///data/office/gui/tracks"]);
});

test("the environment's folders override every detection, the container included", () => {
  const where = locate(probe({ env: { OFFICE_APP_CONFIG_DIR: "/c", OFFICE_APP_PANELS_DIR: "/p" }, files: { "/.dockerenv": "" } }));

  expect(where.kind === "app" && [where.machine.configDir, where.machine.panelsDir]).toEqual(["/c", "/p"]);
});

test("a plugin joins an existing list, keeping comments, formatting and every other key", () => {
  const text = `{
  // the app's own plugins
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "file:///C:/Users/x/AppData/Local/cairn-desktop", // Cairn
  ],
  "mcp": { "plugins": [] }
}
`;

  expect(withPlugin(text, "file:///p/tracks")).toEqual({
    kind: "added",
    text: `{
  // the app's own plugins
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "file:///C:/Users/x/AppData/Local/cairn-desktop", // Cairn
    "file:///p/tracks"
  ],
  "mcp": { "plugins": [] }
}
`,
  });

  expect(withPlugin('{\n  "plugins": [\n    "a" // first\n  ]\n}', "b")).toEqual({ kind: "added", text: '{\n  "plugins": [\n    "a", // first\n    "b"\n  ]\n}' });
});

test("a list on one line stays on one line, an empty list takes the entry, and a config without plugins gets the key", () => {
  expect(withPlugin('{"plugins": ["a"], "x": 1}', "b")).toEqual({ kind: "added", text: '{"plugins": ["a", "b"], "x": 1}' });
  expect(withPlugin('{"plugins": []}', "b")).toEqual({ kind: "added", text: '{"plugins": ["b"]}' });
  expect(withPlugin('{\n  "x": 1\n}\n', "b")).toEqual({ kind: "added", text: '{\n  "plugins": ["b"],\n  "x": 1\n}\n' });
  expect(withPlugin("{}", "b")).toEqual({ kind: "added", text: '{ "plugins": ["b"] }' });
});

test("an entry already there, alone or with options, changes nothing; a config that isn't an object is refused", () => {
  expect(withPlugin('{"plugins": [["b", {"x": 1}]]}', "b")).toEqual({ kind: "present" });
  expect(withPlugin('{"plugins": ["b"]}', "b")).toEqual({ kind: "present" });
  expect(withPlugin('{"plugins": "b"}', "b").kind).toBe("failed");
  expect(withPlugin("[1]", "b").kind).toBe("failed");
});

function machine(): AppMachine {
  return { label: "the test machine", configDir: join(dir, "config"), panelsDir: join(dir, "panels"), url: (name) => `file:///panels/${name}` };
}

test("a panel installs GUI-only with a record, registers once, and the last office to sync it wins", () => {
  const app = machine();
  const bundle = join(dir, "bundle.cjs");

  writeFileSync(bundle, "module.exports = 1;\n");
  mkdirSync(app.configDir, { recursive: true });
  writeFileSync(join(app.configDir, "opencode.json"), '{\n  "plugins": ["file:///other"],\n  "secret": "kept"\n}\n');

  const first = installPanel(app, { name: "one", dir: "/offices/one" }, { name: "tracks", bundle });

  expect(first).toEqual([`installed panel office-tracks on the test machine in ${join(app.panelsDir, "tracks")}`, `added file:///panels/tracks to plugins in ${join(app.configDir, "opencode.json")}`]);
  expect(JSON.parse(readFileSync(join(app.panelsDir, "tracks/package.json"), "utf8"))).toEqual({ name: "office-tracks", exports: { "./gui-experimental": "./gui-experimental.cjs" } });
  expect(readFileSync(join(app.panelsDir, "tracks/gui-experimental.cjs"), "utf8")).toBe("module.exports = 1;\n");
  expect(JSON.parse(readFileSync(join(app.configDir, "opencode.json"), "utf8"))).toEqual({ plugins: ["file:///other", "file:///panels/tracks"], secret: "kept" });
  expect(installPanel(app, { name: "one", dir: "/offices/one" }, { name: "tracks", bundle })).toEqual([]);

  // Another office with another build of the panel.
  const other = join(dir, "other.cjs");

  writeFileSync(other, "module.exports = 2;\n");

  expect(panelState(app, { name: "tracks", bundle: other })).toMatchObject({ current: false, registered: true, record: { office: "one", dir: "/offices/one" } });
  expect(installPanel(app, { name: "two", dir: "/offices/two" }, { name: "tracks", bundle: other })).toEqual([`updated panel office-tracks on the test machine in ${join(app.panelsDir, "tracks")}, replacing the copy office one installed`]);
  expect(panelState(app, { name: "tracks", bundle })).toMatchObject({ current: false, record: { office: "two" } });
});

test("registering on a machine without a config creates one holding only the panel", () => {
  const app = machine();

  expect(register(app, "file:///panels/tracks")).toEqual([`created ${join(app.configDir, "opencode.json")} with file:///panels/tracks in plugins`]);
  expect(JSON.parse(readFileSync(join(app.configDir, "opencode.json"), "utf8"))).toEqual({ plugins: ["file:///panels/tracks"] });
});

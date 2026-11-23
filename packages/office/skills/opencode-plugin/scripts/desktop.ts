// Runs the OpenCode desktop app for Linux headless, isolated in a folder of its own, with one package's panel
// registered and a session open on a test project, so an agent can see the panel render over CDP.
//
//   bun desktop.ts start --package <package folder> [--version <x.y.z>] [--project <folder>] [--no-sandbox]
//   bun desktop.ts reload --root <folder printed by start>    (copies the package's rebuilt bundle in)
//   bun desktop.ts stop --root <folder printed by start> [--keep]
//
// The app is the release build for the office's OpenCode version, downloaded on first use from the
// anomalyco/opencode GitHub release, checked against that release's SHA256SUMS and kept in
// $XDG_CACHE_HOME/office/opencode-desktop/. Runs with nothing but Bun.
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { arch, homedir, platform, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const releases = "https://github.com/anomalyco/opencode/releases/download";

/** What `start` writes to `<root>/run.json` and prints. */
type Run = {
  root: string;
  version: string;
  /** The package's bundle, which `reload` copies into `panel`. */
  bundle: string;
  panel: string;
  project: string;
  session: string;
  cdpPort: number;
  sidecar: { url: string; username: string; password: string };
  log: string;
};

/** The sidecar's registration in `<root>/state/opencode/service.json`. */
type Registration = { url: string; password: string };

/** The test root of an app this run started, so a failure says how to stop it. */
let started: string | undefined;

function fail(message: string): never {
  console.error(`desktop: ${message}`);

  if (started !== undefined) console.error(`desktop: the app is still running; stop it with: bun ${process.argv[1]} stop --root ${started}`);

  process.exit(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRegistration(value: unknown): value is Registration {
  return isRecord(value) && typeof value.url === "string" && typeof value.password === "string";
}

function isRun(value: unknown): value is Run {
  return isRecord(value) && typeof value.root === "string" && typeof value.bundle === "string" && typeof value.panel === "string" && typeof value.cdpPort === "number";
}

/**
 * The OpenCode version the office pins in the nearest office.yaml at or above `from`: `tools.opencode`,
 * a version or a mapping with `version`.
 */
function officeVersion(from: string): string | undefined {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const file = join(dir, "office.yaml");

    if (existsSync(file)) {
      const office: unknown = Bun.YAML.parse(readFileSync(file, "utf8"));
      const tools = isRecord(office) ? office.tools : undefined;
      const entry = isRecord(tools) ? tools.opencode : undefined;
      const version = isRecord(entry) ? entry.version : entry;

      return typeof version === "string" ? version : undefined;
    }

    if (dirname(dir) === dir) return undefined;
  }
}

async function download(url: string, target: string): Promise<void> {
  const response = await fetch(url, { headers: { "user-agent": "office" } });

  if (!response.ok) fail(`downloading ${url} answered HTTP ${response.status}`);

  await Bun.write(target, response);
}

async function sha256(file: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");

  for await (const chunk of Bun.file(file).stream()) hasher.update(chunk);

  return hasher.digest("hex");
}

/** The extracted app for `version`, downloading, checking and extracting it the first time. */
async function app(version: string): Promise<string> {
  const machine = arch() === "x64" ? "x86_64" : arch() === "arm64" ? "arm64" : fail(`no Linux desktop build for ${arch()}`);
  const asset = `opencode-desktop-linux-${machine}.AppImage`;
  const cache = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "office/opencode-desktop");
  const folder = join(cache, `${version}-${machine}`);
  const executable = join(folder, "squashfs-root/ai.opencode");

  if (existsSync(executable)) return executable;

  // Downloaded and extracted in a folder of its own, renamed into place only once complete.
  mkdirSync(cache, { recursive: true });

  const staging = mkdtempSync(join(cache, `.${version}-`));
  const image = join(staging, asset);

  console.error(`desktop: downloading ${asset} ${version} (about 300 MB) into ${cache}`);
  await download(`${releases}/v${version}/SHA256SUMS`, join(staging, "SHA256SUMS"));

  const expected = readFileSync(join(staging, "SHA256SUMS"), "utf8")
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === asset)?.[0];

  if (expected === undefined) fail(`the v${version} release's SHA256SUMS lists no ${asset}`);

  await download(`${releases}/v${version}/${asset}`, image);

  const actual = await sha256(image);

  if (actual !== expected) {
    rmSync(staging, { recursive: true, force: true });
    fail(`${asset} has SHA-256 ${actual}, but the release's SHA256SUMS says ${expected}; nothing was kept`);
  }

  // The AppImage unpacks itself into squashfs-root/ in the current folder, without FUSE.
  chmodSync(image, 0o755);

  const extracted = Bun.spawnSync([image, "--appimage-extract"], { cwd: staging, stdout: "ignore", stderr: "pipe" });

  if (!extracted.success) fail(`extracting ${asset} failed: ${extracted.stderr.toString().trim()}`);

  rmSync(image);
  rmSync(folder, { recursive: true, force: true });
  renameSync(staging, folder);

  return executable;
}

/** A port nothing listens on now, on the loopback. */
function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = server;

  server.stop(true);

  return port;
}

async function answers(url: string, init?: RequestInit): Promise<Response | undefined> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(2000) });

    return response.ok ? response : undefined;
  } catch {
    return undefined;
  }
}

/** Waits until `ready` gives a value, failing with `what` and the log's end after `seconds`. */
async function waitFor<Value>(what: string, seconds: number, log: string, ready: () => Promise<Value | undefined>): Promise<Value> {
  const deadline = Date.now() + seconds * 1000;

  while (Date.now() < deadline) {
    const value = await ready();

    if (value !== undefined) return value;

    await Bun.sleep(500);
  }

  const tail = existsSync(log) ? readFileSync(log, "utf8").split("\n").slice(-20).join("\n") : "";

  fail(`${what} didn't happen within ${seconds}s. The end of ${log}:\n${tail}`);
}

/** The panel folder the app loads: the package.json `office sync` generates, beside a copy of the package's bundle. */
function stagePanel(root: string, packageDir: string) {
  const name = basename(packageDir);
  const bundle = join(packageDir, "gui/dist/gui-experimental.cjs");
  const panel = join(root, "panel");

  mkdirSync(panel);
  writeFileSync(join(panel, "package.json"), `${JSON.stringify({ name: `office-${name}`, exports: { "./gui-experimental": "./gui-experimental.cjs" } }, null, 2)}\n`);
  // A copy: the sidecar doesn't load a panel whose bundle is a symbolic link.
  copyFileSync(bundle, join(panel, "gui-experimental.cjs"));

  return { bundle, panel };
}

/** A test office under the root: an office.yaml and the package's plugin linked as office sync links it. */
function stageProject(root: string, packageDir: string): string {
  const project = join(root, "project");
  const plugin = join(packageDir, "plugin");

  mkdirSync(join(project, ".opencode/plugins"), { recursive: true });
  writeFileSync(join(project, "office.yaml"), "name: panel-check\n");

  if (existsSync(plugin)) symlinkSync(plugin, join(project, ".opencode/plugins", basename(packageDir)));

  return project;
}

/** Variables the app mustn't inherit: a display, and BUN_BE_BUN, which turns its sidecar (a Bun executable) into Bun. */
const dropped = new Set(["DISPLAY", "WAYLAND_DISPLAY", "BUN_BE_BUN"]);

/** The environment the app runs with: this one without OpenCode's own variables or `dropped`, isolated in `root`. */
function appEnvironment(root: string) {
  const environment: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("OPENCODE") && !dropped.has(key)) environment[key] = value;
  }

  return { ...environment, HOME: join(root, "home"), OPENCODE_TEST_HOME: join(root, "home"), OPENCODE_DESKTOP_TEST_ROOT: root };
}

async function start(flags: { package?: string; version?: string; project?: string; sandbox: boolean }): Promise<void> {
  if (platform() !== "linux") fail("the headless check runs on Linux (WSL or the office container)");

  if (flags.package === undefined) fail("--package <package folder> is required");

  const packageDir = resolve(flags.package);
  const version = flags.version ?? officeVersion(packageDir) ?? fail("no OpenCode version under tools in an office.yaml above the package; pass --version <x.y.z>");

  // Checked before the first run's download.
  if (!existsSync(join(packageDir, "gui/dist/gui-experimental.cjs"))) fail(`${packageDir}/gui/dist/gui-experimental.cjs doesn't exist; build the panel first`);

  const executable = await app(version);
  // Under the temporary folder, so OpenCode finds no AGENTS.md or skills of the user's when it walks up from the project.
  const root = mkdtempSync(join(tmpdir(), "opencode-desktop-"));
  const log = join(root, "app.log");
  const { bundle, panel } = stagePanel(root, packageDir);
  const project = flags.project === undefined ? stageProject(root, packageDir) : resolve(flags.project);
  const cdpPort = freePort();

  // The sidecar's own port: its default is the user's real sidecar's, and it doesn't try another.
  mkdirSync(join(root, "config/opencode"), { recursive: true });
  mkdirSync(join(root, "home"));
  writeFileSync(join(root, "config/opencode/service.json"), `${JSON.stringify({ port: freePort() })}\n`);
  writeFileSync(join(root, "config/opencode/opencode.json"), `${JSON.stringify({ plugins: [`file://${panel}`] }, null, 2)}\n`);

  const output = openSync(log, "a");
  // Without a screen size the headless window is 1x1. The sandbox can't start in a container.
  const args = ["--ozone-platform=headless", "--ozone-override-screen-size=1600,1000", `--remote-debugging-port=${cdpPort}`, "--password-store=basic", ...(flags.sandbox && !existsSync("/.dockerenv") ? [] : ["--no-sandbox"])];
  const child = spawn(executable, args, { cwd: root, env: appEnvironment(root), stdio: ["ignore", output, output], detached: true });

  child.unref();
  // The app's session: every process it starts stays in it, and stop signals them by it.
  writeFileSync(join(root, "app.pid"), `${child.pid}\n`);
  started = root;

  await waitFor("CDP answering", 60, log, async () => (await answers(`http://127.0.0.1:${cdpPort}/json/version`)) && true);

  const registrationFile = join(root, "state/opencode/service.json");

  const registration = await waitFor("the sidecar registering", 90, log, async () => {
    if (!existsSync(registrationFile)) return undefined;

    try {
      const value: unknown = JSON.parse(readFileSync(registrationFile, "utf8"));

      return isRegistration(value) ? value : undefined;
    } catch {
      return undefined;
    }
  });

  const headers = { authorization: `Basic ${btoa(`opencode:${registration.password}`)}`, "content-type": "application/json" };
  const panelId = `office-${basename(packageDir)}`;

  await waitFor(`the sidecar listing ${panelId}`, 60, log, async () => ((await (await answers(`${registration.url}/api/plugin`, { headers }))?.text())?.includes(panelId) ? true : undefined));

  const created = await answers(`${registration.url}/api/session`, { method: "POST", headers, body: JSON.stringify({ location: { directory: project } }) });
  const answer: unknown = await created?.json();
  const session = isRecord(answer) ? answer.data : undefined;
  const sessionId = isRecord(session) && typeof session.id === "string" ? session.id : fail(`creating a session in ${project} failed`);
  const link = join(project, ".opencode/plugins", basename(packageDir));

  // The project's plugins load a few seconds after the session's first request; until then the panel's RPC fails.
  if (existsSync(link)) {
    const status = await waitFor(`the package's plugin loading in ${project}`, 60, log, async () => {
      const listed: unknown = await (await answers(`${registration.url}/api/plugin?location[directory]=${encodeURIComponent(project)}`, { headers }))?.json();
      const plugins: unknown[] = isRecord(listed) && Array.isArray(listed.data) ? listed.data : [];
      const plugin: unknown = plugins.find((entry) => isRecord(entry) && isRecord(entry.source) && entry.source.path === link);
      const state = isRecord(plugin) && isRecord(plugin.state) ? plugin.state.status : undefined;

      return typeof state === "string" ? state : undefined;
    });

    if (status !== "active") fail(`the package's plugin is ${status} in ${project}; see ${join(root, "data/opencode/log/opencode.log")}`);
  }

  const run: Run = { root, version, bundle, panel, project, session: sessionId, cdpPort, sidecar: { url: registration.url, username: "opencode", password: registration.password }, log };

  writeFileSync(join(root, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
  console.log(JSON.stringify(run, null, 2));
}

/** The run `start` recorded in `root`. */
function readRun(root: string): Run {
  const file = join(resolve(root), "run.json");
  const record: unknown = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;

  return isRun(record) ? record : fail(`${file} doesn't hold a run desktop.ts started`);
}

function reload(root: string | undefined): void {
  const run = readRun(root ?? fail("--root <folder printed by start> is required"));

  copyFileSync(run.bundle, join(run.panel, "gui-experimental.cjs"));
  console.log(`copied ${run.bundle} into ${run.panel}; open windows reload the panel within seconds`);
}

/** The processes of a run: those in the app's session, and the sidecar staged inside the root. */
function runProcesses(root: string): number[] {
  const pids: number[] = [];
  const pidFile = join(root, "app.pid");
  const app = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim() : undefined;

  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;

    try {
      // The fields after the command's closing parenthesis: state, parent, group, session. A zombie is
      // already gone, waiting for its parent (in a container without an init, forever).
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const [state, , , session] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");

      if (state === "Z") continue;

      if (session === app || readlinkSync(`/proc/${entry}/exe`).startsWith(`${root}/`)) pids.push(Number(entry));
    } catch {
      // Gone, or another user's.
    }
  }

  return pids;
}

async function stop(flags: { root?: string; keep: boolean }): Promise<void> {
  if (flags.root === undefined) fail("--root <folder printed by start> is required");

  const root = resolve(flags.root);

  if (!existsSync(join(root, "app.pid"))) fail(`${root} has no app.pid: it isn't a folder desktop.ts started`);

  const signal = (pids: number[], name: NodeJS.Signals) => {
    for (const pid of pids) {
      try {
        process.kill(pid, name);
      } catch {
        // Already gone.
      }
    }
  };

  signal(runProcesses(root), "SIGTERM");

  for (let waited = 0; waited < 10 && runProcesses(root).length > 0; waited++) await Bun.sleep(500);

  const left = runProcesses(root);

  signal(left, "SIGKILL");
  console.log(left.length > 0 ? `stopped; killed ${left.length} that ignored SIGTERM` : "stopped");

  if (flags.keep) return;

  rmSync(root, { recursive: true, force: true });
  console.log(`deleted ${root}`);
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { package: { type: "string" }, version: { type: "string" }, project: { type: "string" }, root: { type: "string" }, "no-sandbox": { type: "boolean" }, keep: { type: "boolean" } },
});

if (positionals[0] === "start") await start({ package: values.package, version: values.version, project: values.project, sandbox: values["no-sandbox"] !== true });
else if (positionals[0] === "reload") reload(values.root);
else if (positionals[0] === "stop") await stop({ root: values.root, keep: values.keep === true });
else fail("usage: bun desktop.ts start --package <folder> [--version <x.y.z>] [--project <folder>] [--no-sandbox] | reload --root <folder> | stop --root <folder> [--keep]");

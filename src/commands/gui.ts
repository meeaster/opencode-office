// `office gui dev <package>`: while a local package's panel is being built, installs its bundle on
// the desktop app's machine each time the build writes it, so the app reloads the panel within
// seconds. Building is the package's own script (such as a `vite build --watch` in its gui/).
import { changeText } from "../change.ts";
import { lstatSync, mkdirSync, readFileSync, realpathSync, watch } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import { installPanel, locate, sha256 } from "../desktop.ts";
import { resolvePackages } from "../packages.ts";
import { loadOffice, type Office, OfficeError } from "../office.ts";
import { validateAssets } from "../../standard/opencode/assets.ts";
import { declarationBinding } from "../../standard/opencode/delivery.ts";
import { readDeclarations } from "../../standard/opencode/declarations.ts";

/** The bundle the last sync applied for the package's panel, read from that record: no package code runs. */
function panelSource(office: Office, name: string) {
  const resolved = resolvePackages(office, name).packages[0];

  if (resolved === undefined) throw new OfficeError(`office.yaml lists no package ${name}`);

  if (resolved.kind !== "local") throw new OfficeError(`${name} is a ${resolved.kind} package; office gui dev works on the office's own packages, in packages/<name>/`);
  const declared = readDeclarations(office).get(name);

  if (declared?.state !== "declared" || !declared.paths.panel) throw new OfficeError(`${name} has no desktop panel registered with opencode.panels.add at the last sync; register one and run office sync --packages`);

  if (declared.binding !== declarationBinding(resolved)) throw new OfficeError(`${name}'s settings or source changed since the last sync; run office sync --packages`);

  return { dir: resolved.dir, file: declared.paths.panel };
}

/** Whether `path`, inside the package folder `dir`, is where it says: no folder on the way is a link elsewhere. */
function direct(dir: string, path: string): boolean {
  try {
    return realpathSync(path) === join(realpathSync(dir), relative(dir, path));
  } catch {
    return false;
  }
}

/**
 * The folder the bundle is built into, made when missing and refused when it, or a folder on the
 * way, leads elsewhere: then the watched writes wouldn't be the package's.
 */
function watchedFolder(dir: string, file: string): string {
  const folder = dirname(join(dir, file));
  let existing = folder;

  while (!lstatSync(existing, { throwIfNoEntry: false })) existing = dirname(existing);

  if (!direct(dir, existing)) throw new OfficeError(`${relative(dir, folder) || "."}: the panel's folder leads outside the package through a link; build it inside the package`);
  mkdirSync(folder, { recursive: true });

  if (!direct(dir, folder)) throw new OfficeError(`${relative(dir, folder)}: the panel's folder leads outside the package through a link; build it inside the package`);

  return folder;
}

export async function guiDev(office: Office, name: string): Promise<void> {
  const source = panelSource(office, name);
  const bundle = join(source.dir, source.file);

  const where = locate();

  if (where.kind === "container") throw new OfficeError("panels install on the desktop app's machine: run office gui dev on the host");

  if (where.kind === "unreachable") throw new OfficeError(`can't install panels: ${where.reason}`);

  const panel = { name, bundle };
  let installed: string | undefined;

  // A build removes its output as well as writing it: nothing there is no new bundle. What is
  // there must still be the registered, regular file inside the package before it is copied.
  const install = () => {
    const current = panelSource(loadOffice(office.dir), name);

    if (current.dir !== source.dir || current.file !== source.file) throw new OfficeError("panel registration changed; restart office gui dev for the new source");
    watchedFolder(source.dir, source.file);

    if (!lstatSync(bundle, { throwIfNoEntry: false })) return;
    validateAssets(office.dir, source.dir, { panel: source.file });
    const content = readFileSync(bundle);

    // A build writes the file more than once; an empty or unchanged file isn't a new bundle.
    if (content.length === 0 || sha256(content) === installed) return;

    installed = sha256(content);

    for (const line of installPanel(where.machine, office, panel)) console.log(`${new Date().toLocaleTimeString()} ${changeText(line)}`);
  };

  // The build may replace the file rather than write it, so its folder is watched. Builds empty
  // that folder but keep it.
  const folder = watchedFolder(source.dir, source.file);

  install();

  await new Promise<void>((done, fail) => {
    const stop = () => { watcher.close(); done(); };

    const watcher = watch(folder, (_event, file) => {
      if (file !== basename(bundle)) return;

      try { install(); } catch (error) {
        watcher.close();
        process.off("SIGINT", stop);
        fail(error);
      }
    });

    process.once("SIGINT", stop);
    console.log(`watching ${relative(office.dir, bundle)}; build the panel with the package's own script. Ctrl-C stops.`);
  });
}

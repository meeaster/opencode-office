// `office gui dev <package>`: while a local package's panel is being built, installs its bundle on
// the desktop app's machine each time the build writes it, so the app reloads the panel within
// seconds. Building is the package's own script (such as a `vite build --watch` in its gui/).
import { existsSync, mkdirSync, readFileSync, watch } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import { installPanel, locate, panelBundle, sha256 } from "../desktop.ts";
import { readPackage, resolvePackages } from "../packages.ts";
import { loadOffice, type Office, OfficeError } from "../office.ts";
import { collectAssets } from "../../standard/opencode/assets.ts";
import { declarationBinding } from "../../standard/opencode/delivery.ts";
import { readDeclarations } from "../../standard/opencode/declarations.ts";

function panelSource(office: Office, name: string) {
  const resolved = resolvePackages(office, name).packages[0];

  if (resolved === undefined) throw new OfficeError(`office.yaml lists no package ${name}`);

  if (resolved.kind !== "local") throw new OfficeError(`${name} is a ${resolved.kind} package; office gui dev works on the office's own packages, in packages/<name>/`);
  const read = readPackage(office, resolved);

  if (!read.ok) throw new OfficeError(read.errors.join("; "));
  let asset = panelBundle;
  const declared = readDeclarations(office).get(name);

  if (read.value.manifest.opencode || declared) {
    if (!read.value.manifest.opencode) throw new OfficeError(`${name}'s definition and synced OpenCode registration differ; sync and restart office gui dev`);
    const fresh = collectAssets(office.dir, read.value).panel;

    if (!fresh || declared?.state !== "declared" || declared.binding !== declarationBinding(resolved) || declared.paths.panel !== fresh) throw new OfficeError(`${name} has no matching synced desktop registration; run office sync --packages`);
    asset = fresh;
  }

  return join(resolved.dir, asset);
}

export async function guiDev(office: Office, name: string): Promise<void> {
  const bundle = panelSource(office, name);

  const where = locate();

  if (where.kind === "container") throw new OfficeError("panels install on the desktop app's machine: run office gui dev on the host");

  if (where.kind === "unreachable") throw new OfficeError(`can't install panels: ${where.reason}`);

  const panel = { name, bundle };
  let installed: string | undefined;

  const install = () => {
    if (!existsSync(bundle)) return;

    if (panelSource(loadOffice(office.dir), name) !== bundle) throw new OfficeError("panel registration changed; restart office gui dev for the new source");

    const content = readFileSync(bundle);

    // A build writes the file more than once; an empty or unchanged file isn't a new bundle.
    if (content.length === 0 || sha256(content) === installed) return;

    installed = sha256(content);

    for (const line of installPanel(where.machine, office, panel)) console.log(`${new Date().toLocaleTimeString()} ${line}`);
  };

  install();

  // The build may replace the file rather than write it, so its folder is watched. Builds empty
  // that folder but keep it.
  mkdirSync(dirname(bundle), { recursive: true });

  await new Promise<void>((done, fail) => {
    const stop = () => { watcher.close(); done(); };

    const watcher = watch(dirname(bundle), (_event, file) => {
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

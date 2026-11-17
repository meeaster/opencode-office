// `office gui dev <package>`: while a local package's panel is being built, installs its bundle on
// the desktop app's machine each time the build writes it, so the app reloads the panel within
// seconds. Building is the package's own script (such as a `vite build --watch` in its gui/).
import { existsSync, mkdirSync, readFileSync, watch } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import { installPanel, locate, panelBundle, sha256 } from "../desktop.ts";
import { localDir, resolvePackages } from "../packages.ts";
import { type Office, OfficeError } from "../office.ts";

export async function guiDev(office: Office, name: string): Promise<void> {
  const resolved = resolvePackages(office).packages.find((item) => item.entry.name === name);

  if (resolved === undefined) throw new OfficeError(`office.yaml lists no package ${name}`);

  if (resolved.kind !== "local") throw new OfficeError(`${name} is a ${resolved.kind} package; office gui dev works on the office's own packages, in packages/<name>/`);

  const where = locate();

  if (where.kind === "container") throw new OfficeError("panels install on the desktop app's machine: run office gui dev on the host");

  if (where.kind === "unreachable") throw new OfficeError(`can't install panels: ${where.reason}`);

  const bundle = join(localDir(office, name), panelBundle);
  const panel = { name, bundle };
  let installed: string | undefined;

  const install = () => {
    if (!existsSync(bundle)) return;

    const content = readFileSync(bundle);

    // A build writes the file more than once; an empty or unchanged file isn't a new bundle.
    if (content.length === 0 || sha256(content) === installed) return;

    installed = sha256(content);

    for (const line of installPanel(where.machine, office, panel)) console.log(`${new Date().toLocaleTimeString()} ${line}`);
  };

  install();
  console.log(`watching ${relative(office.dir, bundle)}; build the panel with the package's own script. Ctrl-C stops.`);

  // The build may replace the file rather than write it, so its folder is watched. Builds empty
  // that folder but keep it.
  mkdirSync(dirname(bundle), { recursive: true });

  const stop = watch(dirname(bundle), (_event, file) => {
    if (file === basename(bundle)) install();
  });

  await new Promise<void>((resolve) => process.once("SIGINT", resolve));
  stop.close();
}

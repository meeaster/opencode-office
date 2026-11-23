// Stand-ins for running `office up` and `office down` end to end in a definition fixture's office:
// Docker, systemctl and mise record each call in $HOME/calls, so a test asserts order from one log.
import { expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DefinitionFixture } from "./package-definition.fixture.ts";
import { definitionText, writePackage } from "./test-package.ts";

type Write = (path: string, text: string, mode?: number) => void;

/**
 * Compose's `up -d` fails while $HOME/compose-fails exists, and records OFFICE_CRON_REVISION;
 * every systemctl call fails while $HOME/no-systemd does. `systemctl show` reports a unit active
 * unless $HOME/inactive/<unit> exists. Socket Firewall is off and the state folder is ./state.
 */
export function rig(f: DefinitionFixture, write: Write): void {
  write(join(f.home, "bin/docker"), '#!/bin/sh\necho "docker $*" >> "$HOME/calls"\ncase "$*" in *" up -d"*) echo "revision $OFFICE_CRON_REVISION" >> "$HOME/calls"; [ -f "$HOME/compose-fails" ] && exit 1;; esac\nexit 0\n', 0o755);
  write(join(f.home, "bin/systemctl"), `#!/bin/sh
echo "systemctl $*" >> "$HOME/calls"
[ -f "$HOME/no-systemd" ] && exit 1
case "$*" in
  "--user show --property=FragmentPath --value "*) exit 0;;
  "--user show "*) [ -f "$HOME/inactive/$3" ] && echo ActiveState=inactive || echo ActiveState=active;;
esac
exit 0
`, 0o755);
  write(join(f.home, "bin/mise"), '#!/bin/sh\n[ "$1" != --version ] || echo 2026.11.7\n', 0o755);
  write(join(f.dir, "state/secrets.env"), "OPENCODE_PASSWORD=fixture-only\n");
  const config = join(f.dir, "office.yaml");

  write(config, `${readFileSync(config, "utf8").replace(/^ {2}sfw: (\S+)$/m, "  sfw: { version: $1, enabled: false }")}state: ./state\n`);
}

export const hostMode = "opencode: { mode: host, url: 'http://127.0.0.1:1' }";

/** Sets office.yaml's `opencode:` line. */
export function mode(f: DefinitionFixture, write: Write, line: string): void {
  const config = join(f.dir, "office.yaml");

  write(config, readFileSync(config, "utf8").replace(/^opencode: .*$/m, line));
}

/** The calls since the last look, and a fresh log. */
export function take(f: DefinitionFixture): string[] {
  const path = join(f.home, "calls");
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];

  rmSync(path, { force: true });

  return lines;
}

/** The index of the first call matching `pattern`, failing the test without one. */
export function at(lines: string[], pattern: RegExp): number {
  const index = lines.findIndex(line => pattern.test(line));

  expect(index, `${pattern} in\n${lines.join("\n")}`).toBeGreaterThanOrEqual(0);

  return index;
}

/** The unit files in the fixture's user unit folder, sorted. */
export function units(f: DefinitionFixture): string[] {
  return existsSync(join(f.home, "units")) ? readdirSync(join(f.home, "units")).sort() : [];
}

/**
 * The rig, with a package `report` declaring the job `digest` and the cron package's settings
 * giving the office's own job `mine`, both joining the template's packages list. `check` reaches
 * no service this machine runs: Executor and OpenCode are at `ports`, closed unless a test serves them.
 */
export function cronOffice(f: DefinitionFixture, write: Write, { overrides = "package.office.upgrade-tools: {enabled: false}", ports = "1" } = {}): void {
  const config = join(f.dir, "office.yaml");

  Object.assign(f.env, { EXECUTOR_PORT: ports, OPENCODE_PORT: ports });
  write(config, `${readFileSync(config, "utf8")}  - name: report\n  - name: cron\n    settings: {jobs: {mine: {schedule: '15 6 * * *', script: mine.sh}}, overrides: {${overrides}}}\n`);
  rig(f, write);
  write(join(f.dir, "mine.sh"), "true");
  writePackage(join(f.dir, "packages/report/office.ts"), definitionText('{setup(c){c.add({id:"cron.jobs",parse:v=>v},{name:"digest",schedule:"0 7 * * MON",script:"digest.sh"})}}'));
  write(join(f.dir, "packages/report/digest.sh"), "true");
}

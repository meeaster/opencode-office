import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

import { envFilePath } from "./paths.ts";
import { sourceLine } from "./host-env.ts";
import { shellQuote } from "../tools/sfw.ts";

type Shell = "bash" | "zsh";

export function interactiveShell(): Shell | undefined {
  let name = basename(process.env.SHELL ?? "");

  try {
    const parent = readFileSync(`/proc/${process.ppid}/comm`, "utf8").trim();

    if (["bash", "zsh", "fish", "dash", "csh", "tcsh", "sh", "ksh"].includes(parent)) name = parent;
  } catch {
    // Outside Linux, use the user's configured shell.
  }

  return name === "bash" || name === "zsh" ? name : undefined;
}

type Hit = { kind: "mise" | "office"; index: number; direct: boolean };

/** Follow literal source commands without executing the user's startup code. */
function inspect(lines: string[], shell: Shell, home: string, seen: Set<string>): Hit[] {
  const hits: Hit[] = [];

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim().replace(/\s+#.*$/, "");

    if (line.startsWith("#")) continue;

    if (/\beval\s+/.test(line) && new RegExp(`\\bmise['"]?\\s+activate\\b[^;&|]*\\b${shell}\\b`).test(line)) hits.push({ kind: "mise", index, direct: true });

    const source = /(?:^|&&\s*)(?:source|\.)\s+(?:"([^"]+)"|'([^']+)'|([^\s;]+))\s*;?$/.exec(line);

    if (!source) continue;

    const path = (source[1] ?? source[2] ?? source[3]).replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/)/, () => home);

    if (path === envFilePath()) hits.push({ kind: "office", index, direct: true });
    else if (isAbsolute(path) && existsSync(path) && statSync(path).isFile()) {
      const key = realpathSync(path);

      if (seen.has(key)) continue;

      seen.add(key);

      for (const hit of inspect(readFileSync(key, "utf8").split("\n"), shell, home, seen)) hits.push({ ...hit, index, direct: false });
      seen.delete(key);
    }
  }

  return hits;
}

/** Returns whether setup still needs to show manual instructions. */
export async function configureStartup(shell: Shell, mise: string, ask?: (question: string) => Promise<string>): Promise<boolean> {
  const home = process.env.HOME || homedir();
  const file = shell === "bash" ? join(home, ".bashrc") : join(process.env.ZDOTDIR || home, ".zshrc");
  const read = () => existsSync(file) ? readFileSync(file, "utf8") : "";
  const before = read();
  const newline = before.includes("\r\n") ? "\r\n" : "\n";
  const lines = before.split(newline);

  if (lines.at(-1) === "") lines.pop();

  const hits = inspect(lines, shell, home, new Set(existsSync(file) ? [realpathSync(file)] : []));
  const office = hits.find((hit) => hit.kind === "office");
  const activation = hits.findLast((hit) => hit.kind === "mise");
  const activate = `eval "$(${mise === "mise" ? mise : shellQuote(mise)} activate ${shell})"`;
  let change: string;

  if (office && activation) {
    if (hits.indexOf(office) > hits.indexOf(activation)) return false;

    // Never move a user's conditional, or a source command that loads other settings.
    if (!office.direct || lines[office.index] !== sourceLine()) return true;
    lines.splice(office.index, 1);
    lines.push(sourceLine());
    change = "move the office environment after mise activation";
  } else if (office) {
    lines.splice(office.index, 0, activate);
    change = "add mise activation before the existing office environment";
  } else {
    if (!activation) lines.push(activate);
    lines.push(sourceLine());
    change = activation ? "add the office environment after mise activation" : "add mise activation and then the office environment";
  }

  if (!ask || await ask(`Detected ${shell}. Update ${file} to ${change}? [yes/no]`) !== "yes") return true;

  if (read() !== before) throw new Error(`${file} changed during setup; rerun setup to use the new contents`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.join(newline) + newline);

  return false;
}

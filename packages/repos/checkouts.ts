// Working checkouts at `repos/<name>/`. Sync clones a missing one, at its declared ref, and
// afterwards only fetches it into its remote-tracking branches: never a pull, branch switch,
// reset, tag, prune or submodule, so the owner's branches, commits, index and files stay as they
// are. Before any network command it checks that the folder is a checkout of its own (not a
// folder inside the office's repository), reached without a link and keeping its Git metadata
// under `repos/`, and that Git fetches its origin from where the declared URL leads; anything else
// is named and left alone. Messages never show a URL's credentials.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { ItemResult } from "@office/sdk";
import type { Entry } from "./settings.ts";

/** Where working checkouts live, relative to the office root. */
export const checkoutRoot = "repos";

const environment = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

/** A checkout's office-relative folder, as sessions and messages show it. */
export function checkoutPath(name: string): string {
  return `${checkoutRoot}/${name}/`;
}

/** `text` with the user information of every URL in it (a token, a password) replaced. */
export function redact(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1***@");
}

/** Reads from Git without a network or a write; undefined when Git refuses. */
function gitValue(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: environment }).trim();
  } catch {
    return undefined;
  }
}

/** What is at a checkout's folder: nothing, a checkout of its own, or something else, said. */
export type Found = { kind: "missing" } | { kind: "checkout" } | { kind: "other"; problem: string };

/** Whether `path` is `folder` or inside it, both resolved through links. */
function within(path: string, folder: string): boolean {
  const real = realpathSync(path);

  return real === folder || real.startsWith(folder + sep);
}

/**
 * What is at `repos/<name>/` in the office at `office`, read without a network or a write. For a
 * checkout sync manages (`managed`, one with a URL), a link at `repos/` or at the folder, or Git
 * metadata outside `repos/`, is something else: sync's writes stay inside `repos/`. A local-only
 * checkout is the owner's, wherever it leads.
 */
export function inspect(office: string, name: string, managed: boolean): Found {
  const root = join(office, checkoutRoot);
  const dir = join(root, name);

  if (managed && lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink()) return { kind: "other", problem: `is inside ${checkoutRoot}/, which is a link; sync writes only to folders of the office's own` };
  const entry = managed ? lstatSync(dir, { throwIfNoEntry: false }) : statSync(dir, { throwIfNoEntry: false });

  if (entry === undefined) return { kind: "missing" };

  if (entry.isSymbolicLink()) return { kind: "other", problem: "is a link; sync writes only to folders of the office's own" };

  if (!entry.isDirectory()) return { kind: "other", problem: "is not a folder" };
  const top = gitValue(["rev-parse", "--show-toplevel"], dir);

  // A plain folder answers with the office's repository, so only a checkout rooted here counts.
  if (top === undefined || realpathSync(top) !== realpathSync(dir)) return { kind: "other", problem: "is not a Git checkout of its own" };

  if (!managed) return { kind: "checkout" };
  // A fetch writes refs and objects into the checkout's metadata: a linked worktree's common
  // folder included, which may be another checkout under repos/, never a folder elsewhere.
  const metadata = gitValue(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], dir)?.split("\n");
  const inside = realpathSync(root);

  if (metadata === undefined || metadata.length !== 2 || !metadata.every(path => existsSync(path) && within(path, inside))) {
    return { kind: "other", problem: `keeps its Git metadata outside ${checkoutRoot}/; sync writes only to folders of the office's own` };
  }

  return { kind: "checkout" };
}

/** Whether Git reads `url` as a local path: no `scheme://` and no `host:` before its first slash. */
function localPath(url: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && (isAbsolute(url) || !/^[^/]*:/.test(url));
}

/** `url` as one comparable location: a local path resolved from `base`, where Git reads it from. */
function location(url: string, base: string): string {
  if (!localPath(url)) return url;
  const path = resolve(base, url);

  return existsSync(path) ? realpathSync(path) : path;
}

/**
 * Why the checkout at `dir` doesn't fetch from the declared `url`, or undefined when it does. Its
 * origin as configured (the first `remote.origin.url`, which Git fetches from) must be the declared
 * URL, and where Git's `url.<base>.insteadOf` rules send the origin, read in the checkout, must be
 * where they send the declared URL, read in the office as the clone did. A relative declared path
 * is the office's, as the clone read it; one in the checkout's config is its own.
 */
export function originProblem(office: string, dir: string, url: string): string | undefined {
  // An empty value resets the list, as Git reads it.
  const values = (gitValue(["config", "--get-all", "remote.origin.url"], dir) ?? "").split("\n");
  const configured = values.slice(values.lastIndexOf("") + 1)[0];

  if (configured === undefined) return `has no origin remote; office.yaml declares ${redact(url)}`;

  if (location(configured, dir) !== location(url, office)) return redact(`has origin ${configured}, not the declared ${url}`);
  const fetches = gitValue(["ls-remote", "--get-url", "--", "origin"], dir);
  // Where the declared URL leads as the clone read it: from the office, not the checkout's own rules.
  const declared = gitValue(["ls-remote", "--get-url", "--", url], office);

  if (fetches === undefined || declared === undefined || location(fetches, dir) !== location(declared, office)) {
    return redact(`fetches origin from ${fetches ?? "nowhere Git can say"}, not from ${declared ?? url}, where the declared ${url} leads (Git's url.insteadOf rules)`);
  }
}

/**
 * Runs Git, sending each line it prints to `output` as it arrives; a progress meter's updates (a
 * line ended by a carriage return) at most once a second. Resolves to its first fatal line when it
 * fails. Credentials in URLs are never shown.
 */
async function streamed(args: string[], cwd: string, output: (line: string) => void): Promise<string | undefined> {
  const child = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: environment });
  const lines: string[] = [];

  const show = (line: string) => {
    if (line.trim() === "") return;
    const safe = redact(line);

    lines.push(safe);
    output(safe);
  };

  const read = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    let pending = "";
    let meter = -Infinity;

    for await (const chunk of stream) {
      pending += decoder.decode(chunk, { stream: true });
      // Each piece with the separator that ended it; the last may be a line still being written.
      const pieces = pending.split(/(\r\n|\r|\n)/);

      pending = pieces.pop() ?? "";

      for (let index = 0; index < pieces.length; index += 2) {
        if (pieces[index + 1] === "\r") {
          if (performance.now() - meter < 1000) continue;
          meter = performance.now();
        }

        show(pieces[index]);
      }
    }

    show(pending + decoder.decode());
  };

  const [status] = await Promise.all([child.exited, read(child.stdout), read(child.stderr)]);

  if (status === 0) return undefined;

  return lines.find(line => line.startsWith("fatal:")) ?? lines.at(-1) ?? `git ${args[0]} exited ${status}`;
}

/** How far HEAD is behind its upstream after a fetch, as a note; empty when even or without one. */
function behind(dir: string): string {
  const count = gitValue(["rev-list", "--count", "HEAD..@{upstream}"], dir);

  return count === undefined || count === "0" ? "" : `; ${count} new upstream ${count === "1" ? "commit" : "commits"} not merged`;
}

/**
 * Clones a missing remote checkout or fetches the declared one; any other folder is named and left
 * as it is. `verbose` shows Git's progress meter, otherwise Git prints only what went wrong.
 */
export async function syncCheckout(office: string, entry: Entry & { url: string }, output: (line: string) => void, verbose = false): Promise<ItemResult> {
  const dir = join(office, checkoutRoot, entry.name);
  const found = inspect(office, entry.name, true);
  const progress = verbose ? "--progress" : "--quiet";

  if (found.kind === "missing") {
    mkdirSync(join(office, checkoutRoot), { recursive: true });
    const failed = await streamed(["clone", progress, ...(entry.ref === undefined ? [] : ["--branch", entry.ref]), "--", entry.url, dir], office, output);

    return failed === undefined ? { ok: true, summary: entry.ref === undefined ? "cloned" : `cloned at ${entry.ref}` } : { ok: false, reason: failed };
  }

  const problem = found.kind === "other" ? found.problem : originProblem(office, dir, entry.url);

  if (problem !== undefined) return { ok: false, reason: `${checkoutPath(entry.name)} ${problem}; not fetched, and left as it is` };
  // Only into remote-tracking branches, whatever the checkout's own fetch configuration maps.
  const failed = await streamed(["fetch", progress, "--no-tags", "--no-prune", "--recurse-submodules=no", "--refmap=", "origin", "+refs/heads/*:refs/remotes/origin/*"], dir, output);

  return failed === undefined ? { ok: true, summary: `fetched${behind(dir)}` } : { ok: false, reason: failed };
}

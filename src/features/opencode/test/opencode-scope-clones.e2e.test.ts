import { expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { command, control, gitAt, pluginRemote, scopeFixture, snapshot, write } from "./opencode-scope.fixture.ts";

const { office, fixture } = scopeFixture();

test("a first plugin clone verifies the effective origin before fetching and before checkout", async () => {
  const f = fixture("first-origin", "http://127.0.0.1:1");
  const remote = join(f.home, "declared");
  const mirror = join(f.home, "unexpected");
  const plugin = join(f.dir, ".office/plugins/imported");
  const link = join(f.dir, ".opencode/plugins/imported");
  const trace = join(f.home, "git.trace");
  const shim = join(f.home, "bin/git");
  const native = Bun.which("git", { PATH: f.env.PATH });

  if (!native) throw new Error("git required for plugin checkout test");

  write(join(remote, "note"), "declared\n");
  gitAt(remote, f.env, "init", "-q");
  gitAt(remote, f.env, "add", "note");
  gitAt(remote, f.env, "commit", "-qm", "declared");
  write(join(mirror, "note"), "mirror\n");
  gitAt(mirror, f.env, "init", "-q");
  gitAt(mirror, f.env, "add", "note");
  gitAt(mirror, f.env, "commit", "-qm", "mirror");
  expect(gitAt(mirror, f.env, "rev-parse", "HEAD")).not.toBe(gitAt(remote, f.env, "rev-parse", "HEAD"));
  f.select(`plugins: [{name: imported, repo: ${remote}}]\n`);

  // Record the transport boundary. Even a build missing the guard cannot import anything.
  write(shim, `#!/bin/sh\necho "$1" >> "${trace}"\ncase "$1" in fetch|checkout) exit 91;; esac\nexec "${native}" "$@"\n`);
  chmodSync(shim, 0o755);
  f.env.PATH = `${dirname(shim)}:${f.env.PATH}`;
  const rewrite = `url.${mirror}.insteadOf`;
  const policy = join(f.home, "plugin.gitconfig");
  gitAt(f.home, f.env, "config", "--file", policy, rewrite, remote);
  gitAt(f.home, f.env, "config", "--global", `includeIf.gitdir:${plugin}/.git.path`, policy);

  for (let attempt = 0; attempt < 2; attempt++) {
    write(trace, "");
    const report = await f.run(["sync"], 1);
    expect(readFileSync(trace, "utf8").split("\n")).not.toContain("fetch");
    expect(report).toContain("cannot verify plugin checkout origin");
    expect(report).not.toContain(remote);
    expect(report).not.toContain("unexpected");
    expect(existsSync(plugin)).toBe(false);
  }

  gitAt(f.home, f.env, "config", "--file", policy, "--unset", rewrite);
  // Change the configured origin only after a successful, ordinary local fetch.
  write(shim, `#!/bin/sh\ncase " $* " in *" checkout "*) echo checkout;; *) echo "$1";; esac >> "${trace}"\n"${native}" "$@" || exit $?\nif [ "$1" = fetch ]; then "${native}" remote set-url origin ../changed; fi\n`);
  write(trace, "");
  expect(await f.run(["sync"], 1)).toContain("cannot verify plugin checkout origin");
  const commands = readFileSync(trace, "utf8").split("\n");
  expect(commands).toContain("fetch");
  expect(commands).not.toContain("checkout");
  expect(existsSync(plugin)).toBe(false);

  // A checkout can write files and still exit nonzero. Nothing partial becomes a plugin.
  write(shim, `#!/bin/sh\n"${native}" "$@" || exit $?\ncase " $* " in *" checkout "*) echo 'https://hidden-user:hidden-pass@example.invalid' >&2; exit 92;; esac\n`);
  const failed = await f.run(["sync"], 1);
  expect(failed).toContain("plugin Git operation failed");
  expect(failed).not.toContain("hidden-");
  expect(existsSync(plugin)).toBe(false);
  expect(readdirSync(join(f.dir, ".office/tmp"))).toEqual([]);
  expect(existsSync(link)).toBe(false);

  rmSync(shim);
  await f.run(["sync"]);
  expect(gitAt(plugin, f.env, "rev-parse", "HEAD")).toBe(gitAt(remote, f.env, "rev-parse", "HEAD"));
  expect(readFileSync(join(plugin, "note"), "utf8")).toBe("declared\n");
  expect(readlinkSync(link)).toBe("../../.office/plugins/imported");
}, 60_000);

test("a plugin checkout with the wrong origin is not cleaned, fetched or force-checked-out", async () => {
  const f = fixture("clone-origin", "http://127.0.0.1:1");
  const remote = join(f.home, "original");
  const plugin = join(f.dir, ".office/plugins/imported");
  write(join(remote, "index.js"), command("original"));
  const git = (...args: string[]) => gitAt(remote, f.env, ...args);
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "original");
  f.select(`plugins: [{name: imported, repo: ${remote}}]\n`);
  await f.run(["sync"]);
  write(join(remote, "index.js"), command("changed-upstream"));
  git("commit", "-qam", "advance");
  write(join(plugin, "index.js"), "// owner edits");
  const head = gitAt(plugin, f.env, "rev-parse", "HEAD");
  const fetched = readFileSync(join(plugin, ".git/FETCH_HEAD"));
  f.select(`plugins: [{name: imported, repo: ${f.home}/different}]\n`);
  expect(await f.run(["sync"], 1)).toContain("cannot verify plugin checkout origin");
  expect(gitAt(plugin, f.env, "rev-parse", "HEAD")).toBe(head);
  expect(readFileSync(join(plugin, "index.js"), "utf8")).toBe("// owner edits");
  f.select(`plugins: [{name: imported, repo: ${remote}}]\n`);
  gitAt(plugin, f.env, "config", `url.${f.home}/different.insteadOf`, remote);
  expect(await f.run(["sync"], 1)).toContain("cannot verify plugin checkout origin");
  expect(readFileSync(join(plugin, "index.js"), "utf8")).toBe("// owner edits");
  expect(readFileSync(join(plugin, ".git/FETCH_HEAD"))).toEqual(fetched);
  expect(gitAt(plugin, f.env, "rev-parse", "HEAD")).toBe(head);
  gitAt(plugin, f.env, "config", "--unset", `url.${f.home}/different.insteadOf`);
  // A real fetch can wait. Change only the fixture's origin after fetching, before --force.
  const gitPath = Bun.which("git", { PATH: f.env.PATH });

  if (!gitPath) throw new Error("git required for plugin checkout test");
  const shim = join(f.home, "bin/git");
  write(shim, `#!/bin/sh\n"${gitPath}" "$@" || exit $?\nif [ "$1" = fetch ]; then "${gitPath}" remote set-url origin ../different; fi\n`);
  chmodSync(shim, 0o755);
  const originalPath = f.env.PATH;
  f.env.PATH = `${dirname(shim)}:${originalPath}`;
  expect(await f.run(["sync"], 1)).toContain("cannot verify plugin checkout origin");
  f.env.PATH = originalPath;
  expect(gitAt(plugin, f.env, "rev-parse", "HEAD")).toBe(head);
  expect(readFileSync(join(plugin, "index.js"), "utf8")).toBe("// owner edits");
  gitAt(plugin, f.env, "remote", "set-url", "origin", remote);
  await f.run(["sync"]);
  expect(gitAt(plugin, f.env, "rev-parse", "HEAD")).toBe(git("rev-parse", "HEAD"));
  rmSync(plugin, { recursive: true });
  gitAt(f.dir, f.env, "init", "-q", plugin);
  gitAt(plugin, f.env, "remote", "add", "origin", `${f.home}/different`);
  const config = readFileSync(join(plugin, ".git/config"));
  expect(await f.run(["sync"], 1)).toContain("cannot verify plugin checkout origin");
  expect(readFileSync(join(plugin, ".git/config"))).toEqual(config);
}, 60_000);

test("a plugin checkout with no commit is refused before fetching, even with the declared origin, and exposes nothing", async () => {
  for (const executable of [office, ...(control ? [control] : [])]) {
    const f = fixture(executable === office ? "unborn" : "unborn-control", "http://127.0.0.1:1");
    // The control clones into .opencode/plugins/, the folder OpenCode discovers.
    const plugin = join(f.dir, executable === office ? ".office/plugins/imported" : ".opencode/plugins/imported");
    // A required smudge filter fails on the last file, after index.js is written.
    const remote = pluginRemote(f, { ".gitattributes": "zz-last filter=fail\n", "index.js": command("exposed"), "zz-last": "last\n" });
    gitAt(f.dir, f.env, "init", "-q", plugin);
    gitAt(plugin, f.env, "remote", "add", "origin", remote);
    gitAt(plugin, f.env, "config", "filter.fail.smudge", "false");
    gitAt(plugin, f.env, "config", "filter.fail.required", "true");
    const before = snapshot(plugin);
    const report = await f.run(["sync"], 1, executable);

    if (executable !== office) {
      // The control: refresh checks out into the folder OpenCode discovers.
      expect(existsSync(join(plugin, "index.js"))).toBe(true);
      expect(existsSync(join(plugin, "zz-last"))).toBe(false);
      continue;
    }

    expect(report).toContain("existing plugin checkout has no commit; left unchanged. Move it aside");
    expect(report).not.toContain(remote);
    expect(snapshot(plugin)).toEqual(before);
    expect(existsSync(join(plugin, "index.js"))).toBe(false);
    expect(existsSync(join(plugin, ".git/FETCH_HEAD"))).toBe(false);
    expect(existsSync(join(f.dir, ".opencode/plugins/imported"))).toBe(false);

    // The same checkout where the plugin's link belongs is the office's own: it stays.
    const owner = join(f.dir, ".opencode/plugins/imported");
    renameSync(plugin, owner);
    const kept = snapshot(owner);
    expect(await f.run(["sync"], 1)).toContain(".opencode/plugins/imported is the office's own (not a link office sync made), kept; move it aside or rename the plugins: entry");
    expect(snapshot(owner)).toEqual(kept);
    expect(existsSync(plugin)).toBe(false);
  }
}, 60_000);

test("first plugin delivery never replaces an owner's folder, even an empty one or one that appears mid-delivery", async () => {
  const f = fixture("owner-folder", "http://127.0.0.1:1");
  const plugin = join(f.dir, ".office/plugins/imported");
  const destination = join(f.dir, ".opencode/plugins/imported");
  const remote = pluginRemote(f, { "index.js": command("delivered") });
  const native = Bun.which("git", { PATH: f.env.PATH });

  if (!native) throw new Error("git required for plugin checkout test");
  const shim = join(f.home, "bin/git");
  const trace = join(f.home, "git.trace");
  const originalPath = f.env.PATH;
  // An owner's empty folder is refused before Git fetches anything, origin aside.
  write(shim, `#!/bin/sh\necho "$1" >> "${trace}"\nexec "${native}" "$@"\n`);
  chmodSync(shim, 0o755);
  write(trace, "");
  f.env.PATH = `${dirname(shim)}:${originalPath}`;
  mkdirSync(plugin, { recursive: true });
  chmodSync(plugin, 0o750);
  const owner = snapshot(plugin);
  expect(await f.run(["sync"], 1)).toContain("existing folder at the plugin destination kept; office sync clones only into a path that does not exist. Move it aside");
  expect(readFileSync(trace, "utf8").split("\n")).not.toContain("fetch");
  expect(snapshot(plugin)).toEqual(owner);
  f.env.PATH = originalPath;

  if (control) {
    // The control publishes over the empty folder where it clones: another inode, staging's 0700 mode.
    mkdirSync(destination);
    const before = statSync(destination).ino;
    await f.run(["sync"], 0, control);
    expect(statSync(destination).ino).not.toBe(before);
    expect(statSync(destination).mode & 0o777).toBe(0o700);
    rmSync(destination, { recursive: true });
  }

  rmSync(plugin, { recursive: true });
  // An owner folder replaces the claim while Git fetches. It stays, with its inode and mode.
  const aside = join(f.home, "aside");
  const substitute = join(f.home, "substitute");
  write(shim, `#!/bin/sh\n"${native}" "$@" || exit $?\nif [ "$1" = fetch ]; then mv "${plugin}" "${aside}"; mkdir -m 750 "${plugin}"; stat -c %i "${plugin}" > "${substitute}"; fi\n`);
  f.env.PATH = `${dirname(shim)}:${originalPath}`;
  expect(await f.run(["sync"], 1)).toContain("cannot verify plugin checkout origin");
  expect(statSync(plugin).ino).toBe(Number(readFileSync(substitute, "utf8")));
  expect(statSync(plugin).mode & 0o777).toBe(0o750);
  expect(readdirSync(plugin)).toEqual([]);
  rmSync(plugin, { recursive: true });
  rmSync(aside, { recursive: true });

  // A file an owner puts inside the claim survives, and nothing is published around it.
  write(shim, `#!/bin/sh\n"${native}" "$@" || exit $?\nif [ "$1" = fetch ]; then echo owner > "${plugin}/owner.txt"; fi\n`);
  expect(await f.run(["sync"], 1)).toContain("plugin destination changed during delivery; kept what appeared there and published nothing");
  expect(readdirSync(plugin)).toEqual(["owner.txt"]);
  expect(readFileSync(join(plugin, "owner.txt"), "utf8")).toBe("owner\n");
  rmSync(plugin, { recursive: true });

  f.env.PATH = originalPath;
  await f.run(["sync"]);
  expect(gitAt(plugin, f.env, "rev-parse", "HEAD")).toBe(gitAt(remote, f.env, "rev-parse", "HEAD"));
  expect(readFileSync(join(plugin, "index.js"), "utf8")).toBe(command("delivered"));
  expect(readdirSync(join(f.dir, ".office/tmp"))).toEqual([]);
  expect(readlinkSync(destination)).toBe("../../.office/plugins/imported");
}, 60_000);

test("a Git-cloned plugin lives in .office/plugins, is linked after publication and updates in place; a checkout where its link belongs stays", async () => {
  const f = fixture("clone-link", "http://127.0.0.1:1");
  const remote = pluginRemote(f, { "index.js": command("cloned-v1") });
  const checkout = join(f.dir, ".office/plugins/imported");
  const link = join(f.dir, ".opencode/plugins/imported");
  // OpenCode doesn't notice a checkout appearing behind an existing link, so one made first is made again.
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync("../../.office/plugins/imported", link);
  const dangling = lstatSync(link).ino;
  const first = await f.run(["sync"]);
  expect(first).toContain(".office/plugins/imported: cloned");
  expect(first).toContain("relinked .opencode/plugins/imported");
  expect(lstatSync(link).ino).not.toBe(dangling);
  expect(readlinkSync(link)).toBe("../../.office/plugins/imported");
  expect(readFileSync(join(link, "index.js"), "utf8")).toBe(command("cloned-v1"));
  const identity = [statSync(checkout).ino, lstatSync(link).ino];
  expect(await f.run(["sync"])).not.toMatch(/: cloned|: updated|linked \./);

  write(join(remote, "index.js"), command("cloned-v2"));
  gitAt(remote, f.env, "commit", "-qam", "v2");
  expect(await f.run(["sync"])).toContain(".office/plugins/imported: updated");
  expect(readFileSync(join(link, "index.js"), "utf8")).toBe(command("cloned-v2"));
  expect([statSync(checkout).ino, lstatSync(link).ino]).toEqual(identity);

  rmSync(link);
  expect(await f.run(["check"], 1)).toContain("plugin imported is cloned but .opencode/plugins/imported doesn't link to it (office sync links it)");
  expect(await f.run(["sync"])).toContain("linked .opencode/plugins/imported");
  expect(statSync(checkout).ino).toBe(identity[0]);
  expect(await f.run(["opencode", "inspect"])).toContain("Office link to a Git clone (declared): .opencode/plugins/imported");

  // A real checkout where the link belongs, even one of this plugin's repository, is the office's own and stays.
  rmSync(link);
  gitAt(f.home, f.env, "clone", "-q", remote, link);
  const owner = snapshot(link);
  expect(await f.run(["sync"], 1)).toContain(".opencode/plugins/imported is the office's own (not a link office sync made), kept; move it aside or rename the plugins: entry");
  expect(snapshot(link)).toEqual(owner);
}, 60_000);

test("an existing clone is linked before it is fetched, so an unreachable remote leaves an unlinked checkout linked; withdrawn clones are unlinked and listed, never deleted", async () => {
  const f = fixture("clone-offline", "http://127.0.0.1:1");
  const remote = pluginRemote(f, { "index.js": command("cloned-v1") });
  const checkout = join(f.dir, ".office/plugins/imported");
  const link = join(f.dir, ".opencode/plugins/imported");

  // A checkout in .office/plugins/ with local work, not yet linked, is linked as it is while the
  // remote can't be reached.
  gitAt(f.home, f.env, "clone", "-q", remote, checkout);
  write(join(checkout, "untracked-note"), "kept\n");
  const cloned = statSync(checkout).ino;
  expect(await f.run(["check"], 1)).toContain("plugin imported is cloned but .opencode/plugins/imported doesn't link to it (office sync links it)");
  renameSync(remote, `${remote}.away`);
  const offline = await f.run(["sync"], 1);
  expect(offline).toContain("linked .opencode/plugins/imported");
  expect(offline).toContain("plugin Git operation failed");
  expect(readlinkSync(link)).toBe("../../.office/plugins/imported");
  expect(statSync(checkout).ino).toBe(cloned);
  expect(readFileSync(join(checkout, "untracked-note"), "utf8")).toBe("kept\n");

  // A verified checkout whose link was deleted is linked again, still offline, and then left alone.
  rmSync(link);
  expect(await f.run(["sync"], 1)).toContain("linked .opencode/plugins/imported");
  expect(readlinkSync(link)).toBe("../../.office/plugins/imported");
  const linked = lstatSync(link).ino;
  expect(await f.run(["sync"], 1)).not.toContain("linked .opencode/plugins/imported");
  expect(lstatSync(link).ino).toBe(linked);
  renameSync(`${remote}.away`, remote);
  expect(await f.run(["sync"])).not.toMatch(/linked \.opencode\/plugins\/imported|FAILED/);

  // A checkout that isn't provably this plugin's isn't linked before the fetch either.
  rmSync(link);
  gitAt(checkout, f.env, "remote", "set-url", "origin", join(f.home, "elsewhere"));
  expect(await f.run(["sync"], 1)).toContain("cannot verify plugin checkout origin");
  expect(existsSync(link)).toBe(false);
  gitAt(checkout, f.env, "remote", "set-url", "origin", remote);
  await f.run(["sync"]);

  // Withdrawn: sync unlinks the checkout but keeps it; check lists it with the path to remove.
  f.select("");
  expect(await f.run(["sync"])).toContain("unlinked .opencode/plugins/imported");
  expect(existsSync(link)).toBe(false);
  const health = await f.run(["check"], 1);
  expect(health).toContain(".office/plugins/imported is a checkout no plugins: entry declares");
  expect(health).toContain("remove .office/plugins/imported");
  expect(existsSync(join(checkout, ".git"))).toBe(true);

  // The name selected again with another repository: refused, naming the folder to move aside.
  const other = join(f.home, "other");
  gitAt(f.home, f.env, "clone", "-q", "--bare", remote, other);
  f.select(`plugins: [{name: imported, repo: ${other}}]\n`);
  expect(await f.run(["sync"], 1)).toContain("If .office/plugins/imported is an earlier checkout of another repository, move it aside");
  expect(existsSync(link)).toBe(false);
}, 60_000);

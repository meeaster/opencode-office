import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the maintenance script commits only successful pin/lock pairs and leaves the owner's index alone", () => {
  const root = mkdtempSync(join(tmpdir(), "office-upgrade-commit-"));
  const cwd = join(root, "office");
  const bin = join(root, "bin");
  const checkout = join(import.meta.dir, "../..");
  const cli = process.env.OFFICE_TEST_EXECUTABLE ?? join(checkout, "bin/office");
  const env = { HOME: root, PATH: bin, XDG_DATA_HOME: root, GIT_CONFIG_NOSYSTEM: "1", OFFICE_CRON_COMMAND: cli };
  const pin = '[tools]\njq = "1.7.1" # owner comment\n';
  const write = (file: string, text: string) => writeFileSync(join(cwd, file), text);
  const read = (file: string) => readFileSync(join(cwd, file), "utf8");

  function run(args: string[], status = 0) {
    const result = Bun.spawnSync(args, { cwd, env });
    const log = result.stdout.toString() + result.stderr.toString();

    expect(result.exitCode, log).toBe(status);

    return log.trim();
  }

  const git = (...args: string[]) => run(["git", ...args]);
  const job = (status = 0) => run(["/bin/sh", join(checkout, "packages/office/scripts/upgrade-tools.sh")], status);

  try {
    mkdirSync(cwd);
    mkdirSync(bin);
    mkdirSync(join(cwd, "draft"));
    mkdirSync(join(cwd, "good"));
    const gitPath = Bun.which("git");

    if (!gitPath) throw new Error("git required");

    symlinkSync(gitPath, join(bin, "git"));
    symlinkSync(process.execPath, join(bin, "bun"));
    writeFileSync(join(bin, "mise"), `#!/bin/sh
case "$1:$2" in
  --version:) echo 9999.1.0 ;;
  outdated:--bump)
    case "$*" in
      *jq@1.7.1) echo '{"jq":{"requested":"1.7.1","current":"1.7.1","latest":"1.8.0"}}' ;;
      *) echo '{}' ;;
    esac ;;
  latest:jq@*) echo "\${2#jq@}" ;;
  latest:jq) echo 1.8.0 ;;
  install:jq@1.8.0) [ ! -f fail-install ] ;;
  lock:) echo "lock 1.8.0" > mise.lock
    if [ -f fail-lock ]; then echo "ERROR interrupted lock" >&2; exit 1; fi ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
    write("office.yaml", "name: fixture\ndesks: {draft: {app: false}, good: {app: false}}\n");

    for (const dir of ["", "draft/", "good/"]) {
      write(`${dir}mise.toml`, pin);
      write(`${dir}mise.lock`, "original lock\n");
    }

    write("notes", "baseline\n");
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "baseline");
    write("draft/mise.lock", "owner's staged lock\n");
    write("notes", "staged notes\n");
    git("add", "draft/mise.lock", "notes");
    write("notes", "working notes\n");
    write("fail-lock", "");
    const staged = git("diff", "--cached");

    expect(job(1)).toContain("mise lock failed");
    expect(git("diff", "--name-only", "HEAD^", "HEAD")).toBe("good/mise.lock\ngood/mise.toml");
    expect(git("show", "HEAD:good/mise.toml")).toBe(pin.trim().replace("1.7.1", "1.8.0"));
    expect(git("show", "HEAD:good/mise.lock")).toBe("lock 1.8.0");
    expect(read("mise.toml")).toBe(pin);
    expect(read("mise.lock")).toBe("original lock\n");
    expect(read("draft/mise.toml")).toBe(pin);
    expect(read("draft/mise.lock")).toBe("owner's staged lock\n");
    rmSync(join(cwd, "fail-lock"));
    write("fail-install", "");
    const partial = git("rev-parse", "HEAD");

    expect(job(1)).toContain("install failed");
    expect(git("rev-parse", "HEAD")).toBe(partial);
    expect(read("mise.toml")).toBe(pin);
    expect(read("mise.lock")).toBe("original lock\n");
    rmSync(join(cwd, "fail-install"));
    job();
    expect(git("diff", "--name-only", "HEAD^", "HEAD")).toBe("mise.lock\nmise.toml");
    const head = git("rev-parse", "HEAD");

    job();
    expect(git("rev-parse", "HEAD")).toBe(head);
    write("draft/mise.toml", `# local edit\n${pin}`);
    run([cli, "--office", cwd, "upgrade-tools"]);
    expect(read("draft/mise.toml")).toBe(`# local edit\n${pin.replace("1.7.1", "1.8.0")}`);
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("diff", "--cached")).toBe(staged);
    expect(read("notes")).toBe("working notes\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

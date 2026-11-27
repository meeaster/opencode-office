import { expect, test } from "bun:test";
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnWorker } from "../../../src/loader/worker.ts";

test("worker transport passes inherited descriptors and leaves its pipe for the caller to read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "office-worker-"));
  const input = join(dir, "input");

  writeFileSync(input, "from the caller\n");
  const fd = openSync(input, "r");

  try {
    using worker = spawnWorker(["/bin/sh", "-c", 'IFS= read -r text <&3; printf "%s: %s\\n" "$LABEL" "$text" >&4; exit 23'], { LABEL: "in the worker" }, [fd, "pipe"]);
    const pipe = worker.stdio[4];

    if (pipe == null) throw new Error("missing worker pipe");

    try {
      expect(await Bun.file(pipe).text()).toBe("in the worker: from the caller\n");
      expect(await worker.exited).toBe(23);
    } finally {
      closeSync(pipe);
    }
  } finally {
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker transport forwards SIGINT and removes its handler on disposal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "office-worker-signal-"));
  const ready = join(dir, "ready");
  const workerModule = new URL("../../../src/loader/worker.ts", import.meta.url).pathname;

  const program = `
    import { spawnWorker } from ${JSON.stringify(workerModule)};
    const before = process.listenerCount("SIGINT");
    {
      using worker = spawnWorker([process.execPath, "-e", ${JSON.stringify(`
        import { writeFileSync } from "node:fs";
        process.once("SIGINT", () => process.exit(37));
        writeFileSync(${JSON.stringify(ready)}, "");
        setTimeout(() => process.exit(99), 4000);
      `)}], process.env);
      console.log("worker status", await worker.exited);
    }
    console.log("extra SIGINT handlers", process.listenerCount("SIGINT") - before);
  `;

  const parent = Bun.spawn([process.execPath, "--no-install", "-e", program], { stdout: "pipe", stderr: "inherit" });

  try {
    for (let attempt = 0; attempt < 150 && !existsSync(ready); attempt++) await Bun.sleep(20);

    expect(existsSync(ready)).toBe(true);
    parent.kill("SIGINT");
    expect(await parent.exited).toBe(0);
    expect(await new Response(parent.stdout).text()).toBe("worker status 37\nextra SIGINT handlers 0\n");
  } finally {
    if (parent.exitCode === null) parent.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

import { expect, test } from "bun:test";

test("a burst paints one three-line log frame, and failure keeps output newer than that frame", async () => {
  const program = `
    import { ClackReporter } from "./src/report/clack.ts";
    const stage = new ClackReporter("office setup", "rerun").stage("Tools", { key: "tools" });
    stage.detail("installing packages");
    for (let i = 0; i < 100; i++) stage.output("package-" + i + " downloaded");
    await Bun.sleep(200);
    stage.output("installer exited unexpectedly");
    stage.fail("install failed");
  `;

  const run = Bun.spawn([process.execPath, "-e", program], { stdout: "pipe" });
  const output = await new Response(run.stdout).text();
  const frame = output.split("Tools failed")[0];
  expect(await run.exited).toBe(0);
  expect(frame.split("installing packages")).toHaveLength(2);
  expect(frame.match(/package-\d+ downloaded/g)).toEqual(["package-97 downloaded", "package-98 downloaded", "package-99 downloaded"]);
  expect(output).toContain("installer exited unexpectedly");
});

test("rapid repo replacements share a frame sized in terminal columns", async () => {
  const program = `
    import { ClackReporter } from "./src/report/clack.ts";
    Object.defineProperty(process.stdout, "columns", { value: 40 });
    const stage = new ClackReporter("office sync", "rerun").stage("Repos", { key: "repos" });
    stage.expect(26);
    let repo = stage.part("first", "cloning");
    await Bun.sleep(300);
    for (let i = 0; i < 25; i++) {
      repo.done("ok");
      repo = stage.part("界".repeat(24), "cloning");
    }
    await Bun.sleep(200);
    repo.done("ok");
    stage.done();
  `;

  const run = Bun.spawn([process.execPath, "-e", program], { stdout: "pipe" });
  const output = await new Response(run.stdout).text();
  const labels = Array.from(output.matchAll(/(\d+\/26 done[^\x1b\r\n]*)/g), (match) => match[1]);
  expect(await run.exited).toBe(0);
  expect(labels).toHaveLength(2);
  expect(labels[1]).toContain("25/26");
  expect(Bun.stringWidth(labels[1])).toBeLessThanOrEqual(28);
  expect(output.match(/✓/g)).toHaveLength(26);
});

test("the Tools indicator animates without erasing or repeating an unchanged label", async () => {
  const program = `
    import { ClackReporter } from "./src/report/clack.ts";
    const tools = new ClackReporter("office setup", "rerun").stage("Tools", { key: "tools" });
    tools.detail("checking the office's tools");
    await Bun.sleep(1100);
    tools.done();
  `;

  const run = Bun.spawn([process.execPath, "-e", program], { stdout: "pipe" });
  const output = await new Response(run.stdout).text();
  const label = "Tools: checking the office's tools";
  const live = output.slice(output.indexOf(label) + label.length, output.indexOf("\x1b[?25h"));

  expect(await run.exited).toBe(0);
  expect(output.split(label)).toHaveLength(2);
  expect(live).toMatch(/◐|◓|◑/);
  expect(live).not.toContain("\x1b[J");
});

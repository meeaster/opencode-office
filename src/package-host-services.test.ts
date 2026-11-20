import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOffice } from "./office.ts";
import { recordBuiltinFixture } from "./test-builtin-record.ts";
import { reconcileHostServices } from "./package-host-services.ts";

test("package units are applied once, upgraded explicitly, and removed when deselected", () => {
  const root = mkdtempSync(join(tmpdir(), "office-host-service-"));
  const previous = { ...process.env };
  const dir = join(root, "packages/demo");
  const manifest = "name: demo\ndescription: test\nhost:\n  services:\n    first:\n      description: first service\n      script: start.sh\n";
  const unit = join(root, "units/office-test-pkg-demo.first.service");

  try {
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(root, ".office/packages/office"), { recursive: true });
    writeFileSync(join(root, ".office/packages/office/package.yaml"), "name: office\ndescription: fixture\n");
    recordBuiltinFixture(join(root, ".office/packages/office"));
    writeFileSync(join(root, "office.yaml"), "name: test\nopencode: { mode: host, url: http://localhost:4096 }\npackages: [{ name: demo }]\n");
    writeFileSync(join(dir, "package.yaml"), manifest);
    writeFileSync(join(dir, "start.sh"), "exec sleep 3600");
    writeFileSync(join(root, "systemctl"), `#!/bin/sh\necho "$*" >> '${root}/calls'\n`);
    chmodSync(join(root, "systemctl"), 0o755);
    process.env.PATH = `${root}:${previous.PATH}`;
    process.env.OFFICE_SYSTEMD_USER_DIR = join(root, "units");
    const office = loadOffice(root);

    reconcileHostServices(office, "up");
    expect(readFileSync(unit, "utf8")).toContain("Description=first service");
    writeFileSync(join(dir, "package.yaml"), manifest.replace("first service", "new description"));
    reconcileHostServices(office, "up");
    expect(readFileSync(unit, "utf8")).toContain("Description=first service");
    reconcileHostServices(office, "upgrade");
    expect(readFileSync(unit, "utf8")).toContain("Description=new description");
    writeFileSync(join(dir, "package.yaml"), "name: demo\ndescription: test\n");
    reconcileHostServices(office, "up");
    expect(existsSync(unit)).toBe(false);
    expect(readFileSync(join(root, "calls"), "utf8")).toContain("--user disable --now office-test-pkg-demo.first.service");
  } finally {
    process.env.PATH = previous.PATH;

    if (previous.OFFICE_SYSTEMD_USER_DIR === undefined) delete process.env.OFFICE_SYSTEMD_USER_DIR;
    else process.env.OFFICE_SYSTEMD_USER_DIR = previous.OFFICE_SYSTEMD_USER_DIR;
    rmSync(root, { recursive: true, force: true });
  }
});

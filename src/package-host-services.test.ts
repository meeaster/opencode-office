import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOffice } from "./office.ts";
import { grantConsent, serviceEnvironment, syncMachine } from "./machine.ts";
import { envFilePath } from "./host-env.ts";
import { recordRequiredFixtures } from "./test-builtin-record.ts";
import { reconcileHostServices } from "./package-host-services.ts";
import { writePackage } from "./test-package.ts";

test("host services only load the recorded environment of the same office", () => {
  const root = mkdtempSync(join(tmpdir(), "office-unit-profile-"));
  const saved = { ...process.env };

  try {
    const record = join(root, "record.json");

    process.env.OFFICE_MACHINE_RECORD = record;
    process.env.OFFICE_MACHINE_DIR = root;
    process.env.OFFICE_MISE_CONFIG_DIR = join(root, "mise");
    writeFileSync(join(root, "office.yaml"), "name: demo\nopencode: {mode: host, url: http://localhost:4096}\ntools: {sfw: {enabled: false}}\n");
    const office = loadOffice(root);
    const file = envFilePath();

    writeFileSync(file, "echo foreign");
    expect(serviceEnvironment(office)).toBe("");
    grantConsent(office);
    expect(statSync(record).mode & 0o777).toBe(0o600);
    expect(() => serviceEnvironment(office)).toThrow("unrecorded");
    rmSync(file);
    syncMachine(office);
    expect(serviceEnvironment(office)).toContain("export MISE_MINIMUM_RELEASE_AGE=");
    expect(serviceEnvironment({ ...office, dir: join(root, "other") })).toBe("");

    for (const path of [record, file]) {
      chmodSync(path, 0o660);
      expect(() => serviceEnvironment(office)).toThrow("permission");
      chmodSync(path, 0o600);
      renameSync(path, `${path}.saved`);
      symlinkSync(`${path}.saved`, path);
      expect(() => serviceEnvironment(office)).toThrow("symlinks");
      renameSync(`${path}.saved`, path);
    }

    const original = readFileSync(record, "utf8");

    writeFileSync(record, "broken record");
    expect(() => serviceEnvironment(office)).toThrow("not JSON");
    writeFileSync(record, original.replace(/"sha256": "[a-f0-9]{64}"/g, `"sha256": "${"0".repeat(64)}"`));
    expect(() => serviceEnvironment(office)).toThrow("changed");
    writeFileSync(record, original);
    writeFileSync(file, "echo replaced");
    expect(() => serviceEnvironment(office)).toThrow("changed");
  } finally {
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test("package units are applied once, upgraded explicitly, and removed when deselected", () => {
  const root = mkdtempSync(join(tmpdir(), "office-host-service-"));
  const previous = { ...process.env };
  const dir = join(root, "packages/demo");
  const manifest = "# test\nhost:\n  services:\n    first:\n      description: first service\n      script: start.sh\n";
  const unit = join(root, "units/office-test-pkg-demo.first.service");

  try {
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(root, ".office/packages/office"), { recursive: true });
    writePackage(join(root, ".office/packages/office/package.yaml"), "# fixture\n{}\n");
    recordRequiredFixtures(join(root, ".office/packages/office"));
    writeFileSync(join(root, "office.yaml"), "name: test\nopencode: { mode: host, url: http://localhost:4096 }\npackages: [{ name: demo }]\n");
    writePackage(join(dir, "package.yaml"), manifest);
    writeFileSync(join(dir, "start.sh"), "exec sleep 3600");
    writeFileSync(join(root, "systemctl"), `#!/bin/sh\necho "$*" >> '${root}/calls'\n`);
    chmodSync(join(root, "systemctl"), 0o755);
    process.env.PATH = `${root}:${previous.PATH}`;
    process.env.OFFICE_SYSTEMD_USER_DIR = join(root, "units");
    const office = loadOffice(root);

    reconcileHostServices(office, "up");
    expect(readFileSync(unit, "utf8")).toContain("Description=first service");
    writePackage(join(dir, "package.yaml"), manifest.replace("first service", "new description"));
    reconcileHostServices(office, "up");
    expect(readFileSync(unit, "utf8")).toContain("Description=first service");
    reconcileHostServices(office, "upgrade");
    expect(readFileSync(unit, "utf8")).toContain("Description=new description");
    writePackage(join(dir, "package.yaml"), "# test\n{}\n");
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

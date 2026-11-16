import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import * as v from "valibot";
import { parseDocument } from "yaml";

import { loadOffice, type Office, OfficeError, readEnvFile } from "../office.ts";
import { atomicWrite, decrypt, encrypt, initializeIdentity, parsed, prepareSecrets, requireTool } from "../secrets.ts";
import { deploy } from "./apps.ts";
import { check } from "./check.ts";
import { assertGatewayMode, ports, startExecutor, up } from "./compose.ts";
import { bootstrapExecutor } from "./executor.ts";
import { sync } from "./sync.ts";

type SetupOptions = { ownerEmail?: string; generateAgeKey: boolean };

async function question(text: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new OfficeError(`${text} Rerun interactively or supply the documented setup options; no prompt was opened`);

  const terminal = createInterface({ input: process.stdin, output: process.stdout });

  try {
    return (await terminal.question(`${text} `)).trim();
  } finally {
    terminal.close();
  }
}

/** No wizard completion marker: each run inspects files, API state and the real services. */
export async function setup(initial: Office, options: SetupOptions): Promise<void> {
  let office = initial;

  requireTool("docker", ["info"]);
  requireTool("docker", ["compose", "version"]);
  requireTool("docker", ["buildx", "version"]);
  requireTool("git");

  if (options.generateAgeKey) initializeIdentity(office);

  // Legacy offices with a token need no new secrets configuration. Bootstrap does need portable
  // owner persistence; opt in without replacing unrelated YAML or any existing source.
  const hasToken = readEnvFile(join(office.state, "opencode-executor.env")).EXECUTOR_TOKEN;

  if (office.secrets?.executor_owner === undefined && !hasToken) {
    if (!existsSync(join(office.dir, ".sops.yaml"))) {
      const answer = options.generateAgeKey ? "yes" : await question("Executor bootstrap needs SOPS/age. Generate a host age identity and public .sops.yaml? [yes/no]");

      if (answer !== "yes") throw new OfficeError("setup paused; configure .sops.yaml with authorized age recipients, then rerun (or use --generate-age-key to consent)");

      initializeIdentity(office);
    }

    const document = parseDocument(readFileSync(join(office.dir, "office.yaml"), "utf8"));

    document.setIn(["secrets", "executor_owner"], "secrets/executor-owner.enc.json");
    atomicWrite(join(office.dir, "office.yaml"), document.toString(), 0o644);
    office = loadOffice(office.dir);
  }

  const ownerFile = office.secrets?.executor_owner;

  if (ownerFile !== undefined && !existsSync(join(office.dir, ownerFile))) {
    // Prove both recipient encryption and this host's identity before starting any service.
    const probe = encrypt(office, ownerFile, '{"readiness":"office setup"}');

    // No temporary plaintext; SOPS decrypts the encrypted stdin directly.
    try {
      execFileSync("sops", ["decrypt", "--input-type", "json", "--output-type", "json", "/dev/stdin"], {
        input: probe, stdio: ["pipe", "ignore", "pipe"], cwd: office.dir,
      });
    } catch {
      throw new OfficeError(`SOPS recovery is not ready for ${ownerFile}; enroll this host's public age recipient on an authorized host first`);
    }
  } else if (ownerFile !== undefined) {
    decrypt(office, ownerFile);
  }

  prepareSecrets(office, { allowMissingOwner: true });
  assertGatewayMode(office);

  const changes = await sync(office, { referencesOnly: false });

  for (const line of changes) console.log(line);

  if (changes.some((line) => line.startsWith("FAILED"))) throw new OfficeError("sync failed; fix the reported source and rerun office setup");

  let email = options.ownerEmail;

  if (!hasToken && ownerFile !== undefined && !existsSync(join(office.dir, ownerFile)) && email === undefined) {
    email = await question("Executor owner email:");
  }

  const crontab = join(office.dir, "cron/crontab");
  const scheduled = existsSync(crontab) && readFileSync(crontab, "utf8").split("\n").some((line) => line.trim() !== "" && !line.trim().startsWith("#"));

  if (scheduled) console.log("Cron: startup keeps the existing catch-up behavior, including jobs that have never run.");

  await startExecutor(office);
  await bootstrapExecutor(office, email);
  await up(office);

  if (office.claude !== undefined) await connectClaude(office);

  await deploy(office);

  if (!(await check(office))) throw new OfficeError("setup checks need attention; fix the reported issues and rerun office setup");

  console.log(`Services and apps are ready. Next: office pair (Executor dashboard: http://localhost:${ports().executor}).`);

  if (office.claude !== undefined) {
    console.log("Claude gateway selected and Claude Agent connected: no Claude subscription login is needed; no model request has been made.");
  } else {
    console.log(`Provider authentication remains human-controlled: use /connect in OpenCode and /models. For Claude Agent in container mode: docker exec -it office-${office.name}-opencode-1 claude auth login, then connect Claude Agent in OpenCode. Other provider logins are independent.`);
  }
}

async function connectClaude(office: Office): Promise<void> {
  const password = readEnvFile(join(office.state, "secrets.env")).OPENCODE_PASSWORD;
  const url = `http://127.0.0.1:${ports().opencode}`;

  const headers = {
    authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
    "content-type": "application/json",
    "x-opencode-directory": office.opencode.directory,
  };

  const integrationSchema = v.object({ data: v.object({
    methods: v.array(v.object({ id: v.optional(v.string()) })),
    connections: v.array(v.object({ status: v.optional(v.object({ status: v.string() })) })),
  }) });

  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`${url}/api/integration/claude-agent`, { headers, signal: AbortSignal.timeout(5_000) }).catch(() => undefined);

    if (response?.ok) {
      const integration = parsed(integrationSchema, await response.text(), "Claude integration");

      if (integration.data.connections.length > 0) {
        if (integration.data.connections.some((connection) => connection.status?.status === "needs_auth")) throw new OfficeError("Claude Agent reports authentication needed; check the selected gateway launcher and rerun setup");

        return;
      }

      if (integration.data.methods.some((method) => method.id === "claude-login")) break;
    }

    if (attempt === 59) throw new OfficeError("OpenCode did not become ready; rerun office setup");

    await Bun.sleep(2_000);
  }

  const response = await fetch(`${url}/api/integration/claude-agent/connect/external`, {
    method: "POST", headers, body: JSON.stringify({ methodID: "claude-login" }), signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) throw new OfficeError(`Claude Agent connection: HTTP ${response.status} (response withheld); rerun office setup after fixing the gateway launcher`);
}

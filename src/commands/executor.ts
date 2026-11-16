import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import * as v from "valibot";

import { type Office, OfficeError, readEnvFile } from "../office.ts";
import { atomicWrite, ownerRecord, parsed, saveOwner, source } from "../secrets.ts";
import { ports } from "./compose.ts";

export function executorUrl(): string {
  return `http://localhost:${ports().executor}`;
}

const id = v.pipe(v.string(), v.nonEmpty());
const contextSchema = v.object({ organization: id });
const configurationSchema = v.object({ setup: v.boolean() });
const organizationsSchema = v.array(v.object({ id, name: v.string() }));
const tokenSchema = v.object({ key: id });

/** Auth responses and errors are never logged: they can contain passwords, keys and cookies. */
async function request(path: string, method = "GET", body?: string, cookie = ""): Promise<Response> {
  try {
    return await fetch(`${executorUrl()}${path}`, {
      method,
      headers: { origin: executorUrl(), "content-type": "application/json", cookie },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new OfficeError(`Executor request failed at ${path}; rerun office setup when reachable`);
  }
}

async function successful(path: string, method = "GET", body?: string, cookie = ""): Promise<Response> {
  const response = await request(path, method, body, cookie);

  if (!response.ok) throw new OfficeError(`Executor ${path}: HTTP ${response.status} (response withheld). Existing accounts were not reset; check the stored owner's login or authenticate in Executor, save an organization-bound token locally and rerun office setup`);

  return response;
}

export async function validExecutorToken(office: Office): Promise<boolean> {
  const token = readEnvFile(join(office.state, "opencode-executor.env")).EXECUTOR_TOKEN;

  if (token === undefined || token === "") return false;

  const response = await fetch(`${executorUrl()}/api/context`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
  });

  if (response.status === 401 || response.status === 403) return false;

  if (!response.ok) throw new OfficeError(`Executor token check: HTTP ${response.status}; not creating a replacement token`);

  parsed(contextSchema, await response.text(), "Executor context");

  return true;
}

/** Stored owner is written and round-trip decrypted BEFORE the setup POST, making retries safe. */
export async function bootstrapExecutor(office: Office, email?: string): Promise<void> {
  if (await validExecutorToken(office)) {
    console.log("Executor: reusing the working local opencode token");

    return;
  }

  const configuration = parsed(configurationSchema, await (await successful("/api/auth/self-host/config")).text(), "Executor configuration");
  const file = office.secrets?.executor_owner;

  if (file === undefined) throw new OfficeError("Executor needs authentication. Set secrets.executor_owner: secrets/executor-owner.enc.json in office.yaml and configure .sops.yaml; use sops to store the existing owner's email, password, name and organization in that record, then rerun office setup. Alternatively save an existing organization-bound EXECUTOR_TOKEN in the local opencode-executor.env. Existing accounts were not reset");

  let owner;

  if (existsSync(source(office, file))) {
    owner = ownerRecord(office);
  } else {
    if (!configuration.setup) throw new OfficeError(`Executor already has accounts. Preserve them: use sops to create ${file} with the existing owner's email, password, name and organization, or save an existing organization-bound EXECUTOR_TOKEN in the local opencode-executor.env. No account was reset`);

    const checkedEmail = v.safeParse(v.pipe(v.string(), v.email()), email);

    if (!checkedEmail.success) throw new OfficeError("a fresh Executor needs --owner-email <email> (or answer the interactive prompt)");

    owner = {
      email: checkedEmail.output,
      password: randomBytes(32).toString("base64url"),
      name: `${office.name} owner`,
      organization: office.name,
    };

    saveOwner(office, file, owner);
    console.log(`Encrypted owner credentials saved to ${file}; review and commit this file with .sops.yaml and office.yaml`);

    // Deliberate terminal-only reveal; never send it to redirected logs or an agent transcript.
    if (process.stdout.isTTY && process.stdin.isTTY) process.stdout.write(`Generated Executor owner password (copy now): ${owner.password}\n`);
    else console.log("Owner password withheld from noninteractive output; retrieve deliberately with office executor credentials");
  }

  const path = configuration.setup ? "/api/auth/self-host/setup" : "/api/auth/sign-in/email";

  const body = configuration.setup
    ? { name: owner.name, email: owner.email, password: owner.password, organizationName: owner.organization }
    : { email: owner.email, password: owner.password };

  const login = await successful(path, "POST", JSON.stringify(body));
  const cookie = login.headers.getSetCookie().map((part) => part.split(";")[0]).join("; ");
  const organizations = parsed(organizationsSchema, await (await successful("/api/auth/organization/list", "GET", undefined, cookie)).text(), "Executor organizations");
  const organization = organizations.find((item) => item.name === owner.organization);

  if (organization === undefined) throw new OfficeError("stored owner's organization was not found; correct the encrypted owner record before retrying");

  const response = await successful("/api/auth/api-key/create", "POST", JSON.stringify({ name: "opencode", metadata: { organization: organization.id } }), cookie);
  const { key } = parsed(tokenSchema, await response.text(), "Executor token");

  atomicWrite(join(office.state, "opencode-executor.env"), `EXECUTOR_TOKEN=${key}\n`);
  console.log("Executor: saved the instance-local opencode token");
}

export function credentials(office: Office, passwordOnly: boolean): void {
  const owner = ownerRecord(office);

  if (passwordOnly) process.stdout.write(owner.password);
  else console.log(`Executor URL: ${executorUrl()}\nEmail: ${owner.email}\nPassword: ${owner.password}\nStored credentials; not a live password verification.`);
}

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
const tokenSchema = v.object({ id, key: id });
const keyListSchema = v.object({ apiKeys: v.array(v.object({ id, name: v.nullable(v.string()), createdAt: v.string(), lastRequest: v.nullable(v.string()) })) });

/**
 * An Executor key `office setup` keeps in the state folder, created as an organization-bound key
 * named `name`: OpenCode's own, which holds only `EXECUTOR_TOKEN`, or one for a service office.yaml
 * lists under `executor.tokens`, which also holds `EXECUTOR_ORGANIZATION`.
 */
export type ExecutorKey = { name: string; path: string; service: boolean };

export function executorKeys(office: Office): ExecutorKey[] {
  return [
    { name: "opencode", path: join(office.state, "opencode-executor.env"), service: false },
    ...office.executorTokens.map((name) => ({ name, path: join(office.state, `${name}-executor.env`), service: true })),
  ];
}

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

/**
 * The organization the key's saved token works for, or undefined when the file holds none or
 * Executor refuses it. Any other answer throws: a failing Executor must never lead to a new key.
 */
export async function keyOrganization(key: ExecutorKey): Promise<string | undefined> {
  const token = readEnvFile(key.path).EXECUTOR_TOKEN;

  if (token === undefined || token === "") return undefined;

  const response = await fetch(`${executorUrl()}/api/context`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
  });

  if (response.status === 401 || response.status === 403) return undefined;

  if (!response.ok) throw new OfficeError(`Executor ${key.name} token check: HTTP ${response.status}; not creating a replacement token`);

  return parsed(contextSchema, await response.text(), "Executor context").organization;
}

/** A service's file keeps any other lines' values; OpenCode's holds only its token, as it always has. */
function saveKey(key: ExecutorKey, token: string, organization: string): void {
  const values = key.service ? { ...readEnvFile(key.path), EXECUTOR_TOKEN: token, EXECUTOR_ORGANIZATION: organization } : { EXECUTOR_TOKEN: token };

  atomicWrite(key.path, Object.entries(values).map(([name, value]) => `${name}=${value}\n`).join(""));
}

/**
 * Keeps every key in `executorKeys` working: a working token is reused, and only missing or refused
 * ones are created, signed in as the stored owner. Stored owner is written and round-trip decrypted
 * BEFORE the setup POST, making retries safe.
 */
export async function bootstrapExecutor(office: Office, email?: string): Promise<void> {
  const missing: ExecutorKey[] = [];

  for (const key of executorKeys(office)) {
    const organization = await keyOrganization(key);
    const saved = readEnvFile(key.path);

    if (organization === undefined) {
      missing.push(key);
    } else if (key.service && saved.EXECUTOR_ORGANIZATION !== organization) {
      saveKey(key, saved.EXECUTOR_TOKEN, organization);
      console.log(`Executor: reusing the working ${key.name} token and saved its organization`);
    } else {
      console.log(`Executor: reusing the working local ${key.name} token`);
    }
  }

  if (missing.length === 0) return;

  const files = missing.map((key) => key.path).join(", ");
  const configuration = parsed(configurationSchema, await (await successful("/api/auth/self-host/config")).text(), "Executor configuration");
  const file = office.secrets?.executor_owner;

  if (file === undefined) throw new OfficeError(`Executor needs authentication to create a token for ${files}. Set secrets.executor_owner: secrets/executor-owner.enc.json in office.yaml and configure .sops.yaml; use sops to store the existing owner's email, password, name and organization in that record, then rerun office setup. Alternatively save an existing organization-bound EXECUTOR_TOKEN in each of those files. Existing accounts were not reset`);

  let owner;

  if (existsSync(source(office, file))) {
    owner = ownerRecord(office);
  } else {
    if (!configuration.setup) throw new OfficeError(`Executor already has accounts. Preserve them: use sops to create ${file} with the existing owner's email, password, name and organization, or save an existing organization-bound EXECUTOR_TOKEN in ${files}. No account was reset`);

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

  const created = new Set<string>();

  for (const key of missing) {
    const response = await successful("/api/auth/api-key/create", "POST", JSON.stringify({ name: key.name, metadata: { organization: organization.id } }), cookie);
    const token = parsed(tokenSchema, await response.text(), "Executor token");

    saveKey(key, token.key, organization.id);
    created.add(token.id);
    console.log(`Executor: saved the instance-local ${key.name} token`);
  }

  // A refused key is already gone (Executor deletes revoked and expired keys), so any other key with
  // a replaced key's name still works, and may be in use: a service still running with the old token,
  // or one made by hand. Name them, never delete them.
  const keys = parsed(keyListSchema, await (await successful("/api/auth/api-key/list", "GET", undefined, cookie)).text(), "Executor keys");

  for (const key of missing) {
    const others = keys.apiKeys.filter((item) => item.name === key.name && !created.has(item.id));

    if (others.length > 0) {
      const described = others.map((item) => `created ${item.createdAt}, last used ${item.lastRequest ?? "never"}`).join("; ");

      console.log(`Executor: ${others.length} older key(s) named ${key.name} still work (${described}). office deletes none, since something may still use one; once nothing does, delete it under Tokens in Executor's dashboard (${executorUrl()}/account/tokens)`);
    }
  }
}

export function credentials(office: Office, passwordOnly: boolean): void {
  const owner = ownerRecord(office);

  if (passwordOnly) process.stdout.write(owner.password);
  else console.log(`Executor URL: ${executorUrl()}\nEmail: ${owner.email}\nPassword: ${owner.password}\nStored credentials; not a live password verification.`);
}

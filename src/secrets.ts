// SOPS runs only on the host. Plaintext travels over stdin/stdout, never command arguments.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import * as v from "valibot";

import { requireOfficeTool } from "./host-tools.ts";
import { type Office, OfficeError } from "./office.ts";
import { check, serverVariable } from "./schema.ts";

function identityFile(): string {
  return process.env.SOPS_AGE_KEY_FILE ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "sops/age/keys.txt");
}

function requireExternal(office: Office, path: string, label: string): void {
  const location = relative(office.dir, resolve(path));

  if (!location.startsWith("..") && !isAbsolute(location)) throw new OfficeError(`${label} must be outside the office repository, which is mounted into OpenCode`);
}

export function requireHostIdentity(office: Office): string {
  const key = resolve(identityFile());
  const withinState = relative(office.state, resolve(key));

  requireExternal(office, key, "the age private identity");

  if (!withinState.startsWith("..") && !isAbsolute(withinState)) throw new OfficeError("the age private identity must be outside office runtime state; parts of that state are mounted into OpenCode");

  return key;
}

const nonempty = v.pipe(v.string(), v.trim(), v.nonEmpty());

const serverSchema = v.record(serverVariable, v.pipe(v.string(), v.regex(/^[^\0]*$/)));

export const ownerSchema = v.strictObject({
  email: v.pipe(nonempty, v.email()),
  password: v.pipe(v.string(), v.nonEmpty()),
  name: nonempty,
  organization: nonempty,
});

export type Owner = v.InferOutput<typeof ownerSchema>;

export function parsed<Schema extends v.GenericSchema>(schema: Schema, text: string, label: string): v.InferOutput<Schema> {
  let document;

  try {
    document = JSON.parse(text);
  } catch {
    throw new OfficeError(`${label}: expected valid JSON (contents withheld)`);
  }

  const result = check(v.safeParse(schema, document));

  if (!result.ok) throw new OfficeError(`${label}: invalid fields (contents withheld)`);

  return result.value;
}

/** Portable sources belong to the office, never an absolute machine-specific path. */
export function source(office: Office, file: string): string {
  const path = resolve(office.dir, file);
  const within = relative(office.dir, path);

  if (isAbsolute(file) || within.startsWith("..")) throw new OfficeError("secret/config sources must be relative paths inside the office");

  return path;
}

export function atomicWrite(path: string, content: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });

  const temporary = `${path}.${randomBytes(8).toString("hex")}.new`;

  try {
    writeFileSync(temporary, content, { mode, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function requireTool(tool: string, args = ["--version"]): void {
  try {
    execFileSync(tool, args, { stdio: "ignore" });
  } catch {
    throw new OfficeError(`install/enable ${tool} on the host first; see README.md prerequisites. No Node/npm runtime is needed`);
  }
}

export function decrypt(office: Office, file: string, sops = requireOfficeTool(office, "sops"), identity = requireHostIdentity(office)): string {
  try {
    return execFileSync(sops, ["decrypt", "--output-type", "json", source(office, file)], {
      cwd: office.dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SOPS_AGE_KEY_FILE: identity },
    });
  } catch {
    throw new OfficeError(`cannot decrypt ${file}. Supply an authorized age identity (SOPS_AGE_KEY_FILE or the standard SOPS age keys.txt). For a new host, send its PUBLIC recipient to an authorized host, add it to .sops.yaml, then run sops updatekeys ${file} there and sync the encrypted file. A new key alone cannot decrypt existing secrets`);
  }
}

/** Validate without returning any secret values to the caller. */
export function validateServerSecrets(office: Office, file: string, sops: string, identity: string): void {
  const values = parsed(serverSchema, decrypt(office, file, sops, identity), file);

  if (Object.keys(values).some((key) => Object.hasOwn(office.opencode.managed?.envCommands ?? {}, key))) {
    throw new OfficeError(`${file}: a variable is also defined by opencode.env_commands (contents withheld)`);
  }
}

export function encrypt(office: Office, file: string, plaintext: string): string {
  const sops = requireOfficeTool(office, "sops");

  try {
    return execFileSync(sops, ["encrypt", "--filename-override", source(office, file), "--input-type", "json", "--output-type", "json", "/dev/stdin"], {
      cwd: office.dir, input: plaintext, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    throw new OfficeError(`cannot encrypt ${file}; configure public age recipients in .sops.yaml first (contents withheld)`);
  }
}

/** Prove encryption AND local recovery before any owner account can be created. */
export function saveOwner(office: Office, file: string, owner: Owner): void {
  const encrypted = encrypt(office, file, JSON.stringify(owner));
  const target = source(office, file);

  atomicWrite(target, encrypted);

  const recovered = parsed(ownerSchema, decrypt(office, file), file);

  if (recovered.password !== owner.password) throw new OfficeError("encrypted owner recovery verification failed");
}

export function ownerRecord(office: Office): Owner {
  const file = office.secrets?.executor_owner;

  if (file === undefined) throw new OfficeError("no secrets.executor_owner source configured; run office setup");

  return parsed(ownerSchema, decrypt(office, file), file);
}

/** Explicit consent only; never replace an identity or amend existing recipients. */
export function initializeIdentity(office: Office): void {
  const keygen = requireOfficeTool(office, "age-keygen");

  const key = requireHostIdentity(office);

  if (!existsSync(key)) {
    mkdirSync(dirname(key), { recursive: true, mode: 0o700 });

    try {
      execFileSync(keygen, ["-o", key], { stdio: "ignore" });
      chmodSync(key, 0o600);
    } catch {
      throw new OfficeError("age identity generation failed; existing files were not replaced");
    }
  }

  let recipient;

  try {
    recipient = execFileSync(keygen, ["-y", key], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new OfficeError("cannot derive a public recipient from the selected age identity (contents withheld)");
  }

  console.log(`Public age recipient: ${recipient}`);

  const config = join(office.dir, ".sops.yaml");

  if (!existsSync(config)) {
    atomicWrite(config, `creation_rules:\n  - path_regex: secrets/.*\\.enc\\.(json|yaml)$\n    age: ${recipient}\n`, 0o644);
  } else {
    console.log("Existing .sops.yaml preserved. An authorized host must enroll this public recipient and run sops updatekeys on every selected encrypted file.");
  }
}

/** Decrypts the configured sources before any service changes, so a failure changes nothing. */
export function prepareSecrets(office: Office, { allowMissingOwner = false } = {}): void {
  const owner = office.secrets?.executor_owner;

  if (owner !== undefined && (!allowMissingOwner || existsSync(source(office, owner)))) ownerRecord(office);
}

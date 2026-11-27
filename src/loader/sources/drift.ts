import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Office } from "../../office.ts";
import { readRecord, sourceDifferences, sourceFile } from "./copies.ts";
import { describeRecord, embeddedPackage, fileHashes, localEdits, officeFile, officeText, readOnlyNote } from "./records.ts";
import type { ResolvedPackage } from "./selection.ts";

/** Checks a package's copy and the office declaration separately so check can report settings between them. */
export async function sourceDrift(office: Office, { dir, entry, kind }: ResolvedPackage) {
  const copyNotes: string[] = [];
  const declarationNotes: string[] = [];
  let ok = true;

  if (kind !== "local") {
    ok = await pulledCopy(dir, kind, entry.name, copyNotes);

    const record = readRecord(dir);

    if (kind === "remote" && entry.source !== undefined && record !== undefined && !("repo" in record && !sourceDifferences(record, entry.source).length)) {
      copyNotes.push(`office.yaml asks for ${entry.source.ref}; office sync updates it`);
      ok = false;
    }
  }

  const officePath = join(dir, officeFile);

  if (!existsSync(officePath) || readFileSync(officePath, "utf8") !== officeText(office)) {
    declarationNotes.push(`${relative(office.dir, officePath)} doesn't say opencode: ${office.opencode.mode}; office sync writes it`);
    ok = false;
  }

  return { ok, copyNotes, declarationNotes };
}

/**
 * Whether a pulled-in package's files are the copy office sync put there, and for a built-in one,
 * this executable's copy. Each note is added to `notes`; returns whether the copy is as it should be.
 */
async function pulledCopy(dir: string, kind: "built-in" | "remote", name: string, notes: string[]): Promise<boolean> {
  const record = readRecord(dir);

  if (record === undefined) {
    notes.push(`no readable ${sourceFile} (office sync replaces the copy)`);

    return false;
  }

  notes.push(`from ${describeRecord(record)}`);

  const edits = localEdits(dir, record);

  if (edits.length > 0) {
    notes.push(`package files edited: ${edits.join(", ")}; office sync restores them, as ${readOnlyNote}`);

    return false;
  }

  if (kind === "built-in") {
    const { hashes } = await embeddedPackage(name);

    if (!Bun.deepEquals(fileHashes(dir), hashes)) {
      notes.push("differs from this office executable's copy (office sync updates it)");

      return false;
    }
  }

  notes.push("package files as copied");

  return true;
}

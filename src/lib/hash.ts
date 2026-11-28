import { createHash } from "node:crypto";

/** The SHA-256 of `content`, as lowercase hex. */
export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

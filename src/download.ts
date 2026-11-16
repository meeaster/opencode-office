import { OfficeError } from "./office.ts";

export async function fetchBytes(url: string, what: string): Promise<Uint8Array> {
  try {
    const response = await fetch(url, { headers: { "user-agent": "office" }, signal: AbortSignal.timeout(600_000) });

    if (!response.ok) throw new OfficeError(`downloading ${what} answered HTTP ${response.status}`);

    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof OfficeError) throw error;

    throw new OfficeError(`couldn't download ${what}: ${error instanceof Error ? error.message.trim() : String(error)}`);
  }
}

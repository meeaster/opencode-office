import { changeText } from "../../src/lib/change.ts";
import { sync } from "../../src/commands/sync.ts";

export async function syncLines(...args: Parameters<typeof sync>) {
  return (await sync(...args)).map(changeText);
}

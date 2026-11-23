import { changeText } from "./change.ts";
import { sync } from "./commands/sync.ts";

export async function syncLines(...args: Parameters<typeof sync>) {
  return (await sync(...args)).map(changeText);
}

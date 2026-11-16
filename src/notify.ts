// Notifications from the office's own jobs go to the first desk's app (`notifications.send`), the
// outbox a dashboard can read. A job still finishes when Executor can't be reached; it logs instead.
import { type ExecutorApp, client, connection } from "./commands/apps.ts";
import type { Office } from "./office.ts";

export async function notify(office: Office, { title, body }: { title: string; body: string }): Promise<void> {
  const desk = office.desks[0]?.name;

  try {
    if (desk === undefined) throw new Error("the office has no desk");

    const call = client(connection(office));
    const { organization } = await call<{ organization: string }>("GET", "/api/context");
    const app = (await call<ExecutorApp[]>("GET", `/api/organizations/${organization}/apps`)).find((entry) => entry.slug === desk);

    if (app === undefined) throw new Error(`no Executor app for the ${desk} desk`);

    await call("POST", `/api/organizations/${organization}/apps/${app.id}/tools/call`, { tool: "notifications.send", input: { title, body } });
    console.log(`notified the ${desk} desk: ${title}`);
  } catch (error) {
    console.log(`couldn't notify (${error instanceof Error ? error.message : String(error)}): ${title}\n${body}`);
  }
}

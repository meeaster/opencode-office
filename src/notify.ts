// Notifications from the office's own jobs go to the app of the first desk that has one
// (`notifications.send`), the outbox a dashboard can read. A job still finishes when Executor
// can't be reached; it logs instead.
import { type ExecutorApp, client, connection } from "./commands/apps.ts";
import type { Office } from "./office.ts";
import { say } from "./report/index.ts";

export async function notify(office: Office, { title, body }: { title: string; body: string }): Promise<void> {
  const desk = office.desks.find((candidate) => candidate.app)?.name;

  try {
    if (desk === undefined) throw new Error("no desk has an Executor app");

    const call = client(connection(office));
    const { organization } = await call<{ organization: string }>("GET", "/api/context");
    const app = (await call<ExecutorApp[]>("GET", `/api/organizations/${organization}/apps`)).find((entry) => entry.slug === desk);

    if (app === undefined) throw new Error(`no Executor app for the ${desk} desk`);

    await call("POST", `/api/organizations/${organization}/apps/${app.id}/tools/call`, { tool: "notifications.send", input: { title, body } });
    say(`notified the ${desk} desk: ${title}`);
  } catch (error) {
    say(`couldn't notify (${error instanceof Error ? error.message : String(error)}): ${title}\n${body}`);
  }
}

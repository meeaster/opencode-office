// Notifications from the office's own jobs go to the Executor app office.yaml names under
// `executor.notifications`, through its `notifications.send` (the outbox a dashboard can read). A
// job still finishes without one, or when Executor can't be reached; it logs instead.
import { client, connection } from "./executor.ts";
import type { Office } from "./office.ts";
import { say } from "./report/index.ts";

export async function notify(office: Office, { title, body }: { title: string; body: string }): Promise<void> {
  const slug = office.notificationsApp;

  try {
    if (slug === undefined) throw new Error("office.yaml names no app under executor.notifications");

    const call = client(connection(office));
    const { organization } = await call<{ organization: string }>("GET", "/api/context");
    const app = (await call<{ id: string; slug: string }[]>("GET", `/api/organizations/${organization}/apps`)).find((entry) => entry.slug === slug);

    if (app === undefined) throw new Error(`no Executor app ${slug}, which executor.notifications names`);

    await call("POST", `/api/organizations/${organization}/apps/${app.id}/tools/call`, { tool: "notifications.send", input: { title, body } });
    say(`notified the ${slug} app: ${title}`);
  } catch (error) {
    say(`couldn't notify (${error instanceof Error ? error.message : String(error)}): ${title}\n${body}`);
  }
}

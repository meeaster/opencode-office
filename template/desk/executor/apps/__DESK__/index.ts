// The __DESK__ desk's own app: its reports, its notification outbox (a dashboard can read both),
// and `agent.ask`, which runs an OpenCode session in the desk's folder and saves the reply as a
// report. Add schedules or webhooks that call `agent.ask`, or mutations that gather data first.
import {
  defineApp,
  mutation,
  type MutationContext,
  NonRetryableError,
  number,
  object,
  query,
  type QueryContext,
  router,
  string,
  workflow,
  type WorkflowContext,
  type WorkflowStepContext,
} from "apps";

import { type Client, officeDirectory, opencode, sessionResult, startSession } from "./opencode.js";

// OpenCode is the app's own account, so schedules and workflows run without a caller.
const requirements = { app: { accounts: { opencode } } };

const deskDirectory = `${officeDirectory}/__DESK__`;

type Report = { id: string; kind: string; title: string; summary: string; createdAt: number };

type FullReport = Report & { body: string };

type Notification = {
  seq: number;
  id: string;
  title: string;
  body: string;
  reportId: string | null;
  createdAt: number;
  readAt: number | null;
};

type Query = QueryContext<typeof requirements>;

type Mutation = MutationContext<typeof requirements>;

// Writes a workflow also runs as a step take the app-scope context: a step has no caller.
type AppMutation = MutationContext<typeof requirements, "app">;

const reportColumns = "id, kind, title, summary, created_at AS createdAt";

const notificationColumns = "seq, id, title, body, report_id AS reportId, created_at AS createdAt, read_at AS readAt";

const ReportInput = object({
  kind: string({ description: "A short category, such as summary or note" }),
  title: string(),
  summary: string({ description: "One line shown in lists" }),
  body: string({ description: "Markdown" }),
});

const NotificationInput = object({ title: string(), body: string(), reportId: string().optional() });

type Sql = AppMutation["sql"];

// Jobs that write a report and its notification in one transaction call these directly.
function insertReport(sql: Sql, report: { kind: string; title: string; summary: string; body: string }): Report {
  return sql
    .exec<Report>(
      `INSERT INTO reports (id, kind, title, summary, body, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING ${reportColumns}`,
      crypto.randomUUID(),
      report.kind,
      report.title,
      report.summary,
      report.body,
      Date.now(),
    )
    .one();
}

function insertNotification(sql: Sql, notification: { title: string; body: string; reportId?: string | undefined }): Notification {
  return sql
    .exec<Notification>(
      `INSERT INTO notifications (id, title, body, report_id, created_at) VALUES (?, ?, ?, ?, ?) RETURNING ${notificationColumns}`,
      crypto.randomUUID(),
      notification.title,
      notification.body,
      notification.reportId ?? null,
      Date.now(),
    )
    .one();
}

const save = mutation(
  { description: "Save a report, such as a summary or an investigation", input: ReportInput },
  // A workflow runs it as a step, whose writes must sit in one transaction.
  async ({ sql }: AppMutation, report) => sql.transaction(() => insertReport(sql, report)),
);

const send = mutation(
  { description: "Send the user a notification on their desktop, optionally pointing to a report", input: NotificationInput },
  async ({ sql }: AppMutation, notification) => sql.transaction(() => insertNotification(sql, notification)),
);

const reports = router<Query, Mutation>(
  {
    list: query(
      {
        description: "List recent reports, newest first, without their bodies",
        input: object({ limit: number({ description: "At most 100" }).default(20) }),
      },
      async ({ sql }, { limit }) =>
        sql.exec<Report>(`SELECT ${reportColumns} FROM reports ORDER BY created_at DESC LIMIT ?`, Math.min(limit, 100)).toArray(),
    ),
    get: query(
      { description: "Read one report with its Markdown body", input: object({ id: string() }) },
      async ({ sql }, { id }) => sql.exec<FullReport>(`SELECT ${reportColumns}, body FROM reports WHERE id = ?`, id).toArray()[0] ?? null,
    ),
    save,
  },
  { title: "Reports", description: "Reports this desk's agents and jobs saved." },
);

const notifications = router<Query, Mutation>(
  {
    list: query(
      {
        description: "List notifications after a sequence number, oldest first; pass the last seq seen to get only new ones",
        input: object({ after: number().default(0), limit: number({ description: "At most 100" }).default(50) }),
      },
      async ({ sql }, { after, limit }) =>
        sql
          .exec<Notification>(`SELECT ${notificationColumns} FROM notifications WHERE seq > ? ORDER BY seq LIMIT ?`, after, Math.min(limit, 100))
          .toArray(),
    ),
    send,
    markRead: mutation(
      { description: "Mark a notification as read", input: object({ id: string() }) },
      async ({ sql }, { id }) => ({
        updated: sql.exec("UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL", Date.now(), id).rowsWritten > 0,
      }),
    ),
  },
  { title: "Notifications", description: "The outbox a dashboard can turn into desktop notifications." },
);

function client(ctx: WorkflowStepContext<typeof requirements, "app">): Client {
  return { fetch: ctx.fetch, signal: ctx.signal, password: ctx.app.accounts.opencode.fields.password };
}

const Ask = object({
  title: string({ description: "The report's title" }),
  prompt: string({ minLength: 1 }),
});

const pollInterval = "15 seconds";
const maxPolls = 240; // One hour at the poll interval.

// Runs a session in the desk's folder, so it loads the desk's instructions, config and skills,
// then files the reply (or the failure) as a report with a notification.
const askWorkflow = workflow(
  { description: "Run an OpenCode session in this desk's folder and save its reply as a report", input: Ask },
  async ({ step }: WorkflowContext<typeof requirements, "app">, { title, prompt }) => {
    // Starting twice would run the prompt twice, so this step never retries.
    const { sessionID } = await step.do("start", { retries: { limit: 0, delay: "1 second" } }, async (ctx) =>
      startSession(client(ctx), { directory: deskDirectory, prompt, title }),
    );

    for (let poll = 1; poll <= maxPolls; poll += 1) {
      await step.sleep(`wait ${poll}`, pollInterval);

      const result = await step.do(`check ${poll}`, async (ctx) => sessionResult(client(ctx), sessionID));

      if (result.running) continue;

      const failed = result.error !== undefined || result.reply === undefined;
      const body = failed ? `The session ended without a reply: ${result.error ?? result.outcome ?? "no text"}.` : result.reply;
      const summary = failed ? "Failed" : (body.split("\n").find((line) => line.trim() !== "")?.slice(0, 200) ?? "");

      const report = await step.runMutation("save report", save, {
        kind: "agent",
        title,
        summary,
        body: `${body}\n\n_OpenCode session \`${sessionID}\` in \`__DESK__/\`._`,
      });

      await step.runMutation("notify", send, { title, body: summary, reportId: report.id });

      return { sessionID, reportId: report.id };
    }

    throw new NonRetryableError(`OpenCode session ${sessionID} was still running after one hour`);
  },
);

const ask = mutation(
  {
    description:
      "Start an agent run in this desk's folder: an OpenCode session with this prompt, whose reply is saved as a report with a notification. Returns the workflow run.",
    input: Ask,
  },
  async (ctx: AppMutation, input) => ctx.workflows.start({ workflow: "ask", input }),
);

export default defineApp(requirements, {
  tools: router(
    { reports, notifications, agent: router({ ask }, { title: "Agent runs" }) },
    {
      title: "__DESK_TITLE__",
      description: "The __DESK__ desk's own data and jobs: reports, desktop notifications and agent runs.",
      instructions:
        "Use reports.save for anything worth keeping and notifications.send to reach the user on their desktop. agent.ask runs an agent in the desk's folder and files its reply as a report.",
    },
  ),
  workflows: { ask: askWorkflow },
});

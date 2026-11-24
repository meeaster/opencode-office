// An example of a package's full-sync work and session text. At each full `office sync` it checks
// that every mirror with a URL answers, one item per mirror: an unreachable one fails that item,
// and sync, without stopping the others. Every session gets the list of mirrors and descriptions.
import { Package } from "@office/sdk";
import { settingsSchema } from "./settings.ts";

export default Package.define({
  settings: settingsSchema,
  fullSync: ({ settings }) => settings.mirrors.flatMap(({ name, url }) => url === undefined ? [] : [{
    item: name,
    async run(output) {
      const git = Bun.spawn(["git", "ls-remote", url, "HEAD"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
      const [head, errors, status] = await Promise.all([new Response(git.stdout).text(), new Response(git.stderr).text(), git.exited]);

      const lines = errors.trim().split("\n");

      if (status !== 0) return { ok: false, reason: lines.find(line => line.startsWith("fatal:")) ?? lines.at(-1) ?? `git ls-remote exited ${status}` };
      output(head.trim());

      return { ok: true, summary: "reachable" };
    },
  }]),
  session: ({ settings }) => settings.mirrors.length === 0 ? "" : [
    "# Mirrors",
    "",
    ...settings.mirrors.map(({ name, description, url }) => `- ${name}: ${description}${url === undefined ? " (local only)" : ` (${url})`}`),
  ].join("\n"),
});

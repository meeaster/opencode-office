// What the office's packages add to every session (a definition's `session`), as `office
// instructions --packages` prints it: the plugin asks the `office` on the server's PATH once per
// session, so the text reflects the settings the last sync applied and files as they are then.
// The plugin never loads another package's code itself.

/** The packages' session text for the office at `office`, or "" when there is none or it can't be read (said on standard error). */
export async function packageText(office: string): Promise<string> {
  const command = Bun.which("office", { PATH: process.env.PATH ?? "" });

  if (command === null) {
    console.error("office plugin: no office on PATH, so sessions get no package text");

    return "";
  }

  const child = Bun.spawn([command, "--office", office, "instructions", "--packages"], { cwd: office, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [text, errors, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);

  if (errors.trim()) console.error(`office plugin: office instructions --packages: ${errors.trim()}`);

  return status === 0 ? text.trim() : "";
}

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadOffice } from "../office.ts";
import { sessionInstructions } from "./session-instructions.ts";

test("reads only the requested session's stored entries, preserving custom keys and multiline text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "office-session-instructions-"));

  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      if (request.method !== "GET" || request.headers.get("authorization") !== `Basic ${Buffer.from("opencode:fixture").toString("base64")}`) return new Response(null, { status: 403 });

      switch (new URL(request.url).pathname) {
        case "/api/experimental/session/ses_full/instructions/entries":
          return Response.json({ data: [{ key: "desk-custom", value: "First line\n\n  indented\n" }, { key: "extra", value: "Last" }] });
        case "/api/experimental/session/ses_empty/instructions/entries":
          return Response.json({ data: [] });
        case "/api/experimental/session/ses_invalid/instructions/entries":
          return Response.json({ data: [{ key: "custom" }] });
        default:
          return new Response(null, { status: 404 });
      }
    },
  });

  try {
    writeFileSync(join(dir, "office.yaml"), `name: proof\nstate: .\nopencode: { mode: host, url: "${server.url.origin}" }\n`);
    writeFileSync(join(dir, "secrets.env"), "OPENCODE_PASSWORD=fixture\n");
    const office = loadOffice(dir);

    expect(await sessionInstructions(office, "ses_full")).toBe("## desk-custom\n\nFirst line\n\n  indented\n\n\n## extra\n\nLast");
    expect(await sessionInstructions(office, "ses_empty")).toBe("No stored instruction entries for ses_empty.");
    await expect(sessionInstructions(office, "ses_missing")).rejects.toThrow("ses_missing");
    await expect(sessionInstructions(office, "ses_invalid")).rejects.toThrow("did not return session instruction entries");
  } finally {
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

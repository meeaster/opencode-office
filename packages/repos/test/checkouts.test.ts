// What the repos package shows of a URL: never the credentials in it, wherever Git or a
// checkout's config put them.
import { expect, test } from "bun:test";
import { redactUrl } from "@office/sdk/redact-url";

test("credentials in any URL of a line are hidden; the rest of the line stays", () => {
  expect(redactUrl("fatal: unable to access 'https://user:t0ken@example.invalid/x.git/': Could not resolve host")).toBe("fatal: unable to access 'https://***@example.invalid/x.git/': Could not resolve host");
  expect(redactUrl("has origin ssh://git@example.invalid/a.git, not the declared https://ghp_abc@example.invalid/a.git")).toBe("has origin ssh://***@example.invalid/a.git, not the declared https://***@example.invalid/a.git");
  expect(redactUrl("fetched from https://example.invalid/a.git and /srv/b.git")).toBe("fetched from https://example.invalid/a.git and /srv/b.git");
  expect(redactUrl("https://demo:pass@word@example.invalid?next=demo@example.invalid")).toBe("https://***@example.invalid?next=demo@example.invalid");
});

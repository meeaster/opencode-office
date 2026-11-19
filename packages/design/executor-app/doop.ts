// The office's Doop as this app reaches it, and the account it connects with.
//
// Executor runs in the office's compose project in either mode, so it reaches Doop by its service
// name, http://doop:<port>, where an agent key works. OAuth needs more: Doop names its browser
// address (BETTER_AUTH_URL) as the authorization server and every endpoint, and Executor
// discovers, registers and exchanges codes from its own container, where http://localhost:<port>
// is Executor itself. So with `oauth` on and no `url`, Doop's address is
// http://doop.localhost:<port>: browsers resolve it to loopback, and the package's compose file
// gives Doop that alias on the compose network. address.ts holds the rule, which the compose file
// and plugin follow too.
import { defineProvider, oauth2, object, secrets, string } from "apps";
import { mcpHealth } from "apps/mcp";

import { browserAddress as addressOf, oauthOffered as offersOauth } from "./address.js";
import { settings } from "./package.js";

const port = Number(settings.port);

/** Whether the office offers OAuth sign-in beside the agent key. */
const oauthOffered = offersOauth(settings);

/** The address the user's browser opens Doop at, and the one Doop advertises. */
const browserAddress = addressOf(settings);

/** Doop's MCP endpoint on the compose network, for agent keys. */
const serviceMcp = `http://doop:${port}/mcp`;

/** Doop's MCP endpoint at the shared address, for OAuth tokens, which Doop issues for it. */
const sharedMcp = `${browserAddress}/mcp`;

const agentKey = secrets({
  label: "Agent key",
  // A code span: setup help may link only to https addresses, and Doop's is often plain http.
  guide: oauthOffered
    ? `
    Sign in to Doop at \`${browserAddress}\` as the person the office's agents act as: their
    canvases, access and edits are that account's. **Sign in with Doop** needs no key; sign in to
    Doop in this browser first, then choose it here.
  `
    : `
    Sign in to Doop at \`${browserAddress}\` as the person the office's agents act as: their
    canvases, access and edits are that account's.
  `,
  fields: object({
    key: string({
      title: "Agent key",
      description: `Create one in Doop under **Settings → Agent keys**, named after the office. Doop shows it once; it starts with \`dpk_\`.`,
    }),
  }),
});

const signIn = oauth2({ discover: sharedMcp });

// Executor substitutes a credential only on requests to these hosts.
const hosts = oauthOffered ? [`doop:${port}`, new URL(browserAddress).host] : [`doop:${port}`];

type Account = { method: "agentKey"; fields: { key: string } } | { method: "signIn"; fields: { access_token: string } };

/** Where an account's requests go, and the header that carries its credential. */
type Endpoint = { url: string; headers: Record<string, string> };

export function endpoint(account: Account): Endpoint {
  if (account.method === "agentKey") return { url: serviceMcp, headers: { Authorization: `Bearer ${account.fields.key}` } };

  return { url: sharedMcp, headers: { Authorization: `Bearer ${account.fields.access_token}` } };
}

const keyOnly = defineProvider({
  name: "Doop",
  hosts,
  auth: { agentKey },
  health: (check) => mcpHealth(check, endpoint(check.account)),
});

const keyOrSignIn = defineProvider({
  name: "Doop",
  hosts,
  auth: { agentKey, signIn },
  health: (check) => mcpHealth(check, endpoint(check.account)),
});

/**
 * The Doop account the app uses. Turning `oauth` on or off changes the provider, so an account
 * connected before must be connected again.
 */
export const doop = oauthOffered ? keyOrSignIn : keyOnly;

import { Package } from "@office/sdk";

export default Package.define({
  namespace: "doop",
  settings: {
    type: "object",
    additionalProperties: false,
    properties: {
      port: { type: "integer", default: 41441, description: "The loopback port Doop is published on, and listens on inside its container, so the browser opens http://localhost:<port>" },
      url: { type: "string", default: "", description: "The exact address the browser opens Doop at, when a reverse proxy such as a Tailscale Service fronts it, such as https://doop.<tailnet>.ts.net, without a trailing slash; empty for http://localhost:<port>" },
      executor_app: { type: "boolean", default: false, description: "Whether sessions reach Doop through the doop Executor app, with one Doop account a person connects in Executor for the whole office, instead of the doop MCP server and the agent key file; office apps deploy deploys the app" },
      oauth: { type: "boolean", default: true, description: "Whether the doop Executor app offers signing in to Doop (OAuth) beside the agent key. Without url, Doop then opens at http://doop.localhost:<port>, which the browser and Executor's container both reach; with url, that address must reach Doop from Executor's container too. False offers only the agent key and keeps http://localhost:<port>" },
    },
  },
  executor_app: { setting: "executor_app" },
  secrets: {
    DOOP_BETTER_AUTH_SECRET: { generate: "hex", bytes: 32 },
    DOOP_SECRETS_ENCRYPTION_KEYS: { generate: "base64", bytes: 32, prefix: "k1:" },
    DOOP_DB_PASSWORD: { generate: "hex", bytes: 32 },
  },
});

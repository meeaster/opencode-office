# design

An `office` package: the office runs its own [Doop](https://github.com/kgoedecke/doop), a design canvas that people and agents edit together live, and every session reaches it as the `doop` MCP server. People open the canvas in the browser; agents design on it through MCP, and the result is the same canvas for both.

## Install

It is built into `office`. In `office.yaml`:

```yaml
packages:
  - name: design
```

Then run `office sync` and commit what it wrote: the package in `.office/packages/design/`, which updates with `office` and is read-only there, and `.opencode/doop/.gitignore`. Run `office up`, which builds Doop's image (the first build takes a few minutes), generates its secrets and starts Doop and its database. Doop opens at `http://localhost:41441`.

| Setting | |
|---|---|
| `port` | The loopback port Doop is published on; `41441` by default. Doop listens on the same port inside its container. This setting is authoritative: shell `DOOP_PORT` does not override it |
| `url` | The exact address the browser opens, when a reverse proxy such as a Tailscale Service fronts Doop, such as `https://doop.<tailnet>.ts.net`, without a trailing slash. Empty by default, for `http://localhost:<port>`, or `http://doop.localhost:<port>` with the Executor app's sign-in (see "One address for the browser and Executor"). Doop builds sign-in and every link it hands out on this address, so use exactly it |
| `executor_app` | Whether sessions reach Doop through the `doop` Executor app instead of the `doop` MCP server and the agent key file; `false` by default. See "Connecting through Executor instead" |
| `oauth` | Whether the Executor app offers signing in to Doop beside the agent key; `true` by default, and only read with `executor_app`. `false` offers the agent key alone |

A change to any of them reaches sessions (their connection, and the address the skill gives them) when `office sync` writes the resolved settings, without restarting OpenCode. Run `office up` afterward to apply it to Doop too. If MCP tried the new address before Doop started listening there, reconnect `doop` in OpenCode's `/mcps` menu.

## Connecting sessions, once

Sessions sign in to Doop with an agent key, which acts as the account that created it: the same canvases and access, and edits attributed to that account. Doop only mints keys for a signed-in account, so a person does this once per office:

1. Open Doop and sign up. Without email configured, Doop signs up without verification; the account is yours.
2. Under **Settings → Agent keys**, create a key, named after the office.
3. Save it from the office root, without it passing through a shell history or a chat:

   ```sh
   (umask 077; read -rs key && printf '%s\n' "$key" > .opencode/doop/agent-key)
   ```

Sessions get the `doop` tools within seconds: the plugin watches `.opencode/doop/` and has OpenCode load its MCP servers again when the key is saved, replaced or deleted. `.opencode/doop/` ignores everything in it but its `.gitignore`, so the key is never committed. To cut sessions off, revoke the key in Doop's settings, which takes effect at once, and delete the file.

The plugin reads the key whenever OpenCode loads its MCP servers. From the office's container (`OFFICE_CONTAINER=1`) it connects to `http://doop:<port>/mcp` on the compose network; an OpenCode server on the host, in host mode or opened in a container-mode office, connects to `http://localhost:<port>/mcp`.

Doop's browser sign-in for MCP clients (OAuth) isn't used here: OpenCode would have to reach the address Doop advertises from wherever it runs. The Executor app below offers it.

## Connecting through Executor instead (prototype)

With `executor_app: true`, sessions reach Doop through the package's `doop` Executor app rather than the `doop` MCP server: the plugin stops registering the server (even if a key file is there), so the tools aren't offered twice, and the skill tells agents to find the tools with `office-executor`. The app proxies Doop's own MCP tools, with Doop's server instructions, and asks for approval before the tools Doop marks destructive, such as `delete_frame`. It has one Doop account linked for everyone (an app-scope account), so every desk designs as the person who connected it, and no key lands in the office folder.

```yaml
packages:
  - name: design
    settings:
      executor_app: true
```

Out of the box this offers two ways to connect, **Sign in with Doop** (OAuth) and **Agent key**, and Doop opens at `http://doop.localhost:<port>` (below). With `oauth: false` the app offers only the agent key and Doop stays at `http://localhost:<port>`.

1. `office sync`, `office up` (which restarts Doop at its new address), then `office apps deploy`. An office that ran Doop before the package's compose file gained the alias and address rule keeps running its applied copy: `office up` says the file changed, and `office up --upgrade` applies it, after backing up Doop's volumes. Until then Doop isn't at `http://doop.localhost:<port>`. Deploy prints a link to Executor's connect page while the app has no Doop account.
2. The person whose Doop account it is opens Doop and signs in (or signs up), in the browser they'll open the link in. Do this first; see "Signing in" below.
3. They open the link, signed in to Executor, and choose:
   - **Sign in with Doop**: Doop authorizes at once and Executor saves the account, with no key to copy.
   - **Agent key**: they create one in Doop under **Settings → Agent keys** and enter it in Executor's form. The app's account check connects to Doop's MCP server with it and without it, so a refused key shows in Executor.
4. Sessions in every desk find the tools with `office-executor`'s `search` (namespace `doop`). An agent can also request a new connect link itself, as Executor's `code-mode` skill describes.

Executor runs in the office's compose project in either mode. The app sends agent keys to Doop at `http://doop:<port>/mcp` and OAuth tokens to Doop's advertised address; those are the hosts an account's credential may go to. Changing `port` means connecting the account again: an account keeps the hosts it was connected with.

### One address for the browser and Executor

Executor discovers Doop's OAuth server, registers a client, and exchanges the code from its own container, and Doop advertises its `BETTER_AUTH_URL` as the issuer and every endpoint, whatever address it was reached at. At `http://localhost:<port>` those requests would reach Executor itself. So the package picks one address that works from both sides, by one rule in `compose.yaml` (which sets `BETTER_AUTH_URL` when Doop starts), the plugin (the address the skill gives agents) and the app (`executor-app/address.ts`):

| Settings | Doop's address |
|---|---|
| `url` set | `url`, as before |
| `executor_app` and `oauth` on, no `url` | `http://doop.localhost:<port>` |
| otherwise, including every office without the Executor app | `http://localhost:<port>`, as before |

Browsers resolve every `*.localhost` name to loopback, the published port, and `compose.yaml` gives the `doop` service the alias `doop.localhost` on the compose network, so Executor reaches the same name. Doop's own Chromium, which renders screenshots from that address, resolves it to itself. With an explicit `url`, OAuth works only if Executor's container also reaches that name; an HTTPS address behind a reverse proxy, such as a Tailscale Service, isn't tested.

Signing in to Doop at `http://localhost:<port>` still works, but OAuth sign-in uses the session at the advertised address, so sign in there.

### Signing in

Doop v0.15.0's sign-in page doesn't return to an OAuth sign-in that started while the person was signed out: after the password sign-in it stays on the sign-in page, and reloading shows their canvases. The sequence that works:

- Sign in to Doop at its address first, then choose **Sign in with Doop** in Executor: Doop authorizes at once.
- If they started signed out, sign in when Doop asks, then open the same connect link again and choose **Sign in with Doop** again. The request is still pending, and Doop now authorizes at once.

### Changing settings

Turning `oauth` on or off, or changing `url` while it's on, changes the app's provider, so the account must be connected again; the next `office apps deploy` prints a new link. Those changes, and turning `executor_app` on or off with `oauth` on, move Doop's address: run `office up`, and sign in to Doop at the new address.

Turning `executor_app` off brings the key file and the `doop` MCP server back. It doesn't remove the app or its account from Executor; delete them in Executor's dashboard if they're no longer wanted.

## What it holds

| Path | |
|---|---|
| `compose.yaml` | The `doop` and `doop-db` services, the `doop-pg` database volume and the `doop-assets` volume for uploaded images, fonts and previews, added to the office's compose project (see "Services" in the `office` README). Doop publishes no image, so `doop` builds upstream's Dockerfile from the commit of the release it pins, v0.15.0; `doop-db` is Postgres 16, the version upstream runs, pinned by digest. Doop runs with ChatGPT subscription sign-in off (`CHATGPT_CONNECT_DISABLED`); people connect model API keys in its settings instead. `doop` answers to the alias `doop.localhost` on the compose network, and its command sets `BETTER_AUTH_URL` by the address rule above before running upstream's own |
| `package.yaml` | The settings above and the secrets `office up` generates once into the state folder's `packages/design.env`: `DOOP_BETTER_AUTH_SECRET` (signs sessions), `DOOP_SECRETS_ENCRYPTION_KEYS` (encrypts the model keys and tokens people connect) and `DOOP_DB_PASSWORD` (Postgres; set only when the database is created, so deleting its line breaks the connection rather than rotating it) |
| `executor-app/` | The `doop` Executor app `office apps deploy` deploys while `executor_app` is on: `address.ts` holds the address rule, `doop.ts` declares the Doop provider (agent key, and OAuth when `oauth` is on) with an MCP health check, `index.ts` proxies Doop's MCP tools with approval for destructive ones, and `package.ts` holds the settings' defaults, which deploy replaces with the office's |
| `plugin/index.ts` | The OpenCode plugin, which `office sync` links as `.opencode/plugins/design`. It registers the `doop` MCP server when the key file exists and `executor_app` is off, reloads MCP when the key changes, and reloads MCP and the skill below when resolved settings change. Its directory watchers close when the plugin unloads |
| `skills/doop/` | The skill every session gets: when to use Doop, to load Doop's own guide first, where the user opens the canvas, and what to tell the user when the office isn't connected yet |
| `template/.opencode/doop/.gitignore` | Copied once into the office: keeps the agent key out of git |

## Upgrading Doop

The release is pinned in `compose.yaml`, so a new `office` with a newer Doop changes it in `.office/packages/design/` on `office sync`. `office up` keeps running the applied copy until `office up --upgrade`, which stops Doop, backs up `doop-pg` and `doop-assets` to the state folder's `backups/`, builds the new release and starts it; Doop migrates its database when it starts.

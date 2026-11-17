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
| `url` | The exact address the browser opens, when a reverse proxy such as a Tailscale Service fronts Doop, such as `https://doop.<tailnet>.ts.net`, without a trailing slash. Empty by default, for `http://localhost:<port>`. Doop builds sign-in and every link it hands out on this address, so use exactly it |

A change to either reaches sessions (their connection, and the address the skill gives them) when `office sync` writes the resolved settings, without restarting OpenCode. Run `office up` afterward to apply it to Doop too. If MCP tried the new address before Doop started listening there, reconnect `doop` in OpenCode's `/mcps` menu.

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

Doop's browser sign-in for MCP clients (OAuth) isn't used: from the container it can't work, because Doop names the browser's address as its authorization server.

## What it holds

| Path | |
|---|---|
| `compose.yaml` | The `doop` and `doop-db` services, the `doop-pg` database volume and the `doop-assets` volume for uploaded images, fonts and previews, added to the office's compose project (see "Services" in the `office` README). Doop publishes no image, so `doop` builds upstream's Dockerfile from the commit of the release it pins, v0.15.0; `doop-db` is Postgres 16, the version upstream runs, pinned by digest. Doop runs with ChatGPT subscription sign-in off (`CHATGPT_CONNECT_DISABLED`); people connect model API keys in its settings instead |
| `package.yaml` | The settings above and the secrets `office up` generates once into the state folder's `packages/design.env`: `DOOP_BETTER_AUTH_SECRET` (signs sessions), `DOOP_SECRETS_ENCRYPTION_KEYS` (encrypts the model keys and tokens people connect) and `DOOP_DB_PASSWORD` (Postgres; set only when the database is created, so deleting its line breaks the connection rather than rotating it) |
| `plugin/index.ts` | The OpenCode plugin, which `office sync` links as `.opencode/plugins/design`. It registers the `doop` MCP server when the key file exists, reloads MCP when the key changes, and reloads MCP and the skill below when resolved settings change. Its directory watchers close when the plugin unloads |
| `skills/doop/` | The skill every session gets: when to use Doop, to load Doop's own guide first, where the user opens the canvas, and what to tell the user when the office isn't connected yet |
| `template/.opencode/doop/.gitignore` | Copied once into the office: keeps the agent key out of git |

## Upgrading Doop

The release is pinned in `compose.yaml`, so a new `office` with a newer Doop changes it in `.office/packages/design/` on `office sync`. `office up` keeps running the applied copy until `office up --upgrade`, which stops Doop, backs up `doop-pg` and `doop-assets` to the state folder's `backups/`, builds the new release and starts it; Doop migrates its database when it starts.

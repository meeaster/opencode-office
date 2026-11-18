# opencode-office

## Design decisions

- A brainstorm is a design session: explain the user-visible tradeoff and recommend an option. Wait for the user to choose before building; delegation needs approval for that piece of work.
- Build office-specific integrations in the consuming office. Offices can share packages without making them built-ins. The required `office` package owns workspace guidance and OpenCode tooling; other capabilities are opt-in. A desk need not have a repo or Executor app.
- `template/` is copied once. Put guidance every office should receive on update in the required package’s plugin; put owner-selected settings in `office.yaml`. If an existing office needs a template change, call out the adoption step.
- Only OpenCode has a host/container mode. Host mode uses an existing server that `office` never starts or stops; container mode adds a server without precluding work from the host. Executor and office services run in containers in either mode. Agents are deliberately unrestricted: the container or the host server's own configuration supplies the boundary. Add agent permission rules only on request.
- Bind published ports to loopback. The office's services share its Executor key; keep other service credentials in Executor. This is a public repository: use portable examples without personal paths, identities or credentials.

## Verification and adoption

- Release CI typechecks and builds but does not run tests. Run `pnpm run typecheck` and `pnpm test` locally. For one suite, run e.g. `bun test ./src/machine.test.ts` or `bun test ./packages/browser/test` **from the repo root** so `bunfig.toml` preloads the machine-isolation fixture. Launcher tests need host `jq`.
- `bin/office` runs checkout sources; it cannot prove assets made it into the executable. For runtime changes, `pnpm run install-office`, then `office init` and `office check` in a scratch folder outside the repo. In a running container-mode office, rebuild with `office up` after CLI or image changes, then `office check` to compare host and container versions.
- For manual host-mode checks, use a host OpenCode server, scratch `state:` and separate ports. Redirect `OFFICE_MACHINE_RECORD`, `OFFICE_MISE_CONFIG_DIR` **and** `OFFICE_MACHINE_DIR` into scratch; panel installs also need `OFFICE_APP_CONFIG_DIR` and `OFFICE_APP_PANELS_DIR`. The Bun test preload does not protect manual runs.
- A built-in package change reaches an office through a new executable and `office sync`; commit the synced files in that office when adoption is requested. Edit package sources, not the read-only copies under `.office/packages/`.

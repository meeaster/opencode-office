---
name: office-package-creator
description: Create or extend an office package in packages/ and verify what it provides in the consuming office.
---

# Create an office package

Build in the office that needs the capability. Local sources live under `packages/<name>/` beside `office.yaml`; `.office/packages/` holds installed copies that sync restores. Choose a name distinct from a built-in and from the reserved names `machine`, `mise` and `config`.

## A package that teaches a desk skill

For example, an office that wants agents to prepare release notes could select a package called `releases`:

```text
packages/releases/
  office.ts
  skills/draft-release-notes/SKILL.md
  plugin/index.ts
```

1. Write `office.ts` with `export default { name: "releases", description: "Draft release notes from merged changes" }`. Office reads the plain object, including during `check`; use relative imports for private modules. Publish a contract at `exports/<module>.ts`; consumers import `@office/<selected-package>/<module>` at module scope. Existing `package.yaml` files support static declarations. Use one definition per package. The package name is what the office selects; `draft-release-notes` is what the agent invokes.
2. Write the skill with `name: draft-release-notes`, a one-line `description` saying when to use it, and the instructions. Use the `opencode-plugin` skill to implement its registration: from `setup(ctx)`, register a `ctx.skill.transform` that reads the skill and adds its ID, name, description, absolute `SKILL.md` path and body. Resolve the package directory from the **real** plugin directory because OpenCode loads it through a symlink. This makes references beside `SKILL.md` work from any desk.
3. Append `- name: releases` to `packages:` in `office.yaml` and run `office sync` from the office. Sync links the plugin for all desks; no `skills.enabled` or OpenCode config entry is needed.
4. Run `office check`, then use the capability from a fresh desk session: load `draft-release-notes` and try it on a merged change. A file on disk proves neither registration nor usable instructions. If the runtime is unavailable, report which part you actually verified.

## Choose files by who owns them

- **The package maintains it:** keep instructions, reference files and scripts inside the package. Ship scripts ready to run; sync doesn't install their dependencies.
- **The package adds an `office` command:** import its handler in `office.ts`; register `ctx.command({ name: "releases list", summary, run })` in `setup`. Read settings from `ctx.settings` and put the action inside `run`. After `office sync --packages`, verify the route in `office --help` and invoke it. Handler-body edits are live; settings, names and aliases need sync. The installed `references/office.ts` is a working example.
- **The package supplies a reference checkout:** import `repositories` from `@office/references/repositories` at module scope. Call `ctx.add(repositories, { name, url, ref, description })`; `ref` and `description` are optional. Gate it on `ctx.booleanSetting("source_reference", { default: true, description: "Include the source checkout" })` if the owner may already declare the same name. Verify `office sync --packages`, `office references list`, then `office sync --references`. The installed `references` package shows how to define and read another collection without a CLI change.
- **The office customizes it:** put a starter file (a seed) under `seed/` at its intended office-relative path, never under `.office/`. Sync seeds it once; later syncs preserve the office's edits and deletions. For this feature, exercise a second sync after editing the seeded file.
- **The office configures it:** declare each `settings` key with a description and a default or `required: true`. For structured values use `settings_schema` instead. The office supplies overrides on its package entry; the plugin reads resolved values from the package's `.settings.json` inside its hook or transform.
- **The package schedules a script:** add `registerCron(ctx: CronContext)` to the `office.ts` default export. Import `CronContext` with `import type` from the required package's `package-context.ts`. Call `ctx.cron.job("digest", { schedule: "@daily", script: "scripts/digest.sh" })`; ship a regular package-relative `.sh` file. Return synchronously and put the work in the script. For a conditional job, omit the call when no override needs that name, or pass `false` instead of the definition to keep an override valid in other modes. The hook sees current `ctx.settings` and `ctx.cron.mode`; `setup` registers collections and commands. Use the installed `office/office.ts` as an example. Verify the qualified ID with `office cron list`, then run it in a scratch office.
- **The package needs a CLI:** write `import { requirements } from "@office/tooling/requirements"` and, in `setup(ctx)`, call `ctx.add(requirements, { name: "npm:agent-browser", minimumVersion: "0.43.0" })`. Add `hostOnly: true` for a host tool. Multiple packages may need a tool; sync adopts the highest floor unless the adopted pin is already newer. `machine.toml` overrides it. Check the pins and claimants in `machine.packages.toml`.
- **The package exports a mise task:** import `tasks` from `@office/mise-integration/claims`; `ctx.add(tasks, { name: "audit", description: "Audit the workspace", script: "scripts/audit.sh" })` gives `mise run <package>:audit`. Run it outside the scratch office through its machine link. No tool claim is needed.
- **The package installs something once on the host:** add to `installs` from the same contract. `destination` owns the installation; `ready` names the executable or regular-file marker (`executable: false`). Setup registers the package-relative script; the postinstall hook runs it only when missing. For a default-off system bootstrap, see `browser/office.ts`. Supported native sections are `bootstrap.packages`, `bootstrap.files` and `bootstrap.directories`. Each path has one owner; present directories may contain managed children. Unconditional present files also supply readiness checks; absent, OS-filtered and `remove_empty` targets do not. List additional positive checks in `ready`. Different specs for one native package conflict; side effects of scripts are not inferred. Only `office setup` offers application.
- **The package needs an Executor app:** put it in `executor-app/` and declare `executor_app` in the package definition, optionally gated on a boolean setting. `office apps deploy` deploys it under the package's namespace with a generated `package.ts` of resolved settings; the installed `design` package's `executor-app/` and README show the shape.
- **The package's services create Docker resources themselves** (a service with the Docker socket mounted starts containers, networks or volumes outside the compose project): have them label what they create and declare it as `spawns: { label: <key>=<value> }`, the value naming `${OFFICE_NAME}` once and the package's namespace, such as `floci_namespace=office-${OFFICE_NAME}-floci`. `office down` then removes the labelled containers and networks and keeps the volumes; the installed `aws-emulator` package shows the shape.
- **The package adds a desktop panel:** use `opencode-plugin` for `gui/`, the committed bundle, and verification in the desktop app.

To share the result, keep the same package layout in a repository. Another office selects it with `name`, `repo`, `path` and `ref` under `packages:`; pin a tag or full commit SHA and sync there.

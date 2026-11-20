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

1. Write `office.ts` with `export default { name: "releases", description: "Draft release notes from merged changes" }`. Office reads the plain object, including during `check`; ship any imports as package-relative modules. An existing `package.yaml` accepts the same fields. Use one definition per package. The package name is what the office selects; `draft-release-notes` is what the agent invokes.
2. Write the skill with `name: draft-release-notes`, a one-line `description` saying when to use it, and the instructions. Use the `opencode-plugin` skill to implement its registration: from `setup(ctx)`, register a `ctx.skill.transform` that reads the skill and adds its ID, name, description, absolute `SKILL.md` path and body. Resolve the package directory from the **real** plugin directory because OpenCode loads it through a symlink. This makes references beside `SKILL.md` work from any desk.
3. Append `- name: releases` to `packages:` in `office.yaml` and run `office sync` from the office. Sync links the plugin for all desks; no `skills.enabled` or OpenCode config entry is needed.
4. Run `office check`, then use the capability from a fresh desk session: load `draft-release-notes` and try it on a merged change. A file on disk proves neither registration nor usable instructions. If the runtime is unavailable, report which part you actually verified.

## Choose files by who owns them

- **The package maintains it:** keep instructions, reference files and scripts inside the package. Ship scripts ready to run; sync doesn't install their dependencies.
- **The package supplies a reference checkout:** in the default export's `setup({ add, settings })`, call `add({ registry: "references.repository", value: { name, url, ref, description } })`; `ref` and `description` are optional. Gate it on a package setting if the owner may already declare the same name. Verify `office sync --packages`, `office references list`, then `office sync --references`. `plugin/index.ts` is for OpenCode hooks, not checkout registration.
- **The office customizes it:** put a starter file under `template/` at its intended office-relative path. Sync seeds it once; later syncs preserve the office's edits and deletions. For this feature, exercise a second sync after editing the seeded file.
- **The office configures it:** declare each `settings` key with a description and a default or `required: true`. For structured values use `settings_schema` instead. The office supplies overrides on its package entry; the plugin reads resolved values from the package's `.settings.json` inside its hook or transform.
- **The package needs a CLI or scheduled job:** declare `tools` at the exact mise versions you tested with (`office sync` adds them to the office's `machine.packages.toml` at that version, raises a lower one to it, and otherwise leaves the office's newer version alone), or `cron` jobs with a schedule and package-relative script. For host-only tools and installation see the installed browser package's `package.yaml` when available; machine bootstrap belongs under opt-in `system`.
- **The package needs an Executor app:** put it in `executor-app/` and declare `executor_app` in the package definition, optionally gated on a boolean setting. `office apps deploy` deploys it under the package's namespace with a generated `package.ts` of resolved settings; the installed `design` package's `executor-app/` and README show the shape.
- **The package's services create Docker resources themselves** (a service with the Docker socket mounted starts containers, networks or volumes outside the compose project): have them label what they create and declare it as `spawns: { label: <key>=<value> }`, the value naming `${OFFICE_NAME}` once and the package's namespace, such as `floci_namespace=office-${OFFICE_NAME}-floci`. `office down` then removes the labelled containers and networks and keeps the volumes; the installed `aws-emulator` package shows the shape.
- **The package adds a desktop panel:** use `opencode-plugin` for `gui/`, the committed bundle, and verification in the desktop app.

To share the result, keep the same package layout in a repository. Another office selects it with `name`, `repo`, `path` and `ref` under `packages:`; pin a tag or full commit SHA and sync there.

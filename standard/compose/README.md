# Package services in the Office Compose project

[`services.ts`](services.ts) owns the native package-service planner linked into `office`. An author still places `compose.yaml` beside `office.ts` or `package.yaml`. Both readers resolve settings and package provenance before the CLI calls the same planner. An office's own `compose.yaml` remains its final override.

The planner is an internal interface for callers holding **validated selections and resolved directories**. It is not a reader of untrusted package definitions. For example, the workflow can plan a change without starting Docker or reading a secret:

```ts
const plan = prepareServices(
  { name: "studio", state: "/state" },
  [{ name: "gallery", namespace: "preview", dir: "/workspace/packages/gallery", settings: { port: 8787 } }],
  new Set(["gallery", "unreadable"]), // selected, even if a definition couldn't be read
  upgrade,
);
// First stop/back up plan.upgraded using the old project. Only after success:
const { includes, dropped } = plan.applyDefinitions(environmentPath);
// For each readable package, the CLI prepares its env file, then calls its include writer if active.
includes.get("gallery")?.();
// The workflow sweeps dropped spawn labels around ordinary Compose reconciliation.
```

The plan reads the desired native files and the existing `<state>/packages/<name>/` records. It validates names and ports, chooses which definitions to replace, and identifies backup subjects from the *old* files. Applying a plan maintains those records, includes, scalar settings and labels in their existing format. Includes keep the package directory as `project_directory`; they point to `environmentPath(name)` without obtaining its values. `serviceFiles`, `serviceSettings` and `appliedSpawns` work from applied records alone. None of these observations is a probe of running containers.

**Delivery boundary:** `standard/compose/` is source ownership, statically linked at build time. It is outside `packages/` because every folder there is a selectable built-in name used by discovery and collision checks. This change neither reserves `compose` nor installs an empty entrypoint. Its shared YAML/schema, error and reporting imports are compiled dependencies, never imports in a materialized external TS file. A future selectable or registered owner would need an explicit source/adoption policy and a deliverable entrypoint; no current command depends on that work.

The CLI adapter (`src/package-services.ts`) owns discovery handoff and generated secrets, including packages without Compose. The CLI workflow still sequences backup, build, Docker calls, spawn sweeps, runtime pin/data migrations, host units and probes. The adapter keeps the existing call sites and the split between planning and applying: a failed backup must precede **all** applied writes. Applying files has the same filesystem failure semantics as before; it is not a transaction over Docker and disk.

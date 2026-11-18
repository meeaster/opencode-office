# Release workflows

Every push to `main` publishes a pre-release consumed by `office update`. Change the tag pattern, platform asset names, checksum manifest or target commit only in step with `src/commands/update.ts`. Pin actions by full commit SHA with the version in a comment, scope permissions per job, and check workflow changes with `actionlint` and `zizmor --min-severity high`.

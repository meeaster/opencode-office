#!/bin/sh
# Bumps the exact pins in the office's own mise.toml files (the root's and each desk's) to the
# newest versions released at least a day ago, installs them and commits the change as the
# office's git identity (office.yaml's `git`), else "office cron". It skips files with uncommitted changes and notifies the first desk's app.
set -eu
exec office upgrade-tools

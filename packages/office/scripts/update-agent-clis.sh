#!/bin/sh
# Update the managed host's native CLIs through the office's narrow service operation.
set -eu
exec "${OFFICE_CRON_COMMAND:-office}" --office "$PWD" host-agent-cli-update

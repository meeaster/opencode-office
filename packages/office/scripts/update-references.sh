#!/bin/sh
set -eu
exec "${OFFICE_CRON_COMMAND:-office}" --office "$PWD" sync --references

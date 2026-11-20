#!/bin/sh
set -eu
exec "${OFFICE_CRON_COMMAND:-office}" --office "$PWD" upgrade-tools --commit

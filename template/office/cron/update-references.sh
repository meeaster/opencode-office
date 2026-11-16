#!/bin/sh
# Fetches the newest commit of each reference office.yaml declares.
set -eu
exec office sync --references

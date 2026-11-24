#!/usr/bin/env bash
# Run with a compiled office binary. docker compose config renders locally; office up's
# Docker executable is a stop stub. Neither can contact a daemon.
set -euo pipefail
exe=$(realpath "$1")
base=$(mktemp -d)
trap 'rm -rf "$base"' EXIT
export HOME=$base/home XDG_RUNTIME_DIR=$base/run XDG_CONFIG_HOME=$base/config XDG_DATA_HOME=$base/data XDG_STATE_HOME=$base/xdg-state XDG_CACHE_HOME=$base/cache
export OFFICE_MACHINE_RECORD=$base/record OFFICE_MISE_CONFIG_DIR=$base/mise OFFICE_MACHINE_DIR=$base/machine
export OFFICE_APP_CONFIG_DIR=$base/app OFFICE_APP_PANELS_DIR=$base/panels OFFICE_SYSTEMD_USER_DIR=$base/units
export DOCKER_HOST=unix://$base/no-socket DBUS_SESSION_BUS_ADDRESS=unix:path=$base/no-bus GIT_ALLOW_PROTOCOL=file
unset OFFICE_CONTAINER FLOCI_PORT FLOCI_UI_PORT FLOCI_STORAGE
mkdir -m 700 "$HOME" "$XDG_RUNTIME_DIR" "$base/bin"
docker=$(command -v docker)
printf '#!/bin/sh\necho "offline Docker stop" >&2\nexit 1\n' > "$base/bin/docker"
chmod +x "$base/bin/docker"
export PATH="$base/bin:$PATH"
"$exe" init "$base/work" >/dev/null
cd "$base/work"
config() {
  cat > office.yaml <<EOF
name: exercise
state: $base/state
references: [{name: manual, url: owner}]
packages: [{name: aws-emulator, settings: {$1}}]
EOF
}
applied=$base/state/packages/aws-emulator
snapshot=.office/runtime/settings.json
applied_settings() { "$exe" settings get aws-emulator --office "$base/work"; }
observe() {
  "$exe" sync --packages >/dev/null
  if "$exe" up > "$base/up.log" 2>&1; then exit 1; fi
  grep -q 'offline Docker stop' "$base/up.log"
  cmp .office/packages/aws-emulator/compose.yaml "$applied/compose.yaml"
  cat "$applied/settings.env"
  OFFICE_NAME=exercise "$docker" compose -p example -f "$applied/include.yaml" config --format json > "$base/rendered"
  jq -e --arg p "$1" --arg ui "$2" --arg storage "$3" '
    .services.floci as $f | .services["floci-ui"] as $u |
    $f.ports[0].host_ip=="127.0.0.1" and $f.ports[0].published==$p and
    ($f.ports[0].target|tostring)==$p and $u.ports[0].published==$ui and
    $u.ports[0].target==4500 and $u.ports[0].host_ip=="127.0.0.1" and
    $f.environment.FLOCI_BASE_URL==("http://localhost.floci.io:"+$p) and
    $u.environment.FLOCI_ENDPOINT==("http://floci:"+$p) and $f.environment.FLOCI_STORAGE_MODE==$storage' "$base/rendered"
}
config ''
observe 4566 4500 memory
"$exe" references list | grep '^floci.*package aws-emulator$'
config 'port: 14566, ui_port: 14500, storage: hybrid, source_reference: false'
observe 14566 14500 hybrid
applied_settings | jq -e '.port==14566 and .ui_port==14500 and .storage=="hybrid"'
if [ -e .office/packages/aws-emulator/.settings.json ]; then exit 1; fi
"$exe" references list > "$base/list"
grep '^manual.*office.yaml' "$base/list"
if grep -q '^floci' "$base/list"; then exit 1; fi
cp "$snapshot" "$base/good"
cp "$applied/settings.env" "$base/env.good"
for invalid in 'port: "14566"' 'storage: custom-mode' 'port: []' 'ui_port: {}' 'storage: null' 'storage: "can'\''t"' 'source_reference: "true"'; do
  config "$invalid"
  if "$exe" sync --packages > "$base/log" 2>&1; then exit 1; fi
  grep "FAILED package aws-emulator:.*${invalid%%:*}" "$base/log"
  if "$exe" up > "$base/up.log" 2>&1; then exit 1; fi
  cmp "$base/good" "$snapshot"
  cmp "$base/env.good" "$applied/settings.env"
done
config 'storage: persistent'
observe 4566 4500 persistent
"$exe" references list | grep '^floci.*package aws-emulator$'

# Before the next sync, up uses the current selection; plugin delivery stays published.
config 'port: 24566, storage: wal'
if "$exe" up > "$base/up.log" 2>&1; then exit 1; fi
grep -q 'offline Docker stop' "$base/up.log"
OFFICE_NAME=exercise "$docker" compose -p example -f "$applied/include.yaml" config --format json |
  jq -e '.services.floci.ports[0].published=="24566" and .services.floci.environment.FLOCI_STORAGE_MODE=="wal"'
applied_settings | jq -e '.port==4566 and .storage=="persistent"'

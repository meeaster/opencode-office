#!/usr/bin/env bash
# Proves agent-browser launches the browser the office chose: office setup runs it after the
# system setup and the tools are in place, in a fresh shell that has sourced only the office's
# environment file, so neither an older daemon nor the calling shell's variables decide.
#
# It opens a page headless in a session of its own (a new agent-browser daemon, which takes this
# environment), reads the page back, and finds the browser process by the temporary profile
# agent-browser made under this run's own TMPDIR: it must have been started as
# AGENT_BROWSER_EXECUTABLE_PATH. Nothing is installed or left behind.
set -euo pipefail

want=${AGENT_BROWSER_EXECUTABLE_PATH:?the office environment file sets no AGENT_BROWSER_EXECUTABLE_PATH}
agent_browser=$(command -v agent-browser) || { echo "agent-browser isn't on the office environment's PATH (office up installs it)" >&2; exit 1; }
session="office-verify-$$"
title="office system chrome"
TMPDIR=$(mktemp -d)
export TMPDIR

finish() {
  timeout 30 "$agent_browser" --session "$session" close >/dev/null 2>&1 || true
  rm -rf "$TMPDIR"
}
trap finish EXIT

[ -x "$want" ] || { echo "$want, which AGENT_BROWSER_EXECUTABLE_PATH names, isn't an executable file" >&2; exit 1; }

timeout 120 "$agent_browser" --session "$session" open "data:text/html,<title>$title</title>" >/dev/null
read_title=$(timeout 60 "$agent_browser" --session "$session" get title)

if [ "$read_title" != "$title" ]; then
  echo "agent-browser opened the page but read back \"$read_title\"" >&2
  exit 1
fi

launched=""

for pid in $(pgrep -f -- "--user-data-dir=$TMPDIR/agent-browser-chrome-" || true); do
  args=$(tr '\0' '\n' <"/proc/$pid/cmdline" 2>/dev/null) || continue

  case "$args" in *--type=*) continue ;; esac

  launched=$(printf '%s\n' "$args" | head -n 1)
  headless=$(printf '%s\n' "$args" | grep -c -- '^--headless' || true)
done

if [ "$launched" != "$want" ]; then
  echo "agent-browser's browser was started as ${launched:-nothing found}, not $want" >&2
  exit 1
fi

if [ "$headless" = 0 ]; then
  echo "agent-browser started $want without --headless" >&2
  exit 1
fi

version=$("$want" --version)
echo "agent-browser launched $want (${version%% }) headless with a temporary profile, and read the page back"

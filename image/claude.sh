#!/bin/sh
# The real binary lives outside PATH, so direct CLI and OpenCode use the same adapter.
set -eu
real=/usr/local/lib/office/claude
if [ "${OFFICE_CLAUDE_GATEWAY:-}" != 1 ]; then
  exec "$real" "$@"
fi
file=/run/office-claude/gateway.json
if ! credential=$(cat "$file" 2>/dev/null); then
  echo "office: selected Claude gateway credential is missing; run office up on the host" >&2
  exit 1
fi
# jq validates before exporting anything. Errors never echo the credential.
if ! printf '%s' "$credential" | jq -e '
  type == "object" and
  (.token | type == "string" and test("^\\S+$")) and
  (.baseUrl | type == "string" and test("^https?://"))
' >/dev/null 2>&1; then
  echo "office: selected Claude gateway credential is missing or malformed; run office up on the host" >&2
  exit 1
fi
ANTHROPIC_AUTH_TOKEN=$(printf '%s' "$credential" | jq -r '.token')
ANTHROPIC_BASE_URL=$(printf '%s' "$credential" | jq -r '.baseUrl')
export ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL
# Avoid an ambient subscription/API-key source competing with the selected gateway.
unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN
sonnet=$(printf '%s' "$credential" | jq -r '.models.sonnet // empty')
opus=$(printf '%s' "$credential" | jq -r '.models.opus // empty')
haiku=$(printf '%s' "$credential" | jq -r '.models.haiku // empty')
if [ -n "$sonnet" ]; then export ANTHROPIC_DEFAULT_SONNET_MODEL="$sonnet"; fi
if [ -n "$opus" ]; then export ANTHROPIC_DEFAULT_OPUS_MODEL="$opus"; fi
if [ -n "$haiku" ]; then export ANTHROPIC_DEFAULT_HAIKU_MODEL="$haiku"; fi
exec "$real" "$@"

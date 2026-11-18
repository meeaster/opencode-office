#!/usr/bin/env bash
# Adds Google's apt repository for Google Chrome Stable before mise installs it: the browser
# package's system setup (its system_chrome setting), run as the setup's pre-packages hook when
# office setup applies it.
#
# It writes the source exactly where and as Chrome's own package does, so Chrome takes it over
# instead of adding a second one: /etc/apt/sources.list.d/google-chrome.sources, signed by
# /usr/share/keyrings/google-chrome.gpg, which Chrome's postinst and daily cron job rewrite with
# the keys Google ships from then on. The first key comes over HTTPS with the distribution's CA
# certificates, and is used only when its primary key's fingerprint is Google's Linux package
# signing key. An older google-chrome.list for the same repository (Chrome's own, or one added by
# hand as this machine's earlier setup did) is retired as Chrome's postinst retires it, with its
# keyring when no source names that any more. Anything else in apt's sources is left alone.
#
# Run as the user; it uses sudo only for a change, and changes nothing when the source is in place.
# With --check it only says what a run would change (office setup asks it first).
set -euo pipefail

fingerprint=EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796
key_url=https://dl.google.com/linux/linux_signing_key.pub
keyring=/usr/share/keyrings/google-chrome.gpg
sources_dir=/etc/apt/sources.list.d
sources=$sources_dir/google-chrome.sources
legacy=$sources_dir/google-chrome.list
legacy_keyring=/etc/apt/keyrings/google-chrome.gpg
# Chrome's own pattern for its legacy line, from its postinst.
legacy_line='deb (\[arch=[^]]*\bamd64\b[^]]*\][[:space:]]*) https?://dl.google.com/linux/chrome/deb/ stable main'
ca_bundle=/etc/ssl/certs/ca-certificates.crt

say() { printf 'google-chrome apt source: %s\n' "$*" >&2; }

as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

if ! command -v apt-get >/dev/null 2>&1 || [ "$(dpkg --print-architecture)" != amd64 ]; then
  say "Google Chrome's apt repository is for amd64 Debian and Ubuntu machines only"
  exit 1
fi

changed=false

# The source Chrome writes, byte for byte, so its postinst's rewrite changes nothing.
chrome_sources() {
  cat <<EOF
### THIS FILE IS AUTOMATICALLY CONFIGURED ###
# Changes to this file will not be preserved.
# This file will not be recreated if removed.
X-Repolib-Name: Google Chrome
Types: deb
URIs: https://dl.google.com/linux/chrome-stable/deb/
Suites: stable
Components: main
Architectures: amd64
Signed-By: $keyring
EOF
}

installed() {
  dpkg-query -W -f='${db:Status-Status}' "$1" 2>/dev/null | grep -qx installed
}

fetch_key() {
  local missing=()

  for package in ca-certificates curl gnupg; do installed "$package" || missing+=("$package"); done

  if [ "${#missing[@]}" -gt 0 ]; then
    say "installing ${missing[*]} from the distribution, to fetch and check Google's key"
    as_root apt-get update
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install --yes "${missing[@]}"
  fi

  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT

  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --cacert "$ca_bundle" "$key_url" --output "$work/key.asc"

  local found
  found=$(GNUPGHOME="$work" gpg --batch --quiet --with-colons --show-keys "$work/key.asc" 2>/dev/null | awk -F: '$1 == "pub" { pubs++; want = 1; next } want && $1 == "fpr" { print $10; want = 0 } END { if (pubs != 1) print "pubs=" pubs }')

  if [ "$found" != "$fingerprint" ]; then
    say "the key at $key_url isn't Google's Linux package signing key $fingerprint (found: ${found:-nothing}); nothing changed"
    exit 1
  fi

  GNUPGHOME="$work" gpg --batch --quiet --dearmor --output "$work/google-chrome.gpg" "$work/key.asc"
  as_root install -D --mode 0644 "$work/google-chrome.gpg" "$keyring"
  say "installed Google's signing key $fingerprint in $keyring"
}

# The keyring the source names, when the source is Chrome's file.
named_keyring() {
  sed -n 's/^Signed-By:[[:space:]]*\(\/[^[:space:]]*\)[[:space:]]*$/\1/p' "$sources" | head -n 1
}

# What a run would change, read from files alone: no sudo, no network, no change.
pending() {
  if [ ! -f "$sources" ]; then
    echo "add Google's repository as $sources"
    [ -s "$keyring" ] || echo "fetch and check Google's signing key into $keyring"
  else
    local named
    named=$(named_keyring)

    if [ -n "$named" ] && [ ! -s "$named" ]; then echo "fetch and check Google's signing key into $named"; fi
  fi

  if [ -f "$legacy" ] && grep -qE "^[[:space:]]*$legacy_line" "$legacy"; then echo "retire Google's older repository line in $legacy"; fi

  if [ -f "$legacy_keyring" ] && ! grep -rqsF "$legacy_keyring" /etc/apt/sources.list "$sources_dir"; then echo "remove $legacy_keyring, which no source names"; fi
}

# --check: office setup's question, whether a run would change anything. Exit 0 for nothing, 100
# with one line per change.
if [ "${1-}" = --check ]; then
  work=$(pending)

  if [ -z "$work" ]; then exit 0; fi

  printf '%s\n' "$work"
  exit 100
fi

if [ ! -f "$sources" ]; then
  [ -s "$keyring" ] || fetch_key
  chrome_sources | as_root install --mode 0644 /dev/stdin "$sources"
  say "wrote $sources"
  changed=true
else
  named=$(named_keyring)

  if [ -n "$named" ] && [ ! -s "$named" ]; then
    if [ "$named" != "$keyring" ]; then
      say "$sources names the keyring $named, which is missing; it isn't the file this script writes, so fix it or remove $sources and run again"
      exit 1
    fi

    fetch_key
    changed=true
  fi
fi

if [ -f "$legacy" ] && grep -qE "^[[:space:]]*$legacy_line" "$legacy"; then
  if grep -E '^[[:space:]]*#?[[:space:]]*deb' "$legacy" | grep -v -E "^[[:space:]]*#?[[:space:]]*$legacy_line" >/dev/null; then
    as_root sed -i -E "s|^[[:space:]]*($legacy_line)|# \\1|" "$legacy"
    say "commented out Google's repository in $legacy, which lists other sources too"
  else
    as_root rm -f "$legacy"
    say "removed $legacy: $sources is Chrome's source now"
  fi

  changed=true
fi

if [ -f "$legacy_keyring" ] && ! grep -rqsF "$legacy_keyring" /etc/apt/sources.list "$sources_dir"; then
  as_root rm -f "$legacy_keyring"
  say "removed $legacy_keyring, which no source names any more"
fi

if [ "$changed" = true ]; then as_root apt-get update; fi

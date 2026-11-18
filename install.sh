#!/bin/sh
# Installs the office executable from a GitHub release into ~/.local/bin/office.
#
#   curl -fsSL https://raw.githubusercontent.com/meeaster/opencode-office/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/meeaster/opencode-office/main/install.sh | OFFICE_VERSION=<release> sh
#
# Which release: OFFICE_VERSION if set, as `office update --version` takes one; otherwise the newest
# release that publishes this machine's executable and SHA256SUMS, whatever its age. Every release
# is a GitHub pre-release, so there is no "latest" to ask for: the script lists the releases
# instead. A minimum release age applies only to later updates, through `office update`.
#
# The download is checked against the release's SHA256SUMS and run once with --version before it
# replaces ~/.local/bin/office, so a failure leaves any existing office as it was. It never uses
# sudo and never edits shell startup files. Safe to rerun. Needs only sh, curl and coreutils.
set -eu

repo=meeaster/opencode-office
bin_dir="$HOME/.local/bin"
target="$bin_dir/office"
asset=office-linux-x64

say() { printf '%s\n' "$*"; }
fail() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64 | Linux-amd64) ;;
  *) fail "office releases are built for Linux x64 only, and this machine is $(uname -s) $(uname -m). Build office from a checkout instead: https://github.com/$repo#building-from-source" ;;
esac

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum (coreutils) is required"

fetch() { curl -fsSL --proto '=https' --tlsv1.2 --retry 3 "$@"; }

tag_pattern='^[0-9]+\.[0-9]+\.[0-9]+-[0-9]{8}T[0-9]{6}Z$'

if [ -n "${OFFICE_VERSION:-}" ]; then
  case $OFFICE_VERSION in *[!0-9A-Za-z.-]*) fail "OFFICE_VERSION=$OFFICE_VERSION isn't an office release; releases are named like 0.1.0-20261116T163238Z" ;; esac
  printf '%s\n' "$OFFICE_VERSION" | grep -Eq "$tag_pattern" || fail "OFFICE_VERSION=$OFFICE_VERSION isn't an office release; releases are named like 0.1.0-20261116T163238Z"
  tag=$OFFICE_VERSION
  say "Installing the requested release $tag."
else
  # Releases that publish both this machine's executable and SHA256SUMS, newest first. Their
  # download URLs end in /download/<tag>/<file>; drafts aren't listed without a login.
  listing=$(fetch -H 'accept: application/vnd.github+json' "https://api.github.com/repos/$repo/releases?per_page=100") \
    || fail "couldn't list $repo's releases from GitHub's API (offline, or its rate limit for requests without a login). Retry later, or pick a release on https://github.com/$repo/releases and rerun with OFFICE_VERSION=<release>"
  urls=$(printf '%s\n' "$listing" | grep -o "\"browser_download_url\": *\"https://github.com/$repo/releases/download/[^\"]*\"" | sed 's|.*/releases/download/||; s|"$||') || true
  tags=$(printf '%s\n' "$urls" | sed -n "s|/$asset\$||p" | grep -E "$tag_pattern" | while read -r candidate; do
    printf '%s\n' "$urls" | grep -qxF "$candidate/SHA256SUMS" && printf '%s\n' "$candidate"
  done | sort -rV) || true
  [ -n "$tags" ] || fail "no release of $repo publishes both $asset and SHA256SUMS; see https://github.com/$repo/releases"

  tag=$(printf '%s\n' "$tags" | head -n 1)
  say "Installing $tag, the newest release (office update applies a minimum age to later updates)."
fi

if [ -x "$target" ] && "$target" --version 2>/dev/null | grep -q "^office $tag "; then
  say "$target is already office $tag."
  "$target" --version
  exit 0
fi

work=$(mktemp -d)
created_dir=""
staged=""
cleanup() {
  rm -rf "$work"
  [ -z "$staged" ] || rm -f "$staged"
  [ -z "$created_dir" ] || rmdir "$created_dir" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

base="https://github.com/$repo/releases/download/$tag"
fetch -o "$work/SHA256SUMS" "$base/SHA256SUMS" || fail "couldn't download $tag's SHA256SUMS (does release $tag exist?)"
fetch -o "$work/$asset" "$base/$asset" || fail "couldn't download $tag's $asset"

expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1; exit }' "$work/SHA256SUMS")
[ -n "$expected" ] || fail "$tag's SHA256SUMS lists no $asset; nothing was installed"
actual=$(sha256sum "$work/$asset" | awk '{ print $1 }')
[ "$actual" = "$expected" ] || fail "the downloaded $asset has SHA-256 $actual, but $tag's SHA256SUMS lists $expected; nothing was installed"

if [ ! -d "$bin_dir" ]; then
  mkdir -p "$bin_dir"
  created_dir=$bin_dir
fi

# Staged beside the target, on the same filesystem, so the final rename replaces it atomically.
staged="$bin_dir/.office.install-$$"
cp "$work/$asset" "$staged"
chmod 755 "$staged"
reported=$("$staged" --version 2>&1) || fail "the downloaded office didn't run ($reported); nothing was installed"
case "$reported" in
  "office $tag "*) ;;
  *) fail "the downloaded office reports \"$reported\", not $tag; nothing was installed" ;;
esac
mv -f "$staged" "$target"
staged=""
created_dir=""

say "Installed $target"
"$target" --version

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *)
    say ""
    say "$bin_dir isn't on this shell's PATH, so 'office' alone won't be found yet."
    say "Run it as $target, or add this line to your shell's startup file yourself (install.sh never edits it):"
    # The literal $HOME and $PATH belong in the line to paste.
    # shellcheck disable=SC2016
    say '  export PATH="$HOME/.local/bin:$PATH"'
    say "On many distributions ~/.profile already adds $bin_dir at your next login, now that it exists."
    ;;
esac

say ""
say "Next: office init <folder> --name <name>, review its office.yaml, then office setup in that folder."
say "With an AI agent: https://github.com/$repo/blob/main/INSTALL.md"

#!/bin/sh
# Starts an office's opencode container: writes the office's environment and the machine note,
# installs the tools the office's mise.toml declares, starts the office's cron jobs, then runs
# the command (OpenCode).
set -eu

office=/home/office/workspace

# The office's environment, for OpenCode, its agents' commands, the cron jobs and the installs
# below: Socket Firewall's wrappers first on PATH unless office.yaml turns it off, and the minimum
# release age (minimum_release_age) in each package manager's variable and mise's. `office exec`, `office shell` and interactive bash
# shells source the same file. An office.yaml that doesn't read gets the defaults.
env_file=/etc/opencode/env.sh
office env --container --office "$office" > "$env_file.new" && mv "$env_file.new" "$env_file"
# shellcheck source=/dev/null
. "$env_file"

# The container user's git defaults (GIT_CONFIG_SYSTEM points here): the office's commit identity
# and, when the host's gh login is shared, gh as the HTTPS credential helper. ~/.gitconfig and a
# repository's own config override them.
gitconfig=/etc/opencode/gitconfig
printf '[include]\n\tpath = /etc/gitconfig\n' > "$gitconfig"
git_note='- The office sets no commit identity (`git` in `office.yaml`), so commits use your own git config.'
if [ -n "${OFFICE_GIT_NAME:-}" ] && [ -n "${OFFICE_GIT_EMAIL:-}" ]; then
  git config --file "$gitconfig" user.name "$OFFICE_GIT_NAME"
  git config --file "$gitconfig" user.email "$OFFICE_GIT_EMAIL"
  git_note="- Commits default to the office's identity, $OFFICE_GIT_NAME <$OFFICE_GIT_EMAIL> (\`git\` in \`office.yaml\`); a repository's own git config overrides it."
fi
gh_note=""
for host in $(printf '%s' "${OFFICE_GH_HOSTS:-}" | tr ',' ' '); do
  git config --file "$gitconfig" --add "credential.https://$host.helper" ""
  # From the office root, so mise's shim finds the office's gh wherever git runs.
  git config --file "$gitconfig" --add "credential.https://$host.helper" "!cd $office && gh auth git-credential"
  gh_note="- HTTPS git remotes on ${OFFICE_GH_HOSTS} authenticate through \`gh\` (from the office package's tools in \`machine.packages.toml\`) with the user's GitHub login, shared read-only from the host, so fetch, pull and push work. Never run \`gh auth login\`, \`logout\` or \`switch\` here: the user manages that login on the host."
done

# The age the environment file gave mise, which is the office's.
age_note="Package managers and mise take only releases at least ${MISE_MINIMUM_RELEASE_AGE:-3d} old (\`minimum_release_age\` in \`office.yaml\`)."
case "${MISE_MINIMUM_RELEASE_AGE:-3d}" in
  0h | 0d | 0w | 00*) age_note="Package managers and mise take new releases as soon as they're published (\`minimum_release_age\` in \`office.yaml\`)." ;;
esac
sfw_note="- ${age_note} Socket Firewall is off (\`enabled: false\` for sfw under \`tools\` in \`office.yaml\`)."
case ":$PATH:" in
  *:/usr/local/lib/office/sfw/bin:*)
    sfw_note='- Package downloads go through Socket Firewall (`sfw`), which refuses packages Socket knows to be malicious: `npm`, `npx`, `pnpm`, `pip`, `pip3`, `uv`, `uvx` and `cargo` are wrappers that run `sfw <command>`, and `mise install`, `use` and `upgrade` run behind it too. A refused package is Socket'"'"'s verdict: never route around the wrappers (calling a real binary by its path, another registry); tell the user. '"${age_note}"
    ;;
esac

# Where the agent is running; /etc/opencode/opencode.jsonc loads this as an instruction.
cat > /etc/opencode/machine.md <<EOF
# Machine

- You run in the \`opencode\` container of the \`${OFFICE_NAME:-unnamed}\` office, in Docker on the user's computer. The office root is mounted at \`~/workspace\`; files you change there are the user's office repository on the host.
- The shell has git, build tools, Python 3, jq and ripgrep. Languages and CLIs come from mise: declare them in the nearest \`mise.toml\` (the office's or a working repository's) and run \`mise install\`. The office's \`machine.toml\` and the packages' tools in \`machine.packages.toml\` apply in every folder, through links in mise's global conf.d; a \`mise.toml\` wins in its folder. The \`office\` command is installed.
- Executor is at http://executor:4400 on the container network; the user opens its dashboard at ${OFFICE_EXECUTOR_DASHBOARD:-http://localhost:41440}.
- Pass \`--server http://127.0.0.1:4096\` to every \`opencode\` command, so it uses this container's server (its password is in \`OPENCODE_PASSWORD\`); without it most commands start a second server on the same database. Never run \`opencode service\`.
- When an Executor tool returns an approval link, give the user the link and wait for them to approve before resuming.
${sfw_note}
${git_note}
${gh_note}
EOF

# The office package's plugin reads these names; on the host it reads files office up writes instead.
export OFFICE_EXECUTOR_TOKEN="${OFFICE_EXECUTOR_TOKEN:-${EXECUTOR_TOKEN:-}}"

# The office's machine-wide mise files apply in every folder, as they do on a host-mode office's
# machine; mise loads them only through links in its global conf.d in the home volume, named
# office-<name>-…toml: machine.packages.toml first (the packages' tools), then each package's
# fragment in .office/mise/ (its setup; a file office sync wrote, by its first line), and the
# office's own machine.toml last, so it wins (src/machine.ts names them the same way). Links from an
# earlier start go first, so a removed file leaves none behind.
conf_d="${MISE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/mise}/conf.d"
mkdir -p "$conf_d"
find "$conf_d" -maxdepth 1 -type l -name 'office-*.toml' -delete
# A failed sync can retain a host generation. Only link outputs that sync
# actually projected for this mode; the owner's native machine.toml is independent.
container_projection() {
  [ -f "$1" ] && sed '/^$/q' "$1" | grep -Fxq '# Projected for container mode.'
}
if container_projection "$office/machine.packages.toml"; then
  ln -s "$office/machine.packages.toml" "$conf_d/office-${OFFICE_NAME:-unnamed}-0-packages.toml"
fi
for fragment in "$office"/.office/mise/*.toml; do
  container_projection "$fragment" && head -n 1 "$fragment" | grep -Eq '^# The mise (setup|tools) of package ' || continue
  ln -s "$fragment" "$conf_d/office-${OFFICE_NAME:-unnamed}-1-$(basename "$fragment")"
done
if [ -f "$office/machine.toml" ]; then
  ln -s "$office/machine.toml" "$conf_d/office-${OFFICE_NAME:-unnamed}-2-machine.toml"
fi

# A failed install (offline, a typo) must not keep OpenCode from starting. Each `mise install` goes
# through Socket Firewall, as mise is the wrapper first on PATH when it is on. The machine-wide tools
# install from the filesystem root, where only global config applies, since a mise.toml in the
# office may pin the same tool at another version.
if [ -f "$office/mise.toml" ]; then
  (cd "$office" && mise install --quiet) || echo "office: mise install failed in $office" >&2
fi
if ls "$conf_d"/office-*.toml >/dev/null 2>&1; then
  (cd / && mise install --quiet) || echo "office: mise install failed for the office's machine-wide tools" >&2
fi

# The crontab is what the cron package prints: the jobs packages declare and the office's own from
# the cron package's settings. The runner stamps successes in the home volume.
# Jobs missed while the computer was off run once now, in the background, then supercronic keeps
# the schedule. Job output goes to the container log.
if office --office "$office" cron supercronic > /tmp/office-crontab && [ -s /tmp/office-crontab ]; then
  (cd "$office" && office cron catch-up && TZ=UTC exec supercronic -quiet /tmp/office-crontab) &
fi

exec "$@"

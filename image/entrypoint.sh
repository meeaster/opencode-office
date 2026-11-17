#!/bin/sh
# Starts an office's opencode container: writes the machine note, installs the tools the office's
# mise.toml files declare, starts the office's cron jobs, then runs the command (OpenCode).
set -eu

office=/home/office/workspace

# Before OpenCode opens its database: sessions stored while the home was /home/assistant move to
# /home/office. A failure stops here, so OpenCode never starts beside half-moved sessions.
office migrate-home

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
  gh_note="- HTTPS git remotes on ${OFFICE_GH_HOSTS} authenticate through \`gh\` (pinned in the office's \`mise.toml\`) with the user's GitHub login, shared read-only from the host, so fetch, pull and push work. Never run \`gh auth login\`, \`logout\` or \`switch\` here: the user manages that login on the host."
done

# Where the agent is running; /etc/opencode/opencode.jsonc loads this as an instruction.
cat > /etc/opencode/machine.md <<EOF
# Machine

- You run in the \`opencode\` container of the \`${OFFICE_NAME:-unnamed}\` office, in Docker on the user's computer. The office root is mounted at \`~/workspace\`; files you change there are the user's office repository on the host.
- The shell has git, build tools, Python 3, jq and ripgrep. Languages and CLIs come from mise: declare them in the nearest \`mise.toml\` (the office's or a desk's) and run \`mise install\`. The \`office\` command is installed.
- Executor is at http://executor:4400 on the container network; the user opens its dashboard at ${OFFICE_EXECUTOR_DASHBOARD:-http://localhost:41440}.
- Pass \`--server http://127.0.0.1:4096\` to every \`opencode\` command, so it uses this container's server (its password is in \`OPENCODE_PASSWORD\`); without it most commands start a second server on the same database. Never run \`opencode service\`.
- When an Executor tool returns an approval link, give the user the link and wait for them to approve before resuming.
${git_note}
${gh_note}
EOF

# The office package's plugin reads these names; on the host it reads files office up writes instead.
export OFFICE_EXECUTOR_TOKEN="${OFFICE_EXECUTOR_TOKEN:-${EXECUTOR_TOKEN:-}}"

# A failed install (offline, a typo) must not keep OpenCode from starting.
for config in "$office/mise.toml" "$office"/*/mise.toml; do
  [ -f "$config" ] || continue
  dir=$(dirname "$config")
  (cd "$dir" && mise install --quiet) || echo "office: mise install failed in $dir" >&2
done

# The office's cron/crontab, with each command wrapped to stamp its successes in the home volume.
# Jobs missed while the computer was off run once now, in the background, then supercronic keeps
# the schedule. Job output goes to the container log.
if [ -f "$office/cron/crontab" ]; then
  office cron crontab > /tmp/office-crontab
  (cd "$office" && office cron catch-up; exec supercronic -quiet /tmp/office-crontab) &
fi

exec "$@"

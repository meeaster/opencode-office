# The base image of every office's `opencode` container: Debian with OpenCode, Claude Code, mise,
# build tools, supercronic for the office's cron jobs, and the compiled `office` executable.
# `office up` builds it from a folder holding these image files and the `office` it runs as, so
# the container's `office` is the host's. An office's own Dockerfile can add system packages on
# top of it.
FROM debian:13-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2

LABEL org.opencontainers.image.title=office-opencode

# Exact releases with their published SHA-256s. Never lower OPENCODE_VERSION: newer versions
# migrate the sessions database in the home volume.
ARG OPENCODE_VERSION=2.3.0
ARG OPENCODE_SHA256=fc0f81522aceeabac47693d88389efa2bc517ce74c2c38fd6967819fcc6e4d3b
# Claude Code backs the claude-agent provider, which runs models on a Claude subscription.
ARG CLAUDE_VERSION=2.1.322
ARG CLAUDE_SHA256=3d2bc5ae54d4d4cd63510e9fcca5b6d48d2b18806708df8c8f691aa486c5dca8
# Languages and CLIs come from the office's mise.toml files, installed into the home volume.
ARG MISE_VERSION=2026.11.7
ARG MISE_SHA256=8f5426d9971eaf713b37509749174ca69cf2f08b8b25e389168dcfcab9cd1a4d
# Runs the office's cron/crontab.
ARG SUPERCRONIC_VERSION=0.2.51
ARG SUPERCRONIC_SHA256=cc232108374e8e2b537045f2d5eaa1229f619db314c3ba6a14d38b35dc0aa123

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl git jq libatomic1 openssh-client pkg-config python3 ripgrep unzip xz-utils \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSLo /tmp/opencode.tar.gz "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-x64.tar.gz" \
 && echo "${OPENCODE_SHA256}  /tmp/opencode.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin opencode \
 && rm /tmp/opencode.tar.gz \
 && curl -fsSLo /tmp/claude.tar.gz "https://github.com/anthropics/claude-code/releases/download/v${CLAUDE_VERSION}/claude-linux-x64.tar.gz" \
 && echo "${CLAUDE_SHA256}  /tmp/claude.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/claude.tar.gz -C /usr/local/bin claude \
 && rm /tmp/claude.tar.gz \
 && curl -fsSLo /usr/local/bin/mise "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-x64" \
 && echo "${MISE_SHA256}  /usr/local/bin/mise" | sha256sum -c - \
 && chmod 755 /usr/local/bin/mise \
 && curl -fsSLo /usr/local/bin/supercronic "https://github.com/aptible/supercronic/releases/download/v${SUPERCRONIC_VERSION}/supercronic-linux-amd64" \
 && echo "${SUPERCRONIC_SHA256}  /usr/local/bin/supercronic" | sha256sum -c - \
 && chmod 755 /usr/local/bin/supercronic

# The container user keeps uid 1000 and its home, so existing sessions and logins stay valid.
RUN groupadd -g 1000 assistant && useradd -m -u 1000 -g assistant -s /bin/bash assistant \
 && install -d -o assistant -g assistant /etc/opencode

# Managed settings. The entrypoint writes the machine note beside them at start.
COPY --chown=assistant:assistant config/ /etc/opencode/
COPY --chmod=755 entrypoint.sh /usr/local/bin/office-entrypoint

# The office CLI, compiled with Bun into one file that needs no runtime. Last, as it changes most.
COPY --chmod=755 office /usr/local/bin/office

USER assistant
ENV HOME=/home/assistant \
    SHELL=/bin/bash \
    # Claude Code is pinned above; its own updater is off.
    DISABLE_AUTOUPDATER=1 \
    # The office's mise.toml files are its own, so mise trusts everything under the mount.
    MISE_TRUSTED_CONFIG_PATHS=/home/assistant/workspace \
    MISE_YES=1 \
    # mise's shims first, so a shell anywhere in the office runs the tools that folder declares.
    PATH=/home/assistant/.local/share/mise/shims:/home/assistant/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WORKDIR /home/assistant/workspace

EXPOSE 4096
ENTRYPOINT ["office-entrypoint"]
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096", "--print-logs"]

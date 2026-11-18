# The base image of every office's `opencode` container: Debian with OpenCode, Claude Code, mise,
# Socket Firewall, build tools, Chromium, supercronic for the office's cron jobs, and the compiled
# `office` executable.
# `office up` builds it from a folder holding these image files and the `office` it runs as, so
# the container's `office` is the host's, and passes the versions the office pins (office.yaml)
# with their checksums (office.lock). An office's own Dockerfile can add system packages on top.
FROM debian:13-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2

LABEL org.opencontainers.image.title=office-opencode

# The Debian base is pinned by digest, so its packages only get security fixes here. `office up`
# passes the time of the office's last refresh (`office up --refresh`, which a weekly timer runs):
# a new value rebuilds this layer and everything after it with current packages, and the same
# value keeps the cached layer. Chromium and its fonts let agents check their work in a browser;
# AGENT_BROWSER_EXECUTABLE_PATH (below) points agent-browser at it.
ARG APT_REFRESH
RUN echo "packages as of ${APT_REFRESH:-the first build}" \
 && apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends \
      build-essential ca-certificates chromium curl fonts-liberation fonts-noto-color-emoji git jq libatomic1 openssh-client pkg-config python3 ripgrep unzip xz-utils \
 && rm -rf /var/lib/apt/lists/*

# Runs the supercronic input generated from office.yaml and package defaults.
ARG SUPERCRONIC_VERSION=0.2.51
ARG SUPERCRONIC_SHA256=cc232108374e8e2b537045f2d5eaa1229f619db314c3ba6a14d38b35dc0aa123

RUN curl -fsSLo /usr/local/bin/supercronic "https://github.com/aptible/supercronic/releases/download/v${SUPERCRONIC_VERSION}/supercronic-linux-amd64" \
 && echo "${SUPERCRONIC_SHA256}  /usr/local/bin/supercronic" | sha256sum -c - \
 && chmod 755 /usr/local/bin/supercronic

# The office's versions and the SHA-256 of each release file, from office.yaml and office.lock.
# Claude Code backs the claude-agent provider; mise installs the office's languages and CLIs into
# the home volume; every package download goes through Socket Firewall (sfw, below). `office up`
# refuses an older OpenCode than the office has run: newer versions migrate the sessions database
# in the home volume.
ARG OPENCODE_VERSION
ARG OPENCODE_SHA256
ARG CLAUDE_VERSION
ARG CLAUDE_SHA256
ARG CODEX_VERSION
ARG CODEX_SHA256
ARG MISE_VERSION
ARG MISE_SHA256
ARG SFW_VERSION
ARG SFW_SHA256

RUN curl -fsSLo /tmp/opencode.tar.gz "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-x64.tar.gz" \
 && echo "${OPENCODE_SHA256}  /tmp/opencode.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin opencode \
 && rm /tmp/opencode.tar.gz \
 && curl -fsSLo /tmp/claude.tar.gz "https://github.com/anthropics/claude-code/releases/download/v${CLAUDE_VERSION}/claude-linux-x64.tar.gz" \
 && echo "${CLAUDE_SHA256}  /tmp/claude.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/claude.tar.gz -C /usr/local/bin claude \
 && rm /tmp/claude.tar.gz \
 && curl -fsSLo /tmp/codex.tar.gz "https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-package-x86_64-unknown-linux-musl.tar.gz" \
 && echo "${CODEX_SHA256}  /tmp/codex.tar.gz" | sha256sum -c - \
 && mkdir -p /opt/codex \
 && tar -xzf /tmp/codex.tar.gz -C /opt/codex \
 && ln -s /opt/codex/bin/codex /usr/local/bin/codex \
 && codex --version \
 && rm /tmp/codex.tar.gz \
 && curl -fsSLo /usr/local/bin/mise "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-x64" \
 && echo "${MISE_SHA256}  /usr/local/bin/mise" | sha256sum -c - \
 && chmod 755 /usr/local/bin/mise \
 && curl -fsSLo /usr/local/bin/sfw "https://github.com/SocketDev/sfw-free/releases/download/v${SFW_VERSION}/sfw-free-linux-x86_64" \
 && echo "${SFW_SHA256}  /usr/local/bin/sfw" | sha256sum -c - \
 && chmod 755 /usr/local/bin/sfw

# The container user keeps uid 1000, which owns the home volume and the office's files. It was
# `assistant` with home /home/assistant; the entrypoint's `office migrate-home` moves the paths
# the home volume stored then.
RUN groupadd -g 1000 office && useradd -m -u 1000 -g office -s /bin/bash office \
 && install -d -o office -g office /etc/opencode

# Managed settings. The entrypoint writes the machine note beside them at start.
COPY --chown=office:office config/ /etc/opencode/
COPY --chmod=755 entrypoint.sh /usr/local/bin/office-entrypoint

# The office CLI, compiled with Bun into one file that needs no runtime. Last, as it changes most.
COPY --chmod=755 office /usr/local/bin/office

# Socket Firewall's wrappers, which `office` writes from its one list (src/sfw.ts): npm, npx, pnpm,
# pip, pip3, uv, uvx and cargo, each running `sfw <command>`, and mise, whose installs go through
# sfw. The entrypoint puts their folder first on PATH, through the environment file it writes at
# start from office.yaml (socket_firewall); this one, the defaults, is for a container that can't
# read it. Interactive bash shells source it too, as `office exec` and `office shell` do.
RUN office sfw-wrappers \
 && office env --container > /etc/opencode/env.sh \
 && chown office:office /etc/opencode/env.sh \
 && printf '\n# The office environment: Socket Firewall wrappers first on PATH, package release ages.\n[ -r /etc/opencode/env.sh ] && . /etc/opencode/env.sh\n' >> /etc/bash.bashrc

USER office
ENV HOME=/home/office \
    SHELL=/bin/bash \
    # Claude Code is pinned above; its own updater is off.
    DISABLE_AUTOUPDATER=1 \
    # The office's mise.toml files are its own, so mise trusts everything under the mount.
    MISE_TRUSTED_CONFIG_PATHS=/home/office/workspace \
    MISE_YES=1 \
    # Debian's Chromium, installed above, for agent-browser.
    AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium \
    # The office's git defaults, which the entrypoint writes: its commit identity and gh as the
    # HTTPS credential helper. It includes /etc/gitconfig; ~/.gitconfig and repositories override it.
    GIT_CONFIG_SYSTEM=/etc/opencode/gitconfig \
    # mise's shims first, so a shell anywhere in the office runs the tools that folder declares.
    PATH=/home/office/.local/share/mise/shims:/home/office/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WORKDIR /home/office/workspace

EXPOSE 4096
ENTRYPOINT ["office-entrypoint"]
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096", "--print-logs"]

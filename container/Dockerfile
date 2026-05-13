# ==============================================================================
# SwarmFleet — Source-mounted Docker Environment
# Supports the SwarmFleet web UI without bundling app source
#
# Build:
#   docker build -t swarmfleet .
#
# Cache optimization:
#   Uses BuildKit cache mounts for apt, pip, npm. App source is mounted at
#   runtime by run-docker-instance.sh, so docker build does not build SwarmFleet.
# ==============================================================================

# syntax=docker/dockerfile:1

FROM debian:bookworm-slim AS dev

# ---------- Build args ----------
ARG S6_OVERLAY_VERSION=3.2.0.2
ARG TARGETARCH

# ---------- Environment ----------
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    DISPLAY=:99 \
    DBUS_SESSION_BUS_ADDRESS=disabled: \
    CHROMIUM_FLAGS="--no-sandbox --disable-gpu --disable-dev-shm-usage" \
    CHROME_PATH=/usr/bin/chromium \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    SWARMFLEET_TOOLS_ROOT=/home/user/.swarmfleet/tools \
    EDITOR=nano \
    VISUAL=nano \
    PATH=/command:/usr/local/sbin:/usr/local/bin:/home/user/.swarmfleet/tools/bin:/home/user/.swarmfleet/tools/npm/bin:/home/user/.swarmfleet/tools/python/bin:/usr/sbin:/usr/bin:/sbin:/bin

# ==========================================================================
# LAYER 1: s6-overlay (changes only when version bumps)
# ==========================================================================
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends xz-utils curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN S6_ARCH=$(case "$TARGETARCH" in arm64) echo "aarch64";; *) echo "x86_64";; esac) && \
    curl -fsSL -o /tmp/s6-overlay-noarch.tar.xz \
      "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz" && \
    curl -fsSL -o /tmp/s6-overlay-arch.tar.xz \
      "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${S6_ARCH}.tar.xz" && \
    tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz && \
    tar -C / -Jxpf /tmp/s6-overlay-arch.tar.xz && \
    rm /tmp/s6-overlay-*.tar.xz

# ==========================================================================
# LAYER 2: System packages (changes rarely — when adding new apt packages)
# ==========================================================================
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    # Core utilities
    git curl wget jq ripgrep fd-find unzip zip tree tmux fzf bat bubblewrap libnss3-tools nano \
    # Build tools
    build-essential pkg-config python3 python3-pip python3-venv python3-yaml \
    # Browser (Playwright/Puppeteer)
    chromium \
    # Fonts
    fonts-liberation2 fonts-dejavu-core fonts-noto-core fonts-noto-color-emoji fonts-inter \
    # Locale support
    locales \
    # Debugging tools
    strace lsof iproute2 procps htop \
    # Database CLI tools
    postgresql-client redis-tools sqlite3 \
    # SSH client (NOT server)
    openssh-client \
    # Xvfb for headless Chrome
    xvfb \
    # Image processing
    imagemagick \
    # Sudo
    sudo

# ---------- Locale configuration ----------
RUN sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen

# ---------- Node via mise ----------
# Mutable user tools are deliberately NOT installed here. mise only provides the
# stable Node runtime/npm envelope used by SwarmFleet and the persistent tools service.
# npm/npx/corepack are wrappers, not symlinks: npm resolves its lib path relative
# to argv[1], so symlinking it into /usr/local/bin makes it look for
# /usr/local/lib/node_modules/npm instead of mise's Node install directory.
RUN curl -fsSL https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh && \
    MISE_DATA_DIR=/opt/mise MISE_CONFIG_DIR=/opt/mise/config /usr/local/bin/mise install node@22 && \
    NODE_DIR="$(MISE_DATA_DIR=/opt/mise MISE_CONFIG_DIR=/opt/mise/config /usr/local/bin/mise where node@22)" && \
    ln -sf "$NODE_DIR/bin/node" /usr/local/bin/node && \
    printf '#!/bin/sh\nexec "%s/bin/npm" "$@"\n' "$NODE_DIR" > /usr/local/bin/npm && \
    printf '#!/bin/sh\nexec "%s/bin/npx" "$@"\n' "$NODE_DIR" > /usr/local/bin/npx && \
    printf '#!/bin/sh\nexec "%s/bin/corepack" "$@"\n' "$NODE_DIR" > /usr/local/bin/corepack && \
    chmod +x /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack && \
    node --version && npm --version

# ---------- bubblewrap setuid ----------
RUN chmod u+s /usr/bin/bwrap

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      pandoc ffmpeg libvips-dev

# ---------- GitHub CLI ----------
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# ---------- Caddy ----------
RUN apt-get update \
  && apt-get install -y --no-install-recommends debian-keyring debian-archive-keyring apt-transport-https curl gnupg libcap2-bin \
  && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
  && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list \
  && apt-get update && apt-get install -y caddy \
  && setcap cap_net_bind_service=+ep $(which caddy) \
  && rm -rf /var/lib/apt/lists/*

# ---------- mkcert ----------
# TLS cert generation runs inside the container so the host only needs Docker.
RUN MKCERT_ARCH=$(case "$(dpkg --print-architecture)" in arm64) echo "arm64";; *) echo "amd64";; esac) && \
    curl -fsSL -o /usr/local/bin/mkcert \
      "https://github.com/FiloSottile/mkcert/releases/download/v1.4.4/mkcert-v1.4.4-linux-${MKCERT_ARCH}" && \
    chmod +x /usr/local/bin/mkcert

# ---------- bat symlink (Debian names it batcat) ----------
RUN ln -sf /usr/bin/batcat /usr/local/bin/bat 2>/dev/null || true

# ==========================================================================
# LAYER 3: User setup (changes never)
# ==========================================================================
RUN groupadd -g 1000 user && \
    useradd -m -u 1000 -g user -s /bin/bash user && \
    echo "user ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/user && \
    chmod 0440 /etc/sudoers.d/user

# ==========================================================================
# LAYER 4: Hermes Agent is part of the image
# ==========================================================================
# Hermes is the primary in-container agent runtime, so it is baked into the
# image and exposed globally at /usr/local/bin/hermes. User data/config/auth is
# still stored under /home/user/.hermes, which the launcher persists.
RUN curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh -o /tmp/hermes-install.sh && \
    HERMES_HOME=/home/user/.hermes bash /tmp/hermes-install.sh --skip-setup --hermes-home /home/user/.hermes && \
    rm -f /tmp/hermes-install.sh && \
    chown -R user:user /home/user/.hermes

# ==========================================================================
# LAYER 5: Mutable user tools are managed at runtime, not image build time
# ==========================================================================
# Claude, Codex, Chrome DevTools MCP, and any user global tools live in
# /home/user/.swarmfleet/tools, which is persisted by the Docker launcher.
# Hermes is intentionally not managed by this service; it is an image-level tool.

# ==========================================================================
# LAYER 7: Runtime wiring
#
# SwarmFleet source and runtime state are bind-mounted by the launcher.
# Default settings are baked into the image under /opt/swarmfleet/defaults.
# ==========================================================================

# ---------- Copy config files ----------
COPY container/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY container/bootstrap.sh /usr/local/bin/bootstrap.sh
COPY container/notify.py /usr/local/bin/notify.py
COPY container/tool-manager.sh /usr/local/bin/swarmfleet-tool-manager
COPY container/profile.d/swarmfleet-mise.sh /etc/profile.d/swarmfleet-mise.sh
COPY container/scripts/setup-certs.sh /usr/local/bin/setup-certs.sh
COPY container/defaults /opt/swarmfleet/defaults
RUN chmod +x /usr/local/bin/entrypoint.sh \
    /usr/local/bin/bootstrap.sh \
    /usr/local/bin/notify.py \
    /usr/local/bin/swarmfleet-tool-manager \
    /usr/local/bin/setup-certs.sh

RUN mkdir -p /opt/swarmfleet/harness

# ---------- s6-overlay service definitions ----------
COPY container/s6-overlay/s6-rc.d/xvfb/type /etc/s6-overlay/s6-rc.d/xvfb/type
COPY container/s6-overlay/s6-rc.d/xvfb/run /etc/s6-overlay/s6-rc.d/xvfb/run
COPY container/s6-overlay/s6-rc.d/backend/type /etc/s6-overlay/s6-rc.d/backend/type
COPY container/s6-overlay/s6-rc.d/backend/run /etc/s6-overlay/s6-rc.d/backend/run
COPY container/s6-overlay/s6-rc.d/tool-manager/type /etc/s6-overlay/s6-rc.d/tool-manager/type
COPY container/s6-overlay/s6-rc.d/tool-manager/run /etc/s6-overlay/s6-rc.d/tool-manager/run
COPY container/s6-overlay/s6-rc.d/vite/type /etc/s6-overlay/s6-rc.d/vite/type
COPY container/s6-overlay/s6-rc.d/vite/run /etc/s6-overlay/s6-rc.d/vite/run
COPY container/s6-overlay/s6-rc.d/caddy/type /etc/s6-overlay/s6-rc.d/caddy/type
COPY container/s6-overlay/s6-rc.d/caddy/run /etc/s6-overlay/s6-rc.d/caddy/run
COPY container/s6-overlay/s6-rc.d/https-mux/type /etc/s6-overlay/s6-rc.d/https-mux/type
COPY container/s6-overlay/s6-rc.d/https-mux/run /etc/s6-overlay/s6-rc.d/https-mux/run
COPY container/caddy/Caddyfile /etc/caddy/Caddyfile
COPY container/caddy/startup.html /etc/caddy/startup.html
COPY container/http-https-mux.cjs /usr/local/bin/http-https-mux.cjs
RUN chmod +x /etc/s6-overlay/s6-rc.d/xvfb/run \
    /etc/s6-overlay/s6-rc.d/backend/run \
    /etc/s6-overlay/s6-rc.d/tool-manager/run \
    /etc/s6-overlay/s6-rc.d/vite/run \
    /etc/s6-overlay/s6-rc.d/caddy/run \
    /etc/s6-overlay/s6-rc.d/https-mux/run \
    /usr/local/bin/http-https-mux.cjs && \
    touch /etc/s6-overlay/s6-rc.d/user/contents.d/xvfb && \
    touch /etc/s6-overlay/s6-rc.d/user/contents.d/backend && \
    touch /etc/s6-overlay/s6-rc.d/user/contents.d/tool-manager && \
    touch /etc/s6-overlay/s6-rc.d/user/contents.d/vite && \
    touch /etc/s6-overlay/s6-rc.d/user/contents.d/caddy && \
    touch /etc/s6-overlay/s6-rc.d/user/contents.d/https-mux

ENV SWARMFLEET_FRONTEND_PORT=7080
ENV SWARMFLEET_CADDY_HTTPS_PORT=7443
ENV SWARMFLEET_CONFIG_DIR=/config
ENV SWARMFLEET_HARNESS_DIR=/opt/swarmfleet/harness
ENV SWARMFLEET_BACKEND_DIR=/opt/swarmfleet/harness/backend
ENV SWARMFLEET_FRONTEND_DIR=/opt/swarmfleet/harness/frontend

# ---------- Working directory ----------
WORKDIR /workspace

EXPOSE 7080 443

# ---------- Health check ----------
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -sf http://localhost:7080/ || exit 1

# ---------- s6-overlay as PID 1 ----------
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

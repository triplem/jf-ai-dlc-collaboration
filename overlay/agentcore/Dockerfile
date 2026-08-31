# jf-ai-dlc agentcore image — amd64, Claude-Code-only.
#
# The upstream Dockerfile (upstream/collab/lambda/agentcore/Dockerfile) targets
# ARM64 (Bedrock AgentCore runs on Graviton microVMs) and installs Kiro,
# OpenCode, and Codex with arch-specific binaries that fail on amd64. This stack
# runs Claude Code (npm, arch-independent), so this image installs only that CLI
# plus bun/uv (arch-detecting installers) and the agentcore server. It serves the
# same contract: listen on 0.0.0.0:8080, GET /ping + POST /invocations.
#
# Build context = repo root (so it can COPY the agentcore package + shared/ helpers).

# --- stage 1: apply overlay/patches onto the pristine upstream subtree --------
# upstream/collab is a pristine git-subtree vendor (README: never hand-edit);
# local modifications live as overlay/patches/*.patch, applied here at build
# time (git apply fails loudly if a patch no longer applies). See docs/patches.md.
FROM node:24-slim AS upstream-patched
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY upstream/collab upstream/collab
COPY overlay/patches overlay/patches
RUN for p in overlay/patches/*.patch; do echo "applying $p"; git apply "$p"; done

# --- stage 2: runtime image ---------------------------------------------------
FROM node:24-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git curl unzip jq procps python3 \
    && ln -sf /usr/bin/python3 /usr/local/bin/python \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI (npm — arch-independent). The other drivers (kiro/opencode/
# codex) are intentionally omitted; selectCli resolves to whatever is present.
RUN npm install -g @anthropic-ai/claude-code

# Bun — the deterministic CODE sensors (linter/type-check) shell out to bunx.
RUN curl -fsSL https://bun.sh/install | bash \
    && mkdir -p /opt/bun \
    && cp -a /root/.bun/bin /opt/bun/bin \
    && ln -sf /opt/bun/bin/bun /usr/local/bin/bun \
    && ln -sf /opt/bun/bin/bunx /usr/local/bin/bunx \
    && rm -rf /root/.bun

# uv / uvx — launcher for Python-based MCP servers.
RUN curl -LsSf https://astral.sh/uv/install.sh \
    | env UV_INSTALL_DIR=/opt/uv/bin UV_NO_MODIFY_PATH=1 sh \
    && ln -sf /opt/uv/bin/uv /usr/local/bin/uv \
    && ln -sf /opt/uv/bin/uvx /usr/local/bin/uvx

# agentcore sources come PATCHED from stage 1.
COPY --from=upstream-patched /src/upstream/collab/lambda/agentcore/package.json /opt/agentcore/package.json
RUN cd /opt/agentcore && npm install --omit=dev

COPY --from=upstream-patched /src/upstream/collab/lambda/agentcore/ /opt/agentcore/
COPY --from=upstream-patched /src/upstream/collab/lambda/shared/ /opt/shared/
RUN ln -s /opt/agentcore/node_modules /opt/shared/node_modules

RUN mkdir -p /mnt/workspace /home/node/.codex-state /home/node/.codex-runs \
    && chown -R node:node /mnt/workspace /opt/agentcore /opt/shared /opt/bun /opt/uv /home/node/.codex-state /home/node/.codex-runs

WORKDIR /mnt/workspace
USER node
ENV HOME=/home/node \
    PATH=/opt/bun/bin:/opt/uv/bin:/usr/local/bin:/usr/bin:/bin \
    V2_WORKSPACE_DIR=/mnt/workspace \
    CLAUDE_CONFIG_DIR=/mnt/workspace/.claude \
    V2_MCP_ENTRY=/opt/agentcore/mcp/index.js

RUN git config --global --add safe.directory '*'

EXPOSE 8080
ENTRYPOINT ["node", "/opt/agentcore/http-server.js"]

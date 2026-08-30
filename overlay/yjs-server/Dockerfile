# jf-ai-dlc yjs-server image — built from the PATCHED upstream yjs-server.
#
# The upstream Dockerfile (upstream/collab/lambda/yjs-server/Dockerfile) builds
# from its own directory context and would use the pristine (Cognito) sources.
# This OSS build needs overlay/patches/0002 (WS auth ported to Keycloak/OIDC),
# so it builds from the repo root and applies the patches at build time.
# upstream/collab stays pristine (README: never hand-edit). See docs/patches.md.
#
# Build context = repo root.

# --- stage 1: apply overlay/patches onto the pristine upstream subtree --------
FROM node:24.15.0-alpine3.23 AS upstream-patched
RUN apk add --no-cache git
WORKDIR /src
COPY upstream/collab/lambda upstream/collab/lambda
COPY overlay/patches overlay/patches
RUN for p in overlay/patches/*.patch; do echo "applying $p"; git apply "$p"; done

# --- stage 2: runtime image (mirrors the upstream yjs-server Dockerfile) -------
FROM node:24.15.0-alpine3.23
WORKDIR /app

COPY --from=upstream-patched \
     /src/upstream/collab/lambda/yjs-server/package.json \
     /src/upstream/collab/lambda/yjs-server/package-lock.json ./
RUN npm ci --omit=dev

COPY --from=upstream-patched \
     /src/upstream/collab/lambda/yjs-server/server.js \
     /src/upstream/collab/lambda/yjs-server/realtime-token.js \
     /src/upstream/collab/lambda/yjs-server/doc-name.js ./

USER node
EXPOSE 1234
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --spider -q http://localhost:1234/ || exit 1
CMD ["node", "server.js"]

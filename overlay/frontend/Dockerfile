# Builds the collab frontend with the Keycloak/OIDC auth swap and serves the
# static SPA via nginx. Build context = repo root (needs upstream/ + overlay/).
#
# VITE_* are inlined at build time, so they are build ARGs. The compose service
# passes local-stack values; override them for other environments.
FROM node:22-alpine AS build

ARG VITE_API_BASE_URL=http://localhost:3001/api
ARG VITE_WEBSOCKET_URL=ws://localhost:3002
ARG VITE_YJS_SERVER_URL=ws://localhost:1234
ARG VITE_OIDC_ISSUER=http://localhost:8081/realms/jf-ai-dlc
ARG VITE_OIDC_CLIENT_ID=jf-ui
ARG VITE_AUTH_MODE=local
ARG VITE_SSO_PROVIDERS=[]
ARG VITE_APP_ORIGIN=http://localhost:8088
ARG VITE_AUTH_CALLBACK_URL=http://localhost:8088/auth/callback
ARG VITE_ENVIRONMENT=local
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL \
    VITE_WEBSOCKET_URL=$VITE_WEBSOCKET_URL \
    VITE_YJS_SERVER_URL=$VITE_YJS_SERVER_URL \
    VITE_OIDC_ISSUER=$VITE_OIDC_ISSUER \
    VITE_OIDC_CLIENT_ID=$VITE_OIDC_CLIENT_ID \
    VITE_AUTH_MODE=$VITE_AUTH_MODE \
    VITE_SSO_PROVIDERS=$VITE_SSO_PROVIDERS \
    VITE_APP_ORIGIN=$VITE_APP_ORIGIN \
    VITE_AUTH_CALLBACK_URL=$VITE_AUTH_CALLBACK_URL \
    VITE_ENVIRONMENT=$VITE_ENVIRONMENT

WORKDIR /app
# root package.json is read by the upstream vite config for the app version
COPY upstream/collab/package.json upstream/collab/package.json
COPY upstream/collab/frontend upstream/collab/frontend
COPY overlay/frontend overlay/frontend

RUN cd upstream/collab/frontend && npm install --no-audit --no-fund
# Copy the config into the frontend dir so its `vite` / `@vitejs/plugin-react`
# imports resolve against the local node_modules. tsc type-checks the original
# (Cognito) auth.ts; the OIDC swap is a Vite-time concern, so build the bundle
# directly with our config (skip tsc -b).
RUN cp /app/overlay/frontend/vite.config.jf.ts /app/upstream/collab/frontend/vite.config.jf.ts \
 && cd upstream/collab/frontend \
 && npx vite build --config vite.config.jf.ts --outDir /app/dist

FROM nginx:1.27-alpine
COPY overlay/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80

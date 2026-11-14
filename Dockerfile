# Rook in one image: the services (planner, evaluator, gateways, signer, orchestrator) and the web app.
# They share a container because the services listen on 127.0.0.1 only and refuse any other Host (http.ts): the web
# app reaches the orchestrator on loopback, and nothing holding a key is reachable from outside. See docs/operations.md.
FROM node:22-bookworm-slim

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/package.json services/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile

COPY services services
COPY web web

# The browser bundle has these baked in at build time (NEXT_PUBLIC_*).
ARG NEXT_PUBLIC_SITE_URL=https://runrook.xyz
ARG NEXT_PUBLIC_NEAR_NETWORK=mainnet
ARG NEXT_PUBLIC_NEAR_RPC_URL=https://free.rpc.fastnear.com
RUN pnpm --filter @rook/web build

COPY deploy/start.sh deploy/start.sh
RUN mkdir -p /data /run/rook && chown -R node:node /data /app/web/.next
USER node

ENV NODE_ENV=production \
    ROOK_DB=/data/rook.sqlite \
    ROOK_WEB_DB=/data/web.sqlite \
    ROOK_ENV_FILE=/run/rook/services.env \
    WEB_PORT=7888 \
    ORCHESTRATOR_PORT=7889 \
    PLANNER_PORT=7890 \
    EVALUATOR_PORT=7891 \
    MARKET_GATEWAY_PORT=7892 \
    SIGNER_PORT=7893 \
    CHAIN_GATEWAY_PORT=7894 \
    SIMULATOR_PORT=7895 \
    ORCHESTRATOR_URL=http://127.0.0.1:7889

VOLUME /data
EXPOSE 7888
CMD ["bash", "deploy/start.sh"]

FROM node:24.13.0 AS base

WORKDIR /overleaf/services/ai-writing-agent

FROM base AS app

# --- 1. Copy package manifests for npm ci cache layer ---
COPY package.json package-lock.json /overleaf/
COPY libraries/config-system/package.json /overleaf/libraries/config-system/package.json
COPY libraries/fetch-utils/package.json /overleaf/libraries/fetch-utils/package.json
COPY libraries/logger/package.json /overleaf/libraries/logger/package.json
COPY libraries/metrics/package.json /overleaf/libraries/metrics/package.json
COPY libraries/mongo-utils/package.json /overleaf/libraries/mongo-utils/package.json
COPY libraries/o-error/package.json /overleaf/libraries/o-error/package.json
COPY libraries/promise-utils/package.json /overleaf/libraries/promise-utils/package.json
COPY libraries/redis-wrapper/package.json /overleaf/libraries/redis-wrapper/package.json
COPY libraries/settings/package.json /overleaf/libraries/settings/package.json
COPY services/ai-writing-agent/package.json /overleaf/services/ai-writing-agent/package.json
COPY tools/migrations/package.json /overleaf/tools/migrations/package.json
COPY patches/ /overleaf/patches/
COPY tools/migrations/ /overleaf/tools/migrations/

ARG NODEJS_ORG_MIRROR=""
ENV NODEJS_ORG_MIRROR=${NODEJS_ORG_MIRROR}
RUN cd /overleaf && npm ci --quiet

# --- 2. Copy source code ---
COPY libraries/config-system/ /overleaf/libraries/config-system/
COPY libraries/fetch-utils/ /overleaf/libraries/fetch-utils/
COPY libraries/logger/ /overleaf/libraries/logger/
COPY libraries/metrics/ /overleaf/libraries/metrics/
COPY libraries/mongo-utils/ /overleaf/libraries/mongo-utils/
COPY libraries/o-error/ /overleaf/libraries/o-error/
COPY libraries/promise-utils/ /overleaf/libraries/promise-utils/
COPY libraries/redis-wrapper/ /overleaf/libraries/redis-wrapper/
COPY libraries/settings/ /overleaf/libraries/settings/
COPY services/ai-writing-agent/ /overleaf/services/ai-writing-agent/

FROM app

ENV NODE_ENV=production
EXPOSE 3060

USER node

CMD ["node", "app.js"]

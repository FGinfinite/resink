FROM node:24.13.0 AS base

WORKDIR /overleaf/services/ai-writing-agent
RUN corepack enable

FROM base AS app

USER root
ARG UV_VERSION=0.8.22
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl docker.io \
  && curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz" -o /tmp/uv.tar.gz \
  && tar -xzf /tmp/uv.tar.gz -C /tmp \
  && install -m 0755 /tmp/uv-x86_64-unknown-linux-gnu/uv /usr/local/bin/uv \
  && install -m 0755 /tmp/uv-x86_64-unknown-linux-gnu/uvx /usr/local/bin/uvx \
  && rm -rf /tmp/uv.tar.gz /tmp/uv-x86_64-unknown-linux-gnu \
  && rm -rf /var/lib/apt/lists/*

# --- 1. Copy package manifests for dependency cache layer ---
COPY package.json yarn.lock .yarnrc.yml /overleaf/
COPY libraries/config-system/package.json /overleaf/libraries/config-system/package.json
COPY libraries/eslint-plugin/package.json /overleaf/libraries/eslint-plugin/package.json
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
COPY .yarn/patches/ /overleaf/.yarn/patches/
COPY tools/migrations/ /overleaf/tools/migrations/

ARG NODEJS_ORG_MIRROR=""
ENV NODEJS_ORG_MIRROR=${NODEJS_ORG_MIRROR}
RUN cd /overleaf && yarn workspaces focus @overleaf/ai-writing-agent overleaf

# --- 2. Copy source code ---
COPY libraries/config-system/ /overleaf/libraries/config-system/
COPY libraries/eslint-plugin/ /overleaf/libraries/eslint-plugin/
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

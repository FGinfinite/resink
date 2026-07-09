FROM node:24.13.0-bookworm-slim AS node-runtime

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /workspace

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    biber \
    ca-certificates \
    diffutils \
    git \
    latexmk \
    patch \
    poppler-utils \
    python3 \
    python3-pip \
    ripgrep \
    texlive-bibtex-extra \
    texlive-fonts-recommended \
    texlive-latex-base \
    texlive-latex-extra \
    texlive-latex-recommended \
    texlive-lang-chinese \
    texlive-xetex \
  && rm -rf /var/lib/apt/lists/*

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

RUN npm install -g opencode-ai@1.17.8

COPY sandbox/requirements.txt /tmp/resink-sandbox-requirements.txt
RUN if [ -s /tmp/resink-sandbox-requirements.txt ]; then \
    pip3 install --break-system-packages --no-cache-dir -r /tmp/resink-sandbox-requirements.txt; \
  fi \
  && rm -f /tmp/resink-sandbox-requirements.txt

CMD ["sh", "-c", "sleep infinity"]

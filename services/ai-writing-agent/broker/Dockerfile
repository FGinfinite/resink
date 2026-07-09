FROM python:3.12-slim-bookworm

ARG UV_VERSION=0.8.22

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /broker-workspace

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz" -o /tmp/uv.tar.gz \
  && tar -xzf /tmp/uv.tar.gz -C /tmp \
  && install -m 0755 /tmp/uv-x86_64-unknown-linux-gnu/uv /usr/local/bin/uv \
  && rm -rf /tmp/uv.tar.gz /tmp/uv-x86_64-unknown-linux-gnu \
  && apt-get purge -y --auto-remove curl \
  && rm -rf /var/lib/apt/lists/*

CMD ["uv", "--version"]

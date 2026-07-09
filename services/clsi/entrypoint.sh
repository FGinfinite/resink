#!/bin/sh

# Add the node user to the Docker socket group when a local socket is mounted.
# Remote Docker API mode uses DOCKER_HOST and should not fail this entrypoint.
if [ -S /var/run/docker.sock ]; then
  DOCKER_GROUP=$(stat -c '%g' /var/run/docker.sock)
  groupadd --non-unique --gid "${DOCKER_GROUP}" dockeronhost
  usermod -aG dockeronhost node
fi

# compatibility: initial volume setup
mkdir -p /overleaf/services/clsi/cache && chown node:node /overleaf/services/clsi/cache
mkdir -p /overleaf/services/clsi/compiles && chown node:node /overleaf/services/clsi/compiles
mkdir -p /overleaf/services/clsi/output && chown node:node /overleaf/services/clsi/output
mkdir -p /overleaf/services/clsi/uploads && chown node:node /overleaf/services/clsi/uploads

exec runuser -u node -- "$@"

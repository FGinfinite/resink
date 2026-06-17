#!/bin/sh

if [ "$(id -u)" -eq 0 ]; then
  # add the node user to the docker group on the host when a local socket is mounted
  if [ -e '/var/run/docker.sock' ]; then
    DOCKER_GROUP=$(stat -c '%g' /var/run/docker.sock)
    groupadd --non-unique --gid "${DOCKER_GROUP}" dockeronhost
    usermod -aG dockeronhost node
  else
    echo ">> docker socket not mounted, using remote Docker API"
  fi

  # compatibility: initial volume setup
  mkdir -p /overleaf/services/clsi/cache && chown node:node /overleaf/services/clsi/cache
  mkdir -p /overleaf/services/clsi/compiles && chown node:node /overleaf/services/clsi/compiles
  mkdir -p /overleaf/services/clsi/output && chown node:node /overleaf/services/clsi/output
  mkdir -p /overleaf/services/clsi/uploads && chown node:node /overleaf/services/clsi/uploads

  exec runuser -u node -- "$@"
fi

# Sibling compile containers may already run as the target user.
exec "$@"

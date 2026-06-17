#!/bin/sh

if [ "$(id -u)" -eq 0 ]; then
  # Named Docker volumes mount as root:root, overriding the build-time
  # chown in the Dockerfile. Fix ownership at runtime so the node user
  # can write to /buckets (chunks, blobs, zips, analytics, etc.).
  mkdir -p /buckets
  chown -R node:node /buckets

  exec runuser -u node -- "$@"
fi

# Already running as non-root (e.g. OpenShift), proceed directly.
exec "$@"

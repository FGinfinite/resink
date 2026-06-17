#!/bin/bash
set -e -o pipefail

# generate secrets and defines them as environment variables
# https://github.com/phusion/baseimage-docker#centrally-defining-your-own-environment-variables
#
# phusion/baseimage runit services do NOT inherit Docker env vars.
# They read from /etc/container_environment/ files instead.
# This script ensures Docker env vars are synced to those files,
# and only generates random secrets for values not provided.

WEB_API_PASSWORD_FILE=/etc/container_environment/WEB_API_PASSWORD
STAGING_PASSWORD_FILE=/etc/container_environment/STAGING_PASSWORD # HTTP auth for history-v1
V1_HISTORY_PASSWORD_FILE=/etc/container_environment/V1_HISTORY_PASSWORD
CRYPTO_RANDOM_FILE=/etc/container_environment/CRYPTO_RANDOM
OT_JWT_AUTH_KEY_FILE=/etc/container_environment/OT_JWT_AUTH_KEY
AI_PROXY_SECRET_FILE=/etc/container_environment/AI_PROXY_SECRET

generate_secret () {
  dd if=/dev/urandom bs=1 count=32 2>/dev/null | base64 -w 0 | rev | cut -b 2- | rev | tr -d '\n+/'
}

# sync_env_or_generate ENV_VAR_NAME FILE_PATH
# If Docker env var is set, write it to the file (preferred).
# Else if file already exists, keep it.
# Else generate a random secret.
sync_env_or_generate () {
  local env_name="$1"
  local file_path="$2"
  local env_value="${!env_name}"

  if [ -n "$env_value" ]; then
    printf '%s' "$env_value" > "$file_path"
  elif [ ! -f "$file_path" ]; then
    generate_secret > "$file_path"
  fi
}

sync_env_if_present () {
  local env_name="$1"
  local file_path="$2"
  local env_value="${!env_name}"

  if [ -n "$env_value" ]; then
    printf '%s' "$env_value" > "$file_path"
  fi
}

echo "syncing secrets from Docker env / generating missing secrets"

sync_env_or_generate WEB_API_PASSWORD "$WEB_API_PASSWORD_FILE"

sync_env_or_generate STAGING_PASSWORD "$STAGING_PASSWORD_FILE"
# V1_HISTORY_PASSWORD defaults to same as STAGING_PASSWORD
if [ -n "$V1_HISTORY_PASSWORD" ]; then
  printf '%s' "$V1_HISTORY_PASSWORD" > "$V1_HISTORY_PASSWORD_FILE"
elif [ ! -f "$V1_HISTORY_PASSWORD_FILE" ]; then
  cp "$STAGING_PASSWORD_FILE" "$V1_HISTORY_PASSWORD_FILE"
fi

sync_env_or_generate CRYPTO_RANDOM "$CRYPTO_RANDOM_FILE"
sync_env_or_generate OT_JWT_AUTH_KEY "$OT_JWT_AUTH_KEY_FILE"
sync_env_if_present AI_PROXY_SECRET "$AI_PROXY_SECRET_FILE"

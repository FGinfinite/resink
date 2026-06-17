#!/usr/bin/env bash
set -euo pipefail

. /etc/container_environment.sh

if [[ "${OVERLEAF_ENABLE_AI_ASSISTANT:-true}" != "true" ]]; then
  echo "AI Assistant disabled, skipping AI model seed"
  exit 0
fi

echo "Ensuring AI model configuration exists"
cd /overleaf/services/ai-writing-agent
/sbin/setuser www-data node scripts/seed-model-configs.js --if-missing --require-openai-env
echo "AI model configuration is ready"

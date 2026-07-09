#!/usr/bin/env bash
set -euo pipefail

treeish="HEAD"

usage() {
  cat <<'USAGE'
Usage: bin/check-public-cleanliness.sh [--treeish <ref>]

Checks a product branch tree for tracked secrets, private-key material, local
runtime leftovers, and unsafe public-sync inputs. This is intentionally scoped
to the product branch. The public branch sync step still removes internal
development documentation before publishing.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --treeish)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --treeish requires a value" >&2
        exit 2
      fi
      treeish="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

git rev-parse --verify "${treeish}^{tree}" >/dev/null

fail=0

report_failure() {
  echo "ERROR: $*" >&2
  fail=1
}

tracked_files=$(git ls-tree -r --name-only "$treeish")

sensitive_path_re='(^|/)(\.env|\.env\..*|id_rsa|id_dsa|id_ecdsa|id_ed25519|.*\.p12|.*\.pfx|credentials\.json|service-account.*\.json)$'
allowed_sensitive_path_re='(^|/)(\.env\.example|\.env\.sample|example\.env|develop/dev\.env|services/ai-writing-agent/test/fixtures/)'

while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  if [[ "$file" =~ $sensitive_path_re ]] && [[ ! "$file" =~ $allowed_sensitive_path_re ]]; then
    report_failure "tracked sensitive path: $file"
  fi
done <<< "$tracked_files"

runtime_leftover_re='(^|/)(node_modules|\.cache|\.yarn/install-state\.gz|develop/ai-sandbox-workspaces|services/ai-writing-agent/tmp|tmp)(/|$)'
while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  if [[ "$file" =~ $runtime_leftover_re ]]; then
    report_failure "tracked runtime leftover: $file"
  fi
done <<< "$tracked_files"

secret_hits=$(
  git grep -I -n -E \
    -e '-----BEGIN (RSA |DSA |EC |OPENSSH |)PRIVATE KEY-----' \
    -e 'sk-(proj-)?[A-Za-z0-9_-]{32,}' \
    -e 'AIza[0-9A-Za-z_-]{35}' \
    -e 'AKIA[0-9A-Z]{16}' \
    "$treeish" -- . || true
)

while IFS= read -r hit; do
  [[ -z "$hit" ]] && continue
  file=${hit#*:}
  file=${file%%:*}
  line=${hit#*:*:}

  case "$file" in
    services/web/test/acceptance/files/saml-key.pem|\
    services/web/test/unit/src/Exports/ExportsHandler.test.mjs)
      continue
      ;;
  esac

  if [[ "$line" =~ sk-(your-api-key|example|replace-me|\.\.\.) ]]; then
    continue
  fi

  report_failure "possible secret material in $file"
done <<< "$secret_hits"

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi

echo "public cleanliness: ok (${treeish})"

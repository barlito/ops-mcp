#!/usr/bin/env bash
# Usage: ensure-secret.sh <base-name> < value
# Swarm secrets are immutable: creates <base-name>_<sha1 of the value> once and prints that name.
set -euo pipefail
base=$1
value=$(cat)
[ -n "$value" ] || { echo "empty value for secret $base" >&2; exit 1; }
name="${base}_$(printf %s "$value" | sha1sum | cut -c1-10)"
docker secret inspect "$name" >/dev/null 2>&1 || printf %s "$value" | docker secret create "$name" - >/dev/null
echo "$name"

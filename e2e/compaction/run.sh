#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Dependencies and provider authentication must already be configured by the operator.
# No .env sourcing, key aliases, account copying, or installs occur here.
exec bun "$HERE/run.ts"

#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
# SPDX-License-Identifier: MIT

set -eu

required_node=v26.13.0
if ! command -v node >/dev/null 2>&1; then
  printf 'Node.js %s is required in PATH.\n' "${required_node#v}" >&2
  exit 1
fi
node_version=$(node --version)
if [[ "$node_version" != "$required_node" ]]; then
  printf 'Expected Node.js %s, found %s.\n' "$required_node" "$node_version" >&2
  exit 1
fi

repo_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
core_dist="$repo_root/packages/generator-core/dist"
if [[ ! -f "$core_dist/index.js" || ! -f "$core_dist/config/compiled-schema.js" ]]; then
  printf 'Generator Core is not built. Run bash %q first.\n' "$repo_root/scripts/setup.sh" >&2
  exit 1
fi

exec node "$repo_root/apps/cli/index.cjs" "$@"

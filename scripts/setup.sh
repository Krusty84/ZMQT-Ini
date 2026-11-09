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
if ! command -v npm >/dev/null 2>&1; then
  printf 'npm is required in PATH.\n' >&2
  exit 1
fi

repo_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd -- "$repo_root/packages/generator-core"
npm ci --include=dev
npm run build

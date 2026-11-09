# SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
# SPDX-License-Identifier: MIT

$PSNativeCommandUseErrorActionPreference = $false

$node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
if (-not $node) {
    [Console]::Error.WriteLine('Node.js 26.13.0 is required in PATH.')
    exit 1
}

$version = & $node.Path --version
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($version -cne 'v26.13.0') {
    [Console]::Error.WriteLine("Node.js 26.13.0 is required. Found $version.")
    exit 1
}

$npm = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue
if (-not $npm) {
    [Console]::Error.WriteLine('npm.cmd is required in PATH.')
    exit 1
}

$core = Join-Path $PSScriptRoot '..\packages\generator-core'
Push-Location -LiteralPath $core -ErrorAction Stop
try {
    & $npm.Path ci --include=dev
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & $npm.Path run build
    exit $LASTEXITCODE
} finally {
    Pop-Location
}

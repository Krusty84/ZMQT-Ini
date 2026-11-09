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

$core = Join-Path $PSScriptRoot '..\packages\generator-core'
if (-not (Test-Path -LiteralPath (Join-Path $core 'dist\index.js') -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $core 'dist\config\compiled-schema.js') -PathType Leaf)) {
    [Console]::Error.WriteLine('Build Generator Core with .\scripts\setup.ps1 from the repository root.')
    exit 1
}

$cli = Join-Path $PSScriptRoot '..\apps\cli\index.cjs'
& $node.Path $cli @args
exit $LASTEXITCODE

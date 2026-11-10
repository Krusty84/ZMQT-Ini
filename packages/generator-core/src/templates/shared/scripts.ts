/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import { textFile } from "../../artifacts/files";
import type { ApplicationPlan, GenerationPlan } from "../../planning/ir";

interface ScriptCommands {
  readonly build: readonly string[];
  run(app: ApplicationPlan): string;
  readonly windows:
    | "wsl"
    | {
        readonly build: readonly string[];
        readonly executable: string;
        args(app: ApplicationPlan): string;
      };
}

const bashHeader = `#!/usr/bin/env bash
set -eu
CDPATH= cd -- "$(dirname -- "$0")"
`;

function bashRun(bind: string, connect: string): string {
  return `${bashHeader}
bind_pid=
connect_pid=
log_pid=
scratch=$(mktemp -d)

running() {
    [[ -n "$1" ]] && kill -0 "$1" 2>/dev/null
}

cleanup() {
    trap '' INT TERM
    for pid in "$bind_pid" "$connect_pid"; do
        if running "$pid"; then kill -TERM "$pid" 2>/dev/null || :; fi
    done
    for ((attempt = 0; attempt < 20; attempt++)); do
        if ! running "$bind_pid" && ! running "$connect_pid"; then break; fi
        sleep 0.1
    done
    for pid in "$bind_pid" "$connect_pid"; do
        if running "$pid"; then kill -KILL "$pid" 2>/dev/null || :; fi
        if [[ -n "$pid" ]]; then wait "$pid" 2>/dev/null || :; fi
    done
    if [[ -n "$log_pid" ]]; then wait "$log_pid" || :; fi
    rm -f -- "$scratch/bind"
    rmdir -- "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Keep the Bind process waitable on Bash 3.2 while reading its startup event.
mkfifo "$scratch/bind"
${bind} > "$scratch/bind" &
bind_pid=$!
exec 3< "$scratch/bind"
line=
if IFS= read -r -t 10 -u 3 line; then
    printf '%s\\n' "$line"
else
    line=
fi
cat <&3 &
log_pid=$!
exec 3<&-

if [[ "$line" != '{"event":"READY"}' ]] || ! running "$bind_pid"; then
    printf '%s\\n' 'Bind did not become ready.' >&2
    if ! running "$bind_pid"; then wait "$bind_pid" || exit "$?"; fi
    exit 1
fi

${connect} &
connect_pid=$!
while running "$bind_pid" && running "$connect_pid"; do
    sleep 0.05
done

status=0
for pid in "$bind_pid" "$connect_pid"; do
    if ! running "$pid"; then wait "$pid" || status=$?; fi
done
exit "$status"
`;
}

const powerShellHeader = `$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
`;

function powerShellBuild(commands: readonly string[]): string {
  return `${powerShellHeader}
Push-Location -LiteralPath $PSScriptRoot
try {
    ${commands.join("\n    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n    ")}
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
`;
}

function powerShellRun(
  executable: string,
  bind: string,
  connect: string,
): string {
  return `${powerShellHeader}
$executable = ${executable}

function Start-App($commandArguments, [bool]$captureOutput) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $executable
    $info.Arguments = $commandArguments
    $info.WorkingDirectory = $PSScriptRoot
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $captureOutput
    if ($captureOutput) { $info.StandardOutputEncoding = [Text.Encoding]::UTF8 }
    [Diagnostics.Process]::Start($info)
}

$bind = $null
$connect = $null
$pending = $null
try {
    $bind = Start-App '${bind}' $true
    $pending = $bind.StandardOutput.ReadLineAsync()
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while (-not $pending.IsCompleted -and $timer.Elapsed.TotalSeconds -lt 10) {
        Start-Sleep -Milliseconds 20
    }
    if (-not $pending.IsCompleted) { throw 'Bind did not become ready within 10 seconds.' }
    $line = $pending.GetAwaiter().GetResult()
    $pending = $null
    if ($null -ne $line) { [Console]::WriteLine($line) }
    if ($line -cne '{"event":"READY"}' -or $bind.HasExited) {
        if ($bind.HasExited -and $bind.ExitCode -ne 0) { exit $bind.ExitCode }
        throw 'Bind did not become ready.'
    }

    $connect = Start-App '${connect}' $false
    $pending = $bind.StandardOutput.ReadLineAsync()
    while (-not $bind.HasExited -and -not $connect.HasExited) {
        if ($null -eq $pending -or -not $pending.IsCompleted) {
            Start-Sleep -Milliseconds 20
            continue
        }
        $line = $pending.GetAwaiter().GetResult()
        $pending = $null
        if ($null -ne $line) {
            [Console]::WriteLine($line)
            $pending = $bind.StandardOutput.ReadLineAsync()
        }
    }

    if ($bind.HasExited -and $bind.ExitCode -ne 0) { exit $bind.ExitCode }
    if ($connect.HasExited) { exit $connect.ExitCode }
    exit $bind.ExitCode
} finally {
    foreach ($app in @($bind, $connect)) {
        if ($null -eq $app) { continue }
        if (-not $app.HasExited) {
            try { $app.Kill() } catch { if (-not $app.HasExited) { throw } }
        }
        $app.WaitForExit()
    }
    if ($null -ne $bind) {
        if ($null -ne $pending) {
            $line = $pending.GetAwaiter().GetResult()
            if ($null -ne $line) { [Console]::WriteLine($line) }
        }
        [Console]::Write($bind.StandardOutput.ReadToEnd())
        $bind.Dispose()
    }
    if ($null -ne $connect) { $connect.Dispose() }
}
`;
}

function wslScript(script: string): string {
  return `${powerShellHeader}
wsl.exe --cd "$PSScriptRoot" --exec bash ./${script}
exit $LASTEXITCODE
`;
}

export function renderScripts(plan: GenerationPlan, commands: ScriptCommands) {
  const bind = plan.applications.find(({ endpoint }) => endpoint.mode === "bind")!;
  const connect = plan.applications.find(({ endpoint }) => endpoint.mode === "connect")!;
  const { windows } = commands;
  const [windowsBuild, windowsRun] = windows === "wsl"
    ? [wslScript("build.sh"), wslScript("run.sh")]
    : [
        powerShellBuild(windows.build),
        powerShellRun(windows.executable, windows.args(bind), windows.args(connect)),
      ];
  return [
    textFile("build.sh", `${bashHeader}\n${commands.build.join("\n")}\n`, true),
    textFile("run.sh", bashRun(commands.run(bind), commands.run(connect)), true),
    textFile("build.ps1", windowsBuild),
    textFile("run.ps1", windowsRun),
  ];
}

export const scriptUsage = `## Build and run both apps

Run the build script first. The run script starts both apps on the same host using \`config/zmq.json\`. It starts Connect after Bind reports \`READY\`. Use Ctrl+C to stop both apps.

### macOS and Linux

\`\`\`bash
./build.sh
./run.sh
\`\`\`

### Windows PowerShell

\`\`\`powershell
.\\build.ps1
.\\run.ps1
\`\`\`

## Build and run the apps separately on macOS and Linux`;

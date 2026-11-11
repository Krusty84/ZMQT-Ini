/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

export function advancedBashRun(
  header: string, apps: readonly (readonly [string, string])[], binaryStar: boolean,
): string {
  const allPids = '${pids[@]+"${pids[@]}"}';
  const allLogs = '${logs[@]+"${logs[@]}"}';
  return header + String.raw`
scratch=$(mktemp -d)
pids=()
logs=()

running() { kill -0 "$1" 2>/dev/null; }

cleanup() {
    trap '' INT TERM
    for pid in ${allPids}; do kill -TERM "$pid" 2>/dev/null || :; done
    for ((attempt = 0; attempt < 20; attempt++)); do
        alive=false
        for pid in ${allPids}; do if running "$pid"; then alive=true; fi; done
        if ! $alive; then break; fi
        sleep 0.1
    done
    for pid in ${allPids}; do
        kill -KILL "$pid" 2>/dev/null || :
        wait "$pid" 2>/dev/null || :
    done
    for pid in ${allLogs}; do wait "$pid" || :; done
    rm -rf -- "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

start_app() {
    case "$1" in
${apps.map(([role, command]) => "        " + role + ") exec " + command + " ;;").join("\n")}
    esac
}

for role in ${apps.map(([role]) => role).join(" ")}; do
    mkfifo "$scratch/$role"
    start_app "$role" > "$scratch/$role" &
    pid=$!
    pids+=("$pid")
    exec 3< "$scratch/$role"
    line=
    IFS= read -r -t 10 -u 3 line || line=
    cat <&3 &
    logs+=("$!")
    exec 3<&-
    if [[ -n "$line" ]]; then printf '%s\n' "$line"; fi
    if [[ "$line" != '{"event":"READY"}' ]] || ! running "$pid"; then
        printf '%s did not become ready.\n' "$role" >&2
        if ! running "$pid"; then wait "$pid" || exit "$?"; fi
        exit 1
    fi
done

while :; do
    ${binaryStar
      ? 'if ! running "${pids[2]}"; then wait "${pids[2]}"; exit $?; fi\n    if ! running "${pids[0]}" && ! running "${pids[1]}"; then exit 1; fi'
      : 'for pid in "${pids[@]}"; do\n        if ! running "$pid"; then wait "$pid"; exit $?; fi\n    done'}
    sleep 0.05
done
`;
}

export function advancedPowerShellRun(
  header: string, executable: string, args: readonly string[], binaryStar: boolean,
): string {
  return header + `$executable = ${executable}
$apps = @()

function Read-Output($entry) {
    if ($null -ne $entry.Read -and $entry.Read.IsCompleted) {
        $line = $entry.Read.GetAwaiter().GetResult()
        $entry.Read = $null
        if ($null -ne $line) {
            [Console]::WriteLine($line)
            $entry.Read = $entry.App.StandardOutput.ReadLineAsync()
        }
    }
}

try {
    foreach ($commandArguments in @(${args.map((value) => "'" + value + "'").join(", ")})) {
        $info = [Diagnostics.ProcessStartInfo]::new()
        $info.FileName = $executable
        $info.Arguments = $commandArguments
        $info.WorkingDirectory = $PSScriptRoot
        $info.UseShellExecute = $false
        $info.RedirectStandardOutput = $true
        $info.StandardOutputEncoding = [Text.Encoding]::UTF8
        $app = [Diagnostics.Process]::Start($info)
        $entry = @{ App = $app; Read = $app.StandardOutput.ReadLineAsync() }
        $apps += $entry
        $timer = [Diagnostics.Stopwatch]::StartNew()
        while (-not $entry.Read.IsCompleted -and $timer.Elapsed.TotalSeconds -lt 10) {
            foreach ($previous in $apps) {
                if ($previous.App.Id -ne $app.Id) { Read-Output $previous }
            }
            Start-Sleep -Milliseconds 20
        }
        if (-not $entry.Read.IsCompleted) { throw 'Application startup timed out.' }
        $line = $entry.Read.GetAwaiter().GetResult()
        $entry.Read = $null
        if ($null -ne $line) { [Console]::WriteLine($line) }
        if ($line -cne '{"event":"READY"}' -or $app.HasExited) {
            if ($app.HasExited -and $app.ExitCode -ne 0) { exit $app.ExitCode }
            throw 'Application did not become ready.'
        }
        $entry.Read = $app.StandardOutput.ReadLineAsync()
    }
    while ($true) {
        foreach ($entry in $apps) { Read-Output $entry }
        ${binaryStar
          ? "if ($apps[2].App.HasExited) { exit $apps[2].App.ExitCode }\n        if ($apps[0].App.HasExited -and $apps[1].App.HasExited) { exit 1 }"
          : "foreach ($entry in $apps) { if ($entry.App.HasExited) { exit $entry.App.ExitCode } }"}
        Start-Sleep -Milliseconds 20
    }
} finally {
    foreach ($entry in $apps) {
        if (-not $entry.App.HasExited) {
            try { $entry.App.Kill() } catch { if (-not $entry.App.HasExited) { throw } }
        }
        $entry.App.WaitForExit()
        while ($null -ne $entry.Read) {
            $null = $entry.Read.GetAwaiter().GetResult()
            Read-Output $entry
        }
        $entry.App.Dispose()
    }
}
`;
}

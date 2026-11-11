# ZMQT-Ini

Generate runnable ZeroMQ projects.

## What Is This?

The utility generates applications, build scripts, and tests for a ZeroMQ topology selected in JSON.

## Features

- Generate Python, C++, Java, and Node.js projects.
- Use REQ/REP, PUB/SUB, or PUSH/PULL over TCP.
- Pub-Sub Patterns: Espresso, Last Value Caching, Suicidal Snail, Black Box, Clone, or Binary Star to PUB/SUB.
- Build and run generated projects with Bash or PowerShell scripts.

## Who is it for?

For developers who need a working starting point for a ZeroMQ application.

## How to install

Install Node.js 26.13.0 with npm and put both on `PATH`. Run setup from the repository root after cloning the repository and after changes to Core source or dependencies.

**Windows PowerShell 5.1 or 7**

```powershell
.\scripts\setup.ps1
```

**macOS or Linux**

```bash
bash scripts/setup.sh
```

## How to use

### Generate a project

Use a UTF-8 JSON file that follows the [configuration schema](packages/generator-core/resources/config.schema.json). Choose a new output directory with an existing parent. Relative paths use your current directory. Run these commands from the repository root to generate the example in `out`.

**Windows PowerShell**

```powershell
.\scripts\generate.ps1 .\config.json .\out
```

**macOS or Linux**

```bash
node apps/cli/index.cjs ./config.json ./out
```

The CLI prints a project summary to standard output and sends errors and warnings to standard error. Scripts that parse JSON must pass `--json` before the configuration and output paths.

### Select advanced PUB/SUB patterns

Copy `config.json`, set `schemaVersion` to `"1.1"`, and replace its `messaging` object. This example enables tracing and caching on a proxy.

```json
{
  "pattern": "pub-sub",
  "transport": "tcp",
  "bindRole": "proxy",
  "bindHost": "127.0.0.1",
  "connectHost": "127.0.0.1",
  "port": 5555,
  "extensions": ["espresso", "last-value-caching"]
}
```

Combine `espresso`, `last-value-caching`, `suicidal-snail`, and `black-box`. Use `proxy` as the bind role for Espresso or caching and `pub` or `sub` for a direct stream.

Use `["clone"]` or `["clone", "binary-star"]` with the `server` bind role. Binary Star requires a `backup` object in `messaging` with its own `bindHost`, `connectHost`, and base `port`. See the [Core configuration guide](packages/generator-core/README.md#advanced-pubsub).

### Build and run the generated project

Install the tools listed in the generated README. On Windows, the C++ scripts build and run in the default Windows Subsystem for Linux (WSL) distribution. Install a C++23 compiler and CMake 3.24 or later in that distribution.

**Windows PowerShell**

```powershell
Set-Location .\out
.\build.ps1
.\run.ps1
```

**macOS or Linux**

```bash
cd ./out
./build.sh
./run.sh
```

The run script starts the applications in dependency order. Press Ctrl+C to stop them.

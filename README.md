# ZMQT-Ini

Generate runnable ZeroMQ projects.

## What Is This?

The utility generates two applications that implement ZMQ with one Bind role and one Connect role.

## Features

- Generate Python, C++, Java, and Node.js projects.
- Use REQ/REP, PUB/SUB, or PUSH/PULL over TCP.
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

The run script starts both applications. Press Ctrl+C to stop them.

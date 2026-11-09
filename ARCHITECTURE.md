# ZMQT-Ini architecture

## Overview

`@zmqt-ini/generator-core` is a synchronous Node.js library. It turns a project configuration into an in-memory manifest and a list of files. The CLI writes those files. The generated applications open ZeroMQ sockets when they run.

## Repository structure

| Location | Responsibility |
| --- | --- |
| [packages/generator-core](packages/generator-core) | Public API, configuration checks, planning, code generation, and output validation. |
| [apps/cli](apps/cli) | Reads a UTF-8 JSON configuration and calls the package API. It writes to a new directory and attempts to remove its output if a write fails. |
| [scripts](scripts) | Bash and PowerShell entry points. `setup` installs Core build dependencies and builds the package. `generate` passes the input and output paths to the CLI. |
| [config.json](config.json) | Example CLI input for Python REQ/REP over loopback TCP. |
| [tests/generated-project-ci](tests/generated-project-ci) | Builds and runs generated applications over loopback TCP. |
| [tests/host-parity](tests/host-parity) | Compares the direct API, the CLI, and an in-process Web test host. |

## Data flow

1. [validateConfig](packages/generator-core/src/validation/config.ts) copies input data, checks it against the [JSON Schema](packages/generator-core/resources/config.schema.json), and checks addresses, roles, and socket options. [getCapabilities](packages/generator-core/src/catalog/capabilities.ts) describes the supported combinations and versions.
2. The [planner](packages/generator-core/src/planning/build.ts) uses the [pattern registry](packages/generator-core/src/patterns/registry.ts) and [topology compiler](packages/generator-core/src/topology/compiler.ts) to assign one Bind role and one Connect role. Each role gets a socket type, an endpoint, and applicable options. The planner adds a lifecycle and a behavior graph for each application.
3. The [IR validator](packages/generator-core/src/planning/validate.ts) checks the `GenerationPlan`. Its [behavior checks](packages/generator-core/src/planning/validate-behavior.ts) cover transitions, variable use, shutdown paths, and socket operation order. [inspectProject](packages/generator-core/src/public/inspect.ts) returns a topology summary from the checked plan.
4. [generateProject](packages/generator-core/src/public/generate.ts) selects a built-in [language adapter](packages/generator-core/src/adapters). The [assembler](packages/generator-core/src/artifacts/assemble.ts) checks the plan against that adapter's capabilities before emission. Adapters turn behavior graphs into state-machine code and add runtime code, a codec, build files, tests, and a README.
5. The assembler normalizes line endings, sorts the file paths, and runs the [Output Validator](packages/generator-core/src/artifacts/validate.ts). The validator checks the layout, runtime configuration, source markers, dependency declarations, and size. On success, the assembler returns `GeneratedProject`.

## Key design decisions

- The [package entry point](packages/generator-core/src/index.ts) exports four operations and their result types. The plan, behavior graphs, and adapter interfaces are internal.
- Planning owns the roles and behavior. Adapters render the checked plan in the target language. The same plan supplies the topology summary and the generated files.

## Generated runtime

Each project has two applications for REQ/REP, PUB/SUB, or PUSH/PULL over TCP. Both read `config/zmq.json` for hosts, the port, and socket options. The [runtime templates](packages/generator-core/src/templates) handle DNS, socket setup, message exchange, and cleanup. The codecs use single-frame UTF-8 JSON. The `READY` event reports local socket setup. The integration runner checks delivery through a received response, event, or task result.

## Dependencies and validation

TypeScript builds the package. A [build script](packages/generator-core/scripts/compile-schema.cjs) uses Ajv to emit a standalone validator. The npm package has zero runtime dependencies. Generated projects use separate ZeroMQ libraries for Python, C++, Java, and Node.js. Their adapters emit the pinned build files.

The `generate` scripts require the Core build. Relative input and output paths use the caller's working directory. See the [repository README](README.md) for setup and launch commands.

The [CI workflow](.github/workflows/generator-core-ci.yml) runs package and host tests first. It then builds and runs 24 generated configurations, with two Bind orientations for each language and pattern. Golden tests compare output hashes. Architecture tests check the installed package in a restricted Node.js process. See the [package README](packages/generator-core/README.md) for commands and toolchain versions.

## Known constraints

- Output checks use static markers. Integration tests compile and run the applications. The validator checks primary library versions from the plan and toolchain versions from the catalog where build files declare them. Build templates pin the other dependencies.
- Generated C++ applications target POSIX. Generated Java applications use `sun.misc.Signal` for shutdown on the pinned JDK.

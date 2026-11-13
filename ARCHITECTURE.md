# ZMQT-Ini architecture

## Overview

ZMQT-Ini is a project initializer for ZeroMQ applications, not a messaging server or broker. Its goal is to turn a declarative JSON configuration into a small, runnable, understandable project with correct ZeroMQ topology, socket lifecycle, message handling, dependencies, tests, and documentation. Generated code must remain usable and editable without ZMQT-Ini.
The long-term goal is one reusable generation engine with multiple independent clients: a CLI (already present), a possible VS Code extension, and a possible Web application/API. New clients must not duplicate the rules for ZeroMQ or the code-generation logic.

The independent TypeScript/Node.js package @zmqt-ini/generator-core implements the business logic for Python, C++, Java, and Node.js. Schema 2.0 selects basic REQ/REP, PUB/SUB, or PUSH/PULL over TCP with two applications and one frame per message. The presence of `messaging.extensions` selects advanced PUB/SUB. Application messages use UTF-8 JSON by default. `messaging.serialization` can select CBOR for basic patterns and advanced PUB/SUB events. Generated projects include runtime configuration, pinned dependencies, build instructions, tests, and a README.

The public API is getCapabilities(), validateConfig(), inspectProject(), and generateProject(). Calls are synchronous. Core returns diagnostics and an in-memory GeneratedProject (manifest plus virtual files), it does not write files, create ZIP archives, start processes, make network calls, or depend on UI frameworks. Those operations belong to clients/hosts.

The generation pipeline is:

JSON config → validation and capabilities → topology and lifecycle → behavior IR → IR validation → language adapter → output validation → GeneratedProject

Pattern definitions own ZeroMQ behavior, language adapters translate validated operations into language-specific code. A new pattern should not require changes to existing adapters unless it introduces new IR operations.

## Repository structure

| Location                                                 | Responsibility                                                                                                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [packages/generator-core](packages/generator-core)       | Public API, configuration checks, planning, code generation, and output validation.                                                                                      |
| [apps/cli](apps/cli/index.cjs)                           | Reads UTF-8 JSON and calls Core. It writes to a new directory, sets file modes from the `executable` flags, and attempts to remove partial output after a write failure. |
| [scripts](scripts)                                       | Bash and PowerShell entry points. `setup` installs Core build dependencies and builds the package. `generate` forwards its arguments to the CLI.                         |
| [config.json](config.json)                               | Example CLI input for Python REQ/REP over loopback TCP.                                                                                                                  |
| [tests/generated-project-ci](tests/generated-project-ci) | Builds and runs generated applications over loopback TCP.                                                                                                                |
| [tests/host-parity](tests/host-parity)                   | Compares results from Core, the CLI in JSON mode, and an in-process Web test host. It also checks CLI files and text output.                                             |

## Data flow

1. [validateConfig](packages/generator-core/src/validation/config.ts) copies input data, checks it against the [JSON Schema](packages/generator-core/resources/config.schema.json), and checks addresses, roles, and socket options. [getCapabilities](packages/generator-core/src/catalog/capabilities.ts) describes the supported combinations and versions.
2. The [planner](packages/generator-core/src/planning/build.ts) uses the [pattern registry](packages/generator-core/src/patterns/registry.ts) and [topology compiler](packages/generator-core/src/topology/compiler.ts) to assign one Bind role and one Connect role. Each role gets a socket type, an endpoint, and applicable options. The planner adds a lifecycle and a behavior graph for each application.
3. The [IR validator](packages/generator-core/src/planning/validate.ts) checks the `GenerationPlan`. Its [behavior checks](packages/generator-core/src/planning/validate-behavior.ts) cover transitions, variable use, shutdown paths, and socket operation order. [inspectProject](packages/generator-core/src/public/inspect.ts) returns a topology summary from the checked plan.
4. [generateProject](packages/generator-core/src/public/generate.ts) selects a built-in [language adapter](packages/generator-core/src/adapters). The [assembler](packages/generator-core/src/artifacts/assemble.ts) checks the plan against the adapter's capabilities. The adapter renders behavior graphs as state machines and emits runtime code, codecs, build files, scripts, tests, and the README.
5. The assembler normalizes line endings, sorts paths, and runs the [Output Validator](packages/generator-core/src/artifacts/validate.ts). The validator checks required paths, executable flags, runtime configuration, source markers, dependency declarations, and size.

For advanced PUB/SUB, the planner records the applications in launch order, names each socket, and defines the Binary Star transitions. The renderer emits those plans and the native runtime for the selected language. [PUB/SUB planner](packages/generator-core/src/planning/pub-sub.ts) · [Advanced source renderer](packages/generator-core/src/adapters/advanced.ts)

## Key design decisions

- The [package entry point](packages/generator-core/src/index.ts) exports four operations and their result types. The plan, behavior graphs, and adapter interfaces are internal.
- Planning owns the roles and behavior. Adapters render the checked plan in the target language. The same plan supplies the topology summary and the generated files.
- The CLI formats Core results. By default, it writes a project summary to `stdout` and diagnostics to `stderr`. With `--json` before the paths, it writes `{manifest, diagnostics}` to `stdout` on success and `{diagnostics}` to `stderr` on failure. Both modes return `0` on success and `1` on failure.

## Generated runtime

Each application reads `config/zmq.json` for TCP endpoints and socket options. The [runtime templates](packages/generator-core/src/templates) handle DNS, socket setup, message exchange, and cleanup. Advanced PUB/SUB uses multipart topic and event messages. Clone uses the [12/CHP](https://rfc.zeromq.org/spec/12/) frames for snapshots and binary values. `READY` reports local socket setup.

Both profiles share one socket option schema. Core assigns optional reconnect settings to TCP connect sockets and heartbeat and frame limits to all TCP sockets. The runtimes apply configured values before opening each endpoint. [Socket option rules](packages/generator-core/src/config/socket-options.ts)

### Integration comments

Each adapter looks up role comments by socket type and state ID. It writes them at the start of the state branch in the target language's comment syntax. The comments show where to supply application data or call handlers. [Shared role comments](packages/generator-core/src/templates/shared/role-comments.ts)

Comments in the runtime templates explain socket options, timeouts, and errors. They show where to use the application's configuration, logger, and shutdown hook.

### Generated project scripts

Adapters supply build and launch commands to the [shared script template](packages/generator-core/src/templates/shared/scripts.ts). It emits `build.sh`, `run.sh`, `build.ps1`, and `run.ps1`. Each script runs from the generated project root.

The run script starts the applications on the same host in plan order. Each startup check expects `READY` on the first stdout line within 10 seconds. For Binary Star, the launcher keeps the client and the surviving server running after a server exits. Ctrl+C stops the local applications.

## Dependencies and validation

TypeScript builds the package. A [build script](packages/generator-core/scripts/compile-schema.cjs) uses Ajv to emit standalone validators. The npm package has zero runtime dependencies. Generated projects use separate ZeroMQ libraries for Python, C++, Java, and Node.js. Their adapters emit the pinned build files.

The `generate` scripts require the Core build. Relative input and output paths use the caller's working directory. See the [repository README](README.md) for setup and launch commands.

The [CI workflow](.github/workflows/generator-core-ci.yml) runs Core and host-parity tests on Linux. [Launcher tests](packages/generator-core/tests/unit/scripts.test.cjs) use test apps to check startup order, exit status, and cleanup. The integration job builds and runs 24 basic configurations and 36 advanced PUB/SUB configurations. The advanced suite checks Clone with independent 12/CHP peers. Architecture tests check the installed package in a restricted Node.js process. See the [package README](packages/generator-core/README.md) for commands and toolchain versions.

The manifest records the adapter's `templateVersion` and `dependencySetVersion`. Golden tests hash the manifest and generated files, including source comments. Role comment tests check that selected comments appear at the start of the expected state and in the correct role. [Manifest assembly](packages/generator-core/src/artifacts/assemble.ts), [golden tests](packages/generator-core/tests/golden/project.test.cjs), [role comment tests](packages/generator-core/tests/unit/role-comments.test.cjs)

## Known constraints

- Output checks use static markers. Integration tests compile and run the applications. The validator checks primary library versions from the plan and toolchain versions from the catalog where build files declare them. Build templates pin the other dependencies.
- Generated C++ applications target POSIX. Their PowerShell scripts call Bash in the default WSL distribution.
- Generated Java applications use `sun.misc.Signal` for shutdown on the pinned JDK.

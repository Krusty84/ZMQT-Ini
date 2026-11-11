# Generator Core

`@zmqt-ini/generator-core` validates, inspects, and generates declarative ZeroMQ projects in Node.js. Core calls are synchronous and return data. The host handles file I/O, packaging, and execution.

```ts
import { generateProject, getCapabilities, inspectProject, validateConfig } from "@zmqt-ini/generator-core";

const catalog = getCapabilities();
const result = validateConfig(input);
if (result.ok) {
  const normalized = result.value;
  const summary = inspectProject(normalized);
  const project = generateProject(normalized);
}
```

`getCapabilities()` returns the supported languages, patterns, bind roles, transports, and socket option ranges. `validateConfig(input)` takes a JSON data object and returns `ValidationResult`. The `ok` discriminator indicates whether `value` is available. `diagnostics` is present in both cases.

`inspectProject(input)` returns the checked project name, language, pattern, and socket endpoints. For schema 1.1, it also returns the selected extensions and the socket name for each endpoint.

`generateProject(input)` returns a versioned `manifest` and sorted `files`. The files have relative POSIX paths, UTF-8 text, and an `executable` flag for the host. The Core validates its internal plan before emission and checks the final paths, required files, and aggregate limit of 2,097,152 UTF-8 bytes.

The package includes [JSON Schema v1.0](resources/config.schema.json) for basic patterns. The limit is 32,768 UTF-8 bytes of compact JSON. Supply IPv4, bare IPv6, or a DNS name without a port. Bind also accepts `*`. Connect requires a destination address.

## Advanced PUB/SUB

Use [JSON Schema v1.1](resources/config-1.1.schema.json) with `pattern: "pub-sub"` and a nonempty `messaging.extensions` array. `getCapabilities().pubSubExtensions` lists the supported combinations and bind roles. Generation records the selection in `manifest.extensions`.

| Selection | Bind role | Ports and options |
| --- | --- | --- |
| Espresso or Last Value Caching, with any other stream extension | `proxy` | `P` for publishers, `P+1` for subscribers |
| Suicidal Snail or Black Box on a direct stream | `pub` or `sub` | `P`; `maxAgeMs` sets the Snail limit and defaults to 1000 ms |
| Clone | `server` | `P` for snapshots, `P+1` for updates, `P+2` for client writes |
| Clone with Binary Star | `server` | The three Clone ports and `P+3` for server coordination at each endpoint |

Clone accepts a `messaging.subtree` prefix such as `/stocks/`. The default empty prefix selects the whole map. For Binary Star, supply `messaging.backup` with `bindHost`, `connectHost`, and `port`. Use disjoint four-port ranges when both servers run on one host. Clone's client sockets use [12/CHP](https://rfc.zeromq.org/spec/12/).

Use diagnostic `code`, `path`, and `params` for machine handling. `path` is a JSON Pointer. The empty pointer denotes the root. Diagnostics sort by `path`, then by `code`. Warnings permit a successful result.

| Codes | Parameters when present |
| --- | --- |
| `INVALID_JSON_INPUT`, `MISSING_FIELD`, `UNKNOWN_FIELD` | |
| `INVALID_TYPE` | `expected` |
| `UNSUPPORTED_SCHEMA_VERSION`, `UNSUPPORTED_LANGUAGE`, `UNSUPPORTED_PATTERN`, `UNSUPPORTED_TRANSPORT` | |
| `INVALID_PROJECT_NAME`, `PROJECT_NAME_TOO_LONG` | `maxLength` for `PROJECT_NAME_TOO_LONG` |
| `VALUE_BELOW_MINIMUM`, `VALUE_ABOVE_MAXIMUM` | `min` or `max` |
| `INPUT_TOO_LARGE` | `maxBytes` |
| `INVALID_BIND_ROLE`, `INVALID_HOST`, `UNSPECIFIED_CONNECT_HOST` | `pattern` for `INVALID_BIND_ROLE` |
| `MISSING_EXTENSION`, `TOO_MANY_EXTENSIONS`, `UNSUPPORTED_EXTENSION`, `DUPLICATE_EXTENSION`, `INCOMPATIBLE_EXTENSIONS`, `INACTIVE_EXTENSION_OPTION`, `INVALID_SUBTREE`, `PORT_RANGE_OVERFLOW`, `OVERLAPPING_PORT_RANGES` | |
| `UNENCRYPTED_EXTERNAL_BIND`, `PUB_SUB_MESSAGE_LOSS`, `ZERO_LINGER`, `INACTIVE_SOCKET_OPTION` | `role` for `INACTIVE_SOCKET_OPTION` |

The catalog uses stable releases available on 9 November 2026. Generated-project compatibility is tested with the corresponding adapter.

| Language version | Library ID and version | Release sources |
| --- | --- | --- |
| Python 3.15.2 | `pyzmq` 27.3.0 | [Python](https://www.python.org/downloads/release/python-3152/), [PyPI](https://pypi.org/project/pyzmq/27.3.0/) |
| C++23 | `cppzmq` 4.11.0 | [ISO](https://www.iso.org/standard/83626.html), [cppzmq](https://github.com/zeromq/cppzmq/releases/tag/v4.11.0) |
| Java 27.0.1 | `jeromq` 0.6.0 | [JDK](https://www.oracle.com/java/technologies/javase/27-0-1-relnotes.html), [Maven Central](https://central.sonatype.com/artifact/org.zeromq/jeromq/0.6.0) |
| Node.js 26.13.0 | `zeromq` 6.5.0 | [Node.js](https://nodejs.org/en/blog/release/v26.13.0), [zeromq.js](https://github.com/zeromq/zeromq.js/releases/tag/v6.5.0) |

Run `npm ci` and `npm test` from this directory to build and test the package.

Run the generated-project integration matrix from the repository root after building Core.

```sh
node --test tests/generated-project-ci/*.test.cjs
node --test tests/advanced-pub-sub-ci/*.test.cjs
```

The matrix uses the versions in the catalog, a C++23 compiler, CMake, and Maven. Set `ZMQT_PYTHON` to the Python interpreter with pinned PyZMQ, `ZMQT_NODE` to the Node.js executable, and `ZMQT_JAVA_HOME` to the JDK if they are outside the default PATH. The runner builds projects in temporary directories and uses loopback TCP. Golden and concurrent generation tests run through `npm test`. The p95 reference is macOS 27.0.1 arm64 with Node.js 26.13.0.

Use the repository CLI host to write a generated project to a new directory.

```sh
node apps/cli/index.cjs config.json output-directory
node --test tests/host-parity/parity.test.cjs
```

The CLI prints a text summary by default. Scripts that parse JSON must pass `--json` before the configuration and output paths. The host parity test uses `--json` to compare the files and metadata from the CLI, direct API use, and a Web API test host.

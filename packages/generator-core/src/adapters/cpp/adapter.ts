/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import { runtimeConfigFile, textFile } from "../../artifacts/files";
import { p0LanguageCapabilities } from "../../catalog/capabilities";
import { renderCppBuild } from "../../templates/cpp/build";
import { cppCodec, cppCodecHeader } from "../../templates/cpp/codec";
import { cppRuntime, cppRuntimeHeader } from "../../templates/cpp/runtime";
import { cborReadme } from "../../templates/shared/cbor";
import { renderIntegrationTest } from "../../templates/shared/integration";
import { renderScripts, scriptUsage } from "../../templates/shared/scripts";
import type { LanguageAdapter } from "../types";
import { renderCppApplication } from "./behavior";

const entryPoint = (role: string) => `app_${role}.cpp`;

export const cppAdapter: LanguageAdapter = {
  id: "cpp",
  templateVersion: "1.5.0",
  dependencySetVersion: "1.0.0",
  layout: {
    entryPoint,
    executableEntries: false,
    supportFiles: [
      "CMakeLists.txt",
      "message_codec.cpp",
      "message_codec.hpp",
      "zmqt_runtime.cpp",
      "zmqt_runtime.hpp",
    ],
  },
  capabilities: p0LanguageCapabilities,
  generate(plan) {
    const cbor = plan.project.serialization === "cbor";
    return [
      ...plan.applications.map((application) =>
        textFile(
          entryPoint(application.role),
          renderCppApplication(application, cbor),
        ),
      ),
      textFile("message_codec.hpp", cppCodecHeader(cbor)),
      textFile("message_codec.cpp", cppCodec(cbor)),
      textFile("zmqt_runtime.hpp", cppRuntimeHeader),
      textFile("zmqt_runtime.cpp", cppRuntime(cbor)),
    ];
  },
  generateBuildFiles(plan) {
    const cppzmqVersion = plan.dependencies.find(
      ({ id }) => id === "cppzmq",
    )!.version;
    return [
      textFile(
        "CMakeLists.txt",
        renderCppBuild(
          plan.project.name,
          cppzmqVersion,
          plan.applications.map(({ role }) => role),
          plan.irVersion === "1.1",
          plan.dependencies.find(({ id }) => id === "libcbor")?.version,
        ),
      ),
      ...renderScripts(plan, {
        build: [
          "cmake -S . -B build -DCMAKE_BUILD_TYPE=Release",
          "cmake --build build",
        ],
        run: ({ role }) => `./build/app_${role}`,
        windows: "wsl",
      }),
    ];
  },
  generateRuntimeConfig(plan) {
    return [runtimeConfigFile(plan)];
  },
  generateTests(plan) {
    const commands = Object.fromEntries(
      plan.applications.map(({ role }) => [role, [`build/app_${role}`]]),
    );
    const bindRole = plan.topology.roles.find(
      ({ endpoint }) => endpoint.mode === "bind",
    )!.role;
    return [
      textFile(
        "tests/integration_test.py",
        renderIntegrationTest(commands, plan.project.pattern, bindRole, plan.project.serialization === "cbor"),
      ),
    ];
  },
  generateReadme(plan) {
    const bind = plan.topology.roles.find(
      ({ endpoint }) => endpoint.mode === "bind",
    )!;
    const connect = plan.topology.roles.find(
      ({ endpoint }) => endpoint.mode === "connect",
    )!;
    return textFile(
      "README.md",
      `# ${plan.project.name}

This project runs the ${plan.project.pattern} pattern over TCP. Use a C++23 compiler and CMake 3.24 or later. CMake can fetch the pinned dependency releases during configuration.

On Windows, install these tools in the default WSL distribution. The PowerShell scripts build and run the project in WSL.

${scriptUsage}

\`\`\`sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
\`\`\`

From the project directory, start the Bind app. Then start the Connect app in another terminal.

\`\`\`sh
./build/app_${bind.role}
./build/app_${connect.role}
\`\`\`

Edit \`config/zmq.json\` to change TCP hosts, the port, or socket options. Each app also accepts \`--config PATH\`.
\`READY\` confirms that the local socket started. PUB/SUB can lose messages before a subscription reaches the publisher or when queues fill.
Use Ctrl+C to stop a running app.
${plan.project.serialization === "cbor" ? "\n" + cborReadme + "\n" : ""}
After the build, run the integration test with both apps and a temporary loopback port.

\`\`\`sh
python3 tests/integration_test.py
\`\`\`
`,
    );
  },
};

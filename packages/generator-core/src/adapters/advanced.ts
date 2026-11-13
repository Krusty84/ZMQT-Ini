/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import { textFile } from "../artifacts/files";
import { getCapabilities } from "../catalog/capabilities";
import { executionSpec, type PubSubPlan } from "../planning/pub-sub";
import { cppAdvanced, cppAdvancedEntry, cppAdvancedHeader, cppStream } from "../templates/cpp/advanced";
import { cppClone } from "../templates/cpp/clone";
import { cppCodec, cppCodecHeader } from "../templates/cpp/codec";
import { cppAdvancedBase } from "../templates/cpp/runtime";
import { javaAdvanced, javaAdvancedImports, javaStream } from "../templates/java/advanced";
import { javaJarPath } from "../templates/java/build";
import { javaClone } from "../templates/java/clone";
import { javaCodec } from "../templates/java/codec";
import { javaAdvancedBase } from "../templates/java/runtime";
import { nodeAdvanced, nodeStream } from "../templates/node/advanced";
import { nodeClone } from "../templates/node/clone";
import { renderNodeCodec } from "../templates/node/codec";
import { nodeAdvancedBase } from "../templates/node/runtime";
import { pythonAdvanced, pythonStream } from "../templates/python/advanced";
import { pythonClone } from "../templates/python/clone";
import { renderPythonCodec } from "../templates/python/codec";
import { pythonAdvancedBase } from "../templates/python/runtime";
import { renderAdvancedIntegration } from "../templates/shared/advanced-integration";
import { cborReadme } from "../templates/shared/cbor";
import type { ArtifactLayout } from "./types";

export function renderAdvancedEntry(plan: PubSubPlan, role: string): string {
  const spec = executionSpec(plan, role);
  const program = plan.messaging.extensions.includes("clone") ? "clone" : "stream";
  switch (plan.project.language) {
    case "python":
      return `#!/usr/bin/env python3
from zmqt_runtime import run_advanced, ${program}_program


if __name__ == "__main__":
    raise SystemExit(run_advanced(${JSON.stringify(spec)}, ${program}_program))
`;
    case "node":
      return `#!/usr/bin/env node
import { runAdvanced, ${program}Program } from "./zmqt_runtime.mjs";

process.exitCode = await runAdvanced(${spec}, ${program}Program);
`;
    case "cpp":
      return `#include "zmqt_runtime.hpp"

int main(int argc, char* argv[]) {
    return zmqt::run_advanced(argc, argv, R"zmqt(${spec})zmqt");
}
`;
    case "java":
      return `public final class App${role.toUpperCase()} {
    public static void main(String[] args) {
        System.exit(ZmqtRuntime.runAdvanced(args, ${JSON.stringify(spec)}));
    }
}
`;
  }
}

export function generateAdvancedSources(plan: PubSubPlan, layout: ArtifactLayout) {
  const clone = plan.messaging.extensions.includes("clone");
  const cbor = plan.project.serialization === "cbor";
  const support = {
    python: () => [
      textFile("message_codec.py", renderPythonCodec(cbor)),
      textFile("zmqt_runtime.py", pythonAdvancedBase(cbor) + pythonAdvanced(cbor) + (clone ? pythonClone : pythonStream(cbor))),
    ],
    node: () => [
      textFile("message_codec.mjs", renderNodeCodec(cbor)),
      textFile("zmqt_runtime.mjs", nodeAdvancedBase(cbor) + nodeAdvanced(cbor) + (clone ? nodeClone : nodeStream(cbor))),
    ],
    cpp: () => [
      textFile("message_codec.hpp", cppCodecHeader(cbor)),
      textFile("message_codec.cpp", cppCodec(cbor)),
      textFile("zmqt_runtime.hpp", cppAdvancedHeader),
      textFile("zmqt_runtime.cpp", cppAdvancedBase(cbor) + cppAdvanced(cbor) + (clone ? cppClone : cppStream(cbor)) + cppAdvancedEntry),
    ],
    java: () => [
      textFile("src/main/java/MessageCodec.java", javaCodec(cbor)),
      textFile("src/main/java/ZmqtRuntime.java",
        javaAdvancedImports + javaAdvancedBase + javaAdvanced(cbor) + (clone ? javaClone : javaStream(cbor)) + "}\n"),
    ],
  };
  return [
    ...plan.applications.map(({ role }) =>
      textFile(layout.entryPoint(role), renderAdvancedEntry(plan, role), layout.executableEntries)),
    ...support[plan.project.language](),
  ];
}

export function generateAdvancedDocsAndTest(plan: PubSubPlan) {
  const { extensions } = plan.messaging;
  const cbor = plan.project.serialization === "cbor";
  const eventFrame = cbor ? "CBOR" : "UTF-8 JSON";
  const language = plan.project.language;
  const { languageVersion } = getCapabilities().languages.find(({ id }) => id === language)!;
  const requirements = {
    python: `Install Python ${languageVersion}. Put python3 on PATH on macOS or Linux and python.exe on PATH on Windows.`,
    cpp: "Install a C++23 compiler and CMake 3.24 or later. On Windows install both in the default WSL distribution.",
    java: `Install JDK ${languageVersion} and Maven 3.9. Set JAVA_HOME to the JDK directory.`,
    node: `Install Node.js ${languageVersion} with npm and put both on PATH.`,
  }[language];
  const command = {
    python: (role: string) => ["python", `app_${role}.py`],
    node: (role: string) => ["node", `app_${role}.mjs`],
    cpp: (role: string) => [`./build/app_${role}`],
    java: (role: string) => ["java", "-cp", javaJarPath, `App${role.toUpperCase()}`],
  }[language];
  const roles = plan.applications.map(({ role }) => role);
  const commands = Object.fromEntries(roles.map((role) => [role, command(role)]));
  const notes = [
    !extensions.includes("clone") && `Each publication has a topic frame and a ${eventFrame} event frame.`,
    cbor && cborReadme,
    extensions.includes("espresso") && "The proxy logs CAPTURE records with the direction and hexadecimal frames.",
    extensions.includes("last-value-caching") && "The proxy keeps one publication per topic. A subscription replays every matching topic to all subscribers that match it.",
    extensions.includes("suicidal-snail") && `Suicidal Snail inserts an eight-byte big-endian Unix timestamp in milliseconds between the topic and the ${cbor ? "CBOR" : "JSON"}. Synchronize publisher and subscriber clocks. Set maxAgeMs in config/zmq.json. Cache replay uses the replay time.`,
    extensions.includes("black-box") && "The subscriber has two workers. Add application processing to the event handler. Work can finish in a different order from arrival.",
    extensions.includes("clone") && "Clone uses 12/CHP. At base port P, DEALER requests a snapshot from ROUTER. The client SUB receives updates on P+1 and its PUB sends writes to the collector on P+2. Values are byte strings and an empty value deletes a key. The demo publishes one write with a UUID. Set subtree in config/zmq.json to an empty string or a prefix such as /demo/.",
    extensions.includes("binary-star") && "Configure the backup hosts and base port under backup. P+3 carries server state and replication. Start both servers for the initial election. After failover, start the old server with the same configuration to synchronize it as passive. The servers keep state in memory.",
  ].filter(Boolean).join("\n\n");
  return [
    textFile("README.md", `# ${plan.project.name}

This project runs the pub-sub pattern over TCP using ${language} with ${extensions.join(", ")}.

${requirements}

Run ./build.sh and ./run.sh on macOS or Linux. On Windows use .\\build.ps1 and .\\run.ps1. The scripts start the applications in dependency order. READY confirms local socket setup.

Run the applications separately from the project root for a deployment across hosts.

\`\`\`sh
${roles.map((role) => language === "python" ? ".venv/bin/" + commands[role].join(" ") : commands[role].join(" ")).join("\n")}
\`\`\`

Edit config/zmq.json to set the TCP hosts, base ports and socket options. Each application also accepts --config PATH. Use Ctrl+C to stop the local launcher.

${notes}

After building, run ${language === "python" ? ".venv/bin/python" : "python3"} tests/integration_test.py to check the applications on loopback.
`),
    textFile("tests/integration_test.py", renderAdvancedIntegration(commands, extensions, plan.behavior.portCount, cbor)),
  ];
}

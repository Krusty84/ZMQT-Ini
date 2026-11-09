/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import { runtimeConfigFile, textFile } from "../../artifacts/files";
import {
  getCapabilities,
  p0LanguageCapabilities,
} from "../../catalog/capabilities";
import { javaJarPath, renderPom } from "../../templates/java/build";
import { javaCodec } from "../../templates/java/codec";
import { javaRuntime } from "../../templates/java/runtime";
import { renderIntegrationTest } from "../../templates/shared/integration";
import type { LanguageAdapter } from "../types";
import { renderJavaApplication } from "./behavior";

const javaVersion = getCapabilities().languages.find(
  ({ id }) => id === "java",
)!.languageVersion;
const javaRelease = javaVersion.split(".")[0];
const entryPoint = (role: string) =>
  `src/main/java/App${role.toUpperCase()}.java`;

export const javaAdapter: LanguageAdapter = {
  id: "java",
  templateVersion: "1.0.0",
  dependencySetVersion: "1.0.0",
  layout: {
    entryPoint,
    executableEntries: false,
    supportFiles: [
      "pom.xml",
      "src/main/java/MessageCodec.java",
      "src/main/java/ZmqtRuntime.java",
    ],
  },
  capabilities: p0LanguageCapabilities,
  generate(plan) {
    return [
      ...plan.applications.map((application) =>
        textFile(
          entryPoint(application.role),
          renderJavaApplication(application),
        ),
      ),
      textFile("src/main/java/MessageCodec.java", javaCodec),
      textFile("src/main/java/ZmqtRuntime.java", javaRuntime),
    ];
  },
  generateBuildFiles(plan) {
    const jeromq = plan.dependencies.find(({ id }) => id === "jeromq")!;
    return [
      textFile(
        "pom.xml",
        renderPom(plan.project.name, javaRelease, jeromq.version),
      ),
    ];
  },
  generateRuntimeConfig(plan) {
    return [runtimeConfigFile(plan)];
  },
  generateTests(plan) {
    const commands = Object.fromEntries(
      plan.applications.map(({ role, socketType }) => [
        role,
        ["java", "-cp", javaJarPath, `App${socketType}`],
      ]),
    );
    const bindRole = plan.topology.roles.find(
      ({ endpoint }) => endpoint.mode === "bind",
    )!.role;
    return [
      textFile(
        "tests/integration_test.py",
        renderIntegrationTest(commands, plan.project.pattern, bindRole),
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

This project runs the ${plan.project.pattern} pattern over TCP using JDK ${javaVersion} and Maven 3.9.

Build from the project directory with JDK ${javaVersion} on your PATH and as JAVA_HOME.

\`\`\`sh
mvn -B -q package
\`\`\`

Start the Bind app, then start the Connect app in another terminal in the project directory.

\`\`\`sh
java -cp ${javaJarPath} App${bind.socketType}
java -cp ${javaJarPath} App${connect.socketType}
\`\`\`

Edit \`config/zmq.json\` to change TCP hosts, the port, or socket options. Each app also accepts \`--config PATH\`.
\`READY\` confirms that the local socket started. PUB/SUB can lose messages before a subscription arrives or when queues fill.
Use Ctrl+C to stop a running app.

Run the integration test with both apps and a temporary loopback port.

\`\`\`sh
python3 tests/integration_test.py
\`\`\`
`,
    );
  },
};

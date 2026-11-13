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
import { cborReadme } from "../../templates/shared/cbor";
import { renderIntegrationTest } from "../../templates/shared/integration";
import { renderScripts, scriptUsage } from "../../templates/shared/scripts";
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
  templateVersion: "1.5.0",
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
    const cbor = plan.project.serialization === "cbor";
    return [
      ...plan.applications.map((application) =>
        textFile(
          entryPoint(application.role),
          renderJavaApplication(application, cbor),
        ),
      ),
      textFile("src/main/java/MessageCodec.java", javaCodec(cbor)),
      textFile("src/main/java/ZmqtRuntime.java", javaRuntime(cbor)),
    ];
  },
  generateBuildFiles(plan) {
    const jeromq = plan.dependencies.find(({ id }) => id === "jeromq")!;
    return [
      textFile(
        "pom.xml",
        renderPom(plan.project.name, javaRelease, jeromq.version,
          plan.dependencies.find(({ id }) => id === "com.upokecenter:cbor")?.version),
      ),
      ...renderScripts(plan, {
        build: ["mvn -B -q package"],
        run: ({ role }) => `java -cp ${javaJarPath} App${role.toUpperCase()}`,
        windows: {
          build: ["mvn.cmd -B -q package"],
          executable: "'java.exe'",
          args: ({ role }) => `-cp ${javaJarPath} App${role.toUpperCase()}`,
        },
      }),
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

This project runs the ${plan.project.pattern} pattern over TCP using JDK ${javaVersion} and Maven 3.9.

Put the JDK and Maven on PATH. Set JAVA_HOME to the JDK directory.

${scriptUsage}

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
${plan.project.serialization === "cbor" ? "\n" + cborReadme + "\n" : ""}
Run the integration test with both apps and a temporary loopback port.

\`\`\`sh
python3 tests/integration_test.py
\`\`\`
`,
    );
  },
};

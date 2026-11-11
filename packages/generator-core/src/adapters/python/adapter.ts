/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import { runtimeConfigFile, textFile } from "../../artifacts/files";
import {
  getCapabilities,
  p0LanguageCapabilities,
} from "../../catalog/capabilities";
import { pythonCodec } from "../../templates/python/codec";
import { pythonRuntime } from "../../templates/python/runtime";
import { renderIntegrationTest } from "../../templates/shared/integration";
import { renderScripts, scriptUsage } from "../../templates/shared/scripts";
import type { LanguageAdapter } from "../types";
import { renderPythonApplication } from "./behavior";

const pythonVersion = getCapabilities().languages.find(
  ({ id }) => id === "python",
)!.languageVersion;
const entryPoint = (role: string) => `app_${role}.py`;

export const pythonAdapter: LanguageAdapter = {
  id: "python",
  templateVersion: "1.1.2",
  dependencySetVersion: "1.0.0",
  layout: {
    entryPoint,
    executableEntries: true,
    supportFiles: ["message_codec.py", "requirements.txt", "zmqt_runtime.py"],
  },
  capabilities: p0LanguageCapabilities,
  generate(plan) {
    return [
      ...plan.applications.map((application) =>
        textFile(
          entryPoint(application.role),
          renderPythonApplication(application),
          true,
        ),
      ),
      textFile("message_codec.py", pythonCodec),
      textFile("zmqt_runtime.py", pythonRuntime),
    ];
  },
  generateBuildFiles(plan) {
    return [
      textFile(
        "requirements.txt",
        `${plan.dependencies.map(({ id, version }) => `${id}==${version}`).join("\n")}\n`,
      ),
      ...renderScripts(plan, {
        build: [
          "python3 -m venv .venv",
          ".venv/bin/python -m pip install -r requirements.txt",
        ],
        run: ({ role }) => `.venv/bin/python ${entryPoint(role)}`,
        windows: {
          build: [
            "python.exe -m venv .venv",
            ".\\.venv\\Scripts\\python.exe -m pip install -r requirements.txt",
          ],
          executable: "Join-Path $PSScriptRoot '.venv\\Scripts\\python.exe'",
          args: ({ role }) => entryPoint(role),
        },
      }),
    ];
  },
  generateRuntimeConfig(plan) {
    return [runtimeConfigFile(plan)];
  },
  generateTests(plan) {
    const commands = Object.fromEntries(
      plan.applications.map(({ role }) => [role, ["python", entryPoint(role)]]),
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

This project runs the ${plan.project.pattern} pattern over TCP using Python ${pythonVersion}.

Put \`python3\` on PATH on macOS or Linux. On Windows, put \`python.exe\` on PATH.

${scriptUsage}

Install the dependencies in a virtual environment.

\`\`\`sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
\`\`\`

Start the Bind app, then start the Connect app in another terminal with the environment active.

\`\`\`sh
python app_${bind.role}.py
python app_${connect.role}.py
\`\`\`

Edit \`config/zmq.json\` to change TCP hosts, the port, or socket options. Each app also accepts \`--config PATH\`.
\`READY\` confirms that the local socket started. It does not confirm delivery. PUB/SUB can lose messages before a subscription reaches the publisher or when queues fill.
Use Ctrl+C to stop a running app.

Run the integration test with both apps and a temporary loopback port.

\`\`\`sh
python tests/integration_test.py
\`\`\`
`,
    );
  },
};

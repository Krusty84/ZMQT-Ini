/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import { runtimeConfigFile, textFile } from "../../artifacts/files";
import {
  getCapabilities,
  p0LanguageCapabilities,
} from "../../catalog/capabilities";
import { nodeCodec } from "../../templates/node/codec";
import { nodeRuntime } from "../../templates/node/runtime";
import { renderIntegrationTest } from "../../templates/shared/integration";
import { renderScripts, scriptUsage } from "../../templates/shared/scripts";
import type { LanguageAdapter } from "../types";
import { renderNodeApplication } from "./behavior";

const nodeVersion = getCapabilities().languages.find(
  ({ id }) => id === "node",
)!.languageVersion;
const entryPoint = (role: string) => `app_${role}.mjs`;

const lockedModules = {
  "node_modules/cmake-ts": {
    version: "1.0.2",
    resolved: "https://registry.npmjs.org/cmake-ts/-/cmake-ts-1.0.2.tgz",
    integrity:
      "sha512-5l++JHE7MxFuyV/OwJf3ek7ZZN1aGPFPM5oUz6AnK5inQAPe4TFXRMz5sA2qg2FRgByPWdqO+gSfIPo8GzoKNQ==",
    license: "MIT",
    bin: { "cmake-ts": "build/main.js" },
  },
  "node_modules/node-addon-api": {
    version: "8.9.2",
    resolved:
      "https://registry.npmjs.org/node-addon-api/-/node-addon-api-8.9.2.tgz",
    integrity:
      "sha512-VijLXbi3UACN69I0JVXJsX4tjACjNoQDgv2gTF6sx2wWEi8tkSg2eX8p5gSIFi8z2+DL3oHmY6OyKce38SDolg==",
    license: "MIT",
    engines: { node: "^18 || ^20 || >= 21" },
  },
  "node_modules/zeromq": {
    version: "6.5.0",
    resolved: "https://registry.npmjs.org/zeromq/-/zeromq-6.5.0.tgz",
    integrity:
      "sha512-vWOrt19lvcXTxu5tiHXfEGQuldSlU+qZn2TT+4EbRQzaciWGwNZ99QQTolQOmcwVgZLodv+1QfC6UZs2PX/6pQ==",
    hasInstallScript: true,
    license: "MIT AND MPL-2.0",
    dependencies: { "cmake-ts": "1.0.2", "node-addon-api": "^8.3.1" },
    engines: { node: ">= 12" },
  },
};

export const nodeAdapter: LanguageAdapter = {
  id: "node",
  templateVersion: "1.5.0",
  dependencySetVersion: "1.0.0",
  layout: {
    entryPoint,
    executableEntries: true,
    supportFiles: [
      "message_codec.mjs",
      "package.json",
      "package-lock.json",
      "zmqt_runtime.mjs",
    ],
  },
  capabilities: p0LanguageCapabilities,
  generate(plan) {
    return [
      ...plan.applications.map((application) =>
        textFile(
          entryPoint(application.role),
          renderNodeApplication(application),
          true,
        ),
      ),
      textFile("message_codec.mjs", nodeCodec),
      textFile("zmqt_runtime.mjs", nodeRuntime),
    ];
  },
  generateBuildFiles(plan) {
    const { name } = plan.project;
    const dependencies = Object.fromEntries(
      plan.dependencies.map(({ id, version }) => [id, version]),
    );
    if (dependencies.zeromq !== lockedModules["node_modules/zeromq"].version) {
      throw new Error(
        "The ZeroMQ package lock does not match the Node.js dependency set.",
      );
    }
    const engines = { node: nodeVersion };
    const packageManifest = {
      name,
      private: true,
      engines,
      scripts: { test: "python3 tests/integration_test.py" },
      dependencies,
    };
    const packageLock = {
      name,
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name, dependencies, engines }, ...lockedModules },
    };
    return [
      textFile("package.json", `${JSON.stringify(packageManifest, null, 2)}\n`),
      textFile(
        "package-lock.json",
        `${JSON.stringify(packageLock, null, 2)}\n`,
      ),
      ...renderScripts(plan, {
        build: ["npm ci"],
        run: ({ role }) => `node ${entryPoint(role)}`,
        windows: {
          build: ["npm.cmd ci"],
          executable: "'node.exe'",
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
      plan.applications.map(({ role }) => [role, ["node", entryPoint(role)]]),
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
    const deliveryNote =
      plan.project.pattern === "pub-sub"
        ? "\nPUB/SUB can lose messages while subscriptions propagate or when queues fill."
        : "";
    return textFile(
      "README.md",
      `# ${plan.project.name}

This project runs the ${plan.project.pattern} pattern over TCP using Node.js ${nodeVersion}.

Put Node.js and npm on PATH.

${scriptUsage}

Install the dependencies with \`npm ci\`.

Start the Bind app, then start the Connect app in another terminal.

\`\`\`sh
node app_${bind.role}.mjs
node app_${connect.role}.mjs
\`\`\`

Edit \`config/zmq.json\` to change TCP hosts, the port, or socket options. Each app also accepts \`--config PATH\`.
\`READY\` reports local socket startup.${deliveryNote}
Use Ctrl+C to stop a running app.

Run \`npm test\` with Python 3 installed to test both apps over a temporary loopback port.
`,
    );
  },
};

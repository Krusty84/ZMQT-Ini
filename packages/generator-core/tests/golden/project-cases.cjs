/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

const { getCapabilities } = require("../../dist/index.js");

const { languages, patterns } = getCapabilities();
const projectCases = languages.flatMap(
  ({ id: language, patterns: supported }) =>
    patterns
      .filter(({ id }) => supported.includes(id))
      .flatMap(({ id: pattern, bindRoles }) =>
        bindRoles.map((bindRole) => ({
          schemaVersion: "1.0",
          project: { name: `${language}-${pattern}-${bindRole}`, language },
          messaging: {
            pattern,
            transport: "tcp",
            bindRole,
            bindHost: "0.0.0.0",
            connectHost: "localhost",
            port: 49123,
          },
          socketOptions: {
            sendHwm: 250,
            receiveHwm: 500,
            sendTimeoutMs: 600,
            receiveTimeoutMs: 800,
            lingerMs: 0,
          },
        })),
      ),
);

function canonicalProject(project) {
  const manifest = Object.keys(project.manifest)
    .sort()
    .map((key) => [key, project.manifest[key]]);
  const files = project.files.map(({ path, encoding, executable, content }) => [
    path,
    encoding,
    executable,
    Buffer.from(content, "utf8").toString("base64"),
  ]);
  return JSON.stringify([manifest, files]);
}

module.exports = { projectCases, canonicalProject };

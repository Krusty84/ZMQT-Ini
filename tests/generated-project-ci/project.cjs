/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");

const coreDir = resolve(__dirname, "../../packages/generator-core");
const core = createRequire(join(coreDir, "package.json"))(
  "@zmqt-ini/generator-core",
);

const orientations = [
  ["req-rep", "req"],
  ["req-rep", "rep"],
  ["pub-sub", "pub"],
  ["pub-sub", "sub"],
  ["push-pull", "push"],
  ["push-pull", "pull"],
];

const optionalSocketOptions = {
  reconnectIntervalMs: 200,
  reconnectMaxIntervalMs: 1500,
  heartbeatIntervalMs: 1000,
  heartbeatTimeoutMs: 4000,
  maxFrameBytes: 4096,
  handshakeTimeoutMs: 1000,
  immediate: true,
};

function projectConfig(
  language,
  pattern,
  bindRole,
  hosts = ["127.0.0.1", "127.0.0.1"],
) {
  const [bindHost, connectHost] = hosts;
  return {
    schemaVersion: "2.0",
    project: { name: `${language}-integration`, language },
    messaging: {
      pattern,
      transport: "tcp",
      bindRole,
      bindHost,
      connectHost,
      port: 5555,
    },
    socketOptions: {
      sendHwm: 50,
      receiveHwm: 50,
      sendTimeoutMs: 2500,
      receiveTimeoutMs: 2000,
      lingerMs: 25,
    },
  };
}

function createProject(t, language, pattern, bindRole, hosts) {
  const config = projectConfig(language, pattern, bindRole, hosts);
  if (bindRole === "rep") Object.assign(config.socketOptions, optionalSocketOptions);
  return writeProject(t, config);
}

function writeProject(t, config) {
  const workspace = mkdtempSync(join(tmpdir(), `zmqt-${config.project.language}-project-`));
  t.after(() => rmSync(workspace, { force: true, recursive: true }));
  const project = core.generateProject(config);
  assert.equal(project.ok, true, JSON.stringify(project.diagnostics));

  for (const file of project.value.files) {
    const path = join(workspace, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content, {
      encoding: file.encoding,
      mode: file.executable ? 0o755 : 0o644,
    });
  }
  return workspace;
}

module.exports = { core, createProject, optionalSocketOptions, orientations, projectConfig, writeProject };

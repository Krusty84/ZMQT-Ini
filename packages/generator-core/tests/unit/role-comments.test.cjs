/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const { generateProject, getCapabilities } = require("../../dist/index.js");
const { projectCases } = require("../golden/project-cases.cjs");

const rolesByPattern = Object.fromEntries(
  getCapabilities().patterns.map(({ id, bindRoles }) => [id, bindRoles]),
);

const syntax = {
  python: {
    path: (role) => `app_${role}.py`,
    branch: (state) => `case "${state}":`,
    prefix: "#",
  },
  node: {
    path: (role) => `app_${role}.mjs`,
    branch: (state) => `case "${state}": {`,
    prefix: "//",
  },
  cpp: {
    path: (role) => `app_${role}.cpp`,
    branch: (state) => `if (state == "${state}") {`,
    prefix: "//",
  },
  java: {
    path: (role) => `src/main/java/App${role.toUpperCase()}.java`,
    branch: (state) => `case "${state}" -> {`,
    prefix: "//",
  },
};

const integrationPoint = "INTEGRATION POINT - ";

const expected = {
  req: {
    "build-request": `${integrationPoint}Supply your application's request payload here.`,
    "log-response": `${integrationPoint}Pass the reply with the verified id to your caller.`,
  },
  rep: {
    "build-response": `${integrationPoint}Call your request handler here. Use the request id in the reply.`,
    "recover-id": "Send an INVALID_MESSAGE error reply if the request id is usable.",
  },
  pub: {
    build: `${integrationPoint}Use an event from your application as the payload.`,
    wait: "This wait sets the interval between sample publications.",
  },
  sub: { log: `${integrationPoint}Pass the validated event to your event handler.` },
  push: { build: `${integrationPoint}Use a task from your application as the payload.` },
  pull: { process: `${integrationPoint}Run your application's task handler here.` },
};

for (const config of projectCases) {
  test(`role comments for ${config.project.name}`, () => {
    const result = generateProject(config);
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    const sources = Object.fromEntries(
      result.value.files.map(({ path, content }) => [path, content]),
    );
    const { path, branch, prefix } = syntax[config.project.language];
    const roles = rolesByPattern[config.messaging.pattern];
    for (const [role, peer] of [roles, roles.toReversed()]) {
      const lines = sources[path(role)].split("\n").map((line) => line.trim());
      for (const [state, comment] of Object.entries(expected[role])) {
        const index = lines.indexOf(branch(state));
        assert.notEqual(index, -1, `${path(role)} branch ${state}`);
        assert.equal(
          lines[index + 1],
          `${prefix} ${comment}`,
          `${path(role)} branch ${state}`,
        );
        assert.ok(
          !sources[path(peer)].includes(comment.replace(integrationPoint, "")),
          `${path(peer)} has the ${role} hint`,
        );
      }
      const marked = lines.filter((line) =>
        line.startsWith(`${prefix} ${integrationPoint}`),
      );
      assert.equal(marked.length, role === "req" ? 2 : 1, path(role));
    }
    assert.equal(result.value.manifest.templateVersion, "1.1.2");
  });
}

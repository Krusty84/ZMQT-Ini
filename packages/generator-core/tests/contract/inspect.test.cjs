/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  getCapabilities,
  inspectProject,
  validateConfig,
} = require("@zmqt-ini/generator-core");
const { planProject } = require("../../dist/planning/build.js");

const patterns = [
  ["req-rep", "req", "rep"],
  ["pub-sub", "pub", "sub"],
  ["push-pull", "push", "pull"],
];

function config(language, pattern, bindRole) {
  return {
    schemaVersion: "1.0",
    project: { name: "inspection", language },
    messaging: {
      pattern,
      transport: "tcp",
      bindRole,
      bindHost: "::",
      connectHost: "::1",
      port: 5555,
    },
    socketOptions: {
      sendHwm: 100,
      receiveHwm: 100,
      sendTimeoutMs: 500,
      receiveTimeoutMs: 500,
      lingerMs: 10,
    },
  };
}

test("compiles and validates the 24 plans and exposes only the summary through inspectProject", () => {
  for (const { id: language, libraryId, libraryVersion } of getCapabilities()
    .languages) {
    for (const [pattern, ...roles] of patterns) {
      for (const bindRole of roles) {
        const input = config(language, pattern, bindRole);
        const plan = planProject(input);
        assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
        assert.equal(plan.value.irVersion, "1.0");
        assert.deepEqual(plan.value.dependencies, [
          { id: libraryId, version: libraryVersion },
        ]);
        assert.deepEqual(
          plan.value.applications.map(({ role }) => role),
          roles,
        );

        const result = inspectProject(input);
        assert.deepEqual(result, {
          ok: true,
          value: {
            projectName: "inspection",
            language,
            pattern,
            roles: roles.map((role) => ({
              role,
              socketType: role.toUpperCase(),
              mode: role === bindRole ? "bind" : "connect",
              endpoint:
                role === bindRole ? "tcp://[::]:5555" : "tcp://[::1]:5555",
            })),
          },
          diagnostics: validateConfig(input).diagnostics,
        });
        result.value.roles[0].endpoint = "modified";
        assert.notEqual(
          inspectProject(input).value.roles[0].endpoint,
          "modified",
        );
      }
    }
  }
});

test("invalid inputs return the same diagnostics from validation and inspection", () => {
  for (const input of [null, config("python", "pub-sub", "req")]) {
    const result = inspectProject(input);
    assert.equal(result.ok, false);
    assert.deepEqual(result, validateConfig(input));
  }
});

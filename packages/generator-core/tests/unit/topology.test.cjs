/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const { patternRegistry } = require("../../dist/patterns/registry.js");
const { compileTopology } = require("../../dist/topology/compiler.js");
const { buildLifecycle } = require("../../dist/topology/lifecycle.js");
const { validateConfig } = require("../../dist/validation/config.js");

const socketOptions = Object.freeze({
  sendHwm: 100,
  receiveHwm: 200,
  sendTimeoutMs: 300,
  receiveTimeoutMs: 400,
  lingerMs: 500,
});

const bidirectional = socketOptions;
const sendOnly = { sendHwm: 100, sendTimeoutMs: 300, lingerMs: 500 };
const receiveOnly = { receiveHwm: 200, receiveTimeoutMs: 400, lingerMs: 500 };
const cases = {
  "req-rep": [
    ["req", "REQ", bidirectional],
    ["rep", "REP", bidirectional],
  ],
  "pub-sub": [
    ["pub", "PUB", sendOnly],
    ["sub", "SUB", receiveOnly],
  ],
  "push-pull": [
    ["push", "PUSH", sendOnly],
    ["pull", "PULL", receiveOnly],
  ],
};

for (const [pattern, roles] of Object.entries(cases)) {
  for (const [bindRole] of roles) {
    test(`${pattern} with ${bindRole} binding preserves both roles and their active options`, () => {
      const result = validateConfig({
        schemaVersion: "1.0",
        project: { name: "topology-test", language: "python" },
        messaging: {
          pattern,
          transport: "tcp",
          bindRole,
          bindHost: "::",
          connectHost: "::1",
          port: 65535,
        },
        socketOptions,
      });
      assert.equal(result.ok, true);
      assert.deepEqual(compileTopology(result.value), {
        transport: "tcp",
        roles: roles.map(([role, socketType, options]) => ({
          role,
          socketType,
          options,
          endpoint:
            role === bindRole
              ? {
                  mode: "bind",
                  host: "::",
                  port: 65535,
                  uri: "tcp://[::]:65535",
                }
              : {
                  mode: "connect",
                  host: "::1",
                  port: 65535,
                  uri: "tcp://[::1]:65535",
                },
        })),
      });
    });
  }
}

test("formats bind wildcard and connect DNS hosts without IPv6 brackets", () => {
  const result = validateConfig({
    schemaVersion: "1.0",
    project: { name: "topology-test", language: "node" },
    messaging: {
      pattern: "req-rep",
      transport: "tcp",
      bindRole: "rep",
      bindHost: "*",
      connectHost: "localhost",
      port: 1,
    },
    socketOptions,
  });
  assert.equal(result.ok, true);
  const [request, reply] = compileTopology(result.value).roles;
  assert.equal(request.endpoint.uri, "tcp://localhost:1");
  assert.equal(reply.endpoint.uri, "tcp://*:1");
});

test("subscribes only SUB before bind or connect and closes initialized resources in order", () => {
  for (const { roles } of Object.values(patternRegistry)) {
    for (const role of roles) {
      for (const language of ["python", "cpp", "java", "node"]) {
        const hasContext = language !== "node";
        const lifecycle = buildLifecycle(language, role);
        assert.deepEqual(lifecycle.startup, [
          { op: "load-runtime-config" },
          { op: "validate-runtime-config" },
          ...(hasContext ? [{ op: "create-context" }] : []),
          { op: "create-socket" },
          { op: "apply-options" },
          ...(role.socketType === "SUB"
            ? [{ op: "apply-subscription", prefix: "" }]
            : []),
          { op: "bind-or-connect" },
          { op: "emit-ready" },
          { op: "execute-pattern" },
        ]);
        assert.deepEqual(lifecycle.cleanup, [
          { op: "apply-linger", ifCreated: "socket" },
          { op: "close-socket", ifCreated: "socket" },
          ...(hasContext
            ? [{ op: "close-context", ifCreated: "context" }]
            : []),
          { op: "stop" },
        ]);
        assert.equal(lifecycle.cleanupOn, "always");
        assert.equal(lifecycle.continueCleanupOnError, true);
        assert.deepEqual(lifecycle.shutdown, {
          signals: ["SIGINT", "SIGTERM"],
          handler: "set-flag",
          waiting: "interruptible",
        });
      }
    }
  }
});

/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildBehavior } = require("../../dist/patterns/behavior.js");

function walk(socketType, steps) {
  const plan = buildBehavior(socketType);
  const nodes = new Map(plan.nodes.map((node) => [node.id, node]));
  let node = nodes.get(plan.entry);
  for (const [operation, outcome] of steps) {
    assert.equal(node.operation.op, operation);
    node = nodes.get(node.transitions[outcome]);
    assert.ok(
      node,
      `Missing ${operation} / ${outcome} transition for ${socketType}`,
    );
  }
  return node.operation;
}

test("REQ stops after one round trip and fails on send or receive timeout", () => {
  const request = [
    ["build", "ok"],
    ["encode", "ok"],
    ["send", "ok"],
  ];
  const decoded = [...request, ["receive", "ok"], ["decode", "ok"]];
  assert.deepEqual(walk("REQ", decoded), {
    op: "validate",
    check: "message",
    from: "decoded",
    to: "response",
    messageTypes: ["response"],
    matchesIdOf: "request",
  });
  assert.deepEqual(walk("REQ", [...decoded, ["validate", "ok"]]), {
    op: "log",
    event: "RESPONSE_RECEIVED",
    from: "response",
  });
  assert.deepEqual(
    walk("REQ", [...decoded, ["validate", "ok"], ["log", "ok"]]),
    { op: "stop", exitCode: 0 },
  );

  const remoteError = [...decoded, ["validate", "invalid"]];
  assert.deepEqual(walk("REQ", remoteError), {
    op: "validate",
    check: "message",
    from: "decoded",
    to: "response",
    messageTypes: ["error"],
    matchesIdOf: "request",
  });
  assert.deepEqual(
    walk("REQ", [...remoteError, ["validate", "ok"], ["log", "ok"]]),
    { op: "stop", exitCode: 1 },
  );
  assert.deepEqual(
    walk("REQ", [...request, ["receive", "timeout"], ["log", "ok"]]),
    { op: "stop", exitCode: 1 },
  );
  assert.deepEqual(
    walk("REQ", [
      ["build", "ok"],
      ["encode", "ok"],
      ["send", "timeout"],
      ["log", "ok"],
    ]),
    { op: "stop", exitCode: 1 },
  );
});

test("REP waits after receive timeout and receives again after a successful reply", () => {
  assert.equal(walk("REP", [["receive", "timeout"]]).op, "receive");
  const valid = [
    ["receive", "ok"],
    ["decode", "ok"],
    ["validate", "ok"],
  ];
  assert.deepEqual(walk("REP", valid), {
    op: "build",
    messageType: "response",
    id: { kind: "message", from: "request" },
    payload: { kind: "message", from: "request" },
    to: "reply",
  });
  assert.equal(
    walk("REP", [...valid, ["build", "ok"], ["encode", "ok"], ["send", "ok"]])
      .op,
    "receive",
  );
});

test("REP replies to invalid requests with a recoverable id and stops otherwise", () => {
  const recover = [
    ["receive", "ok"],
    ["decode", "ok"],
    ["validate", "invalid"],
    ["log", "ok"],
  ];
  assert.deepEqual(walk("REP", recover), {
    op: "validate",
    check: "id",
    from: "decoded",
    to: "requestId",
  });
  assert.deepEqual(walk("REP", [...recover, ["validate", "invalid"]]), {
    op: "stop",
    exitCode: 1,
  });
  const validId = [...recover, ["validate", "ok"]];
  assert.deepEqual(walk("REP", validId), {
    op: "build",
    messageType: "error",
    id: { kind: "id", from: "requestId" },
    payload: { kind: "literal", value: { code: "INVALID_MESSAGE" } },
    to: "reply",
  });
  const reply = [...validId, ["build", "ok"], ["encode", "ok"]];
  assert.equal(walk("REP", [...reply, ["send", "ok"]]).op, "receive");
  assert.deepEqual(
    walk("REP", [...reply, ["send", "timeout"], ["log", "ok"]]),
    { op: "stop", exitCode: 1 },
  );
  assert.deepEqual(
    walk("REP", [
      ["receive", "ok"],
      ["decode", "invalid"],
      ["log", "ok"],
    ]),
    { op: "stop", exitCode: 1 },
  );
});

test("PUB paces successful sends and PUB/PUSH stop on send timeout", () => {
  const sent = [
    ["build", "ok"],
    ["encode", "ok"],
    ["send", "ok"],
  ];
  const timeout = [
    ["build", "ok"],
    ["encode", "ok"],
    ["send", "timeout"],
    ["log", "ok"],
  ];
  assert.deepEqual(walk("PUB", []), {
    op: "build",
    messageType: "event",
    id: { kind: "sequence" },
    payload: { kind: "example", includeTestRunId: true },
    to: "message",
  });
  assert.deepEqual(walk("PUB", sent), { op: "wait", milliseconds: 200 });
  assert.equal(walk("PUB", [...sent, ["wait", "ok"]]).op, "build");
  assert.deepEqual(walk("PUB", [...sent, ["wait", "shutdown"]]), {
    op: "stop",
    exitCode: 0,
  });
  assert.deepEqual(walk("PUSH", []).id, { kind: "sequence" });
  assert.equal(walk("PUSH", sent).op, "build");
  for (const socketType of ["PUB", "PUSH"]) {
    assert.deepEqual(walk(socketType, timeout), { op: "stop", exitCode: 1 });
  }
});

test("SUB/PULL log and skip malformed data, and stop cleanly on shutdown", () => {
  for (const socketType of ["SUB", "PULL"]) {
    assert.equal(walk(socketType, [["receive", "timeout"]]).op, "receive");
    assert.equal(
      walk(socketType, [
        ["receive", "ok"],
        ["decode", "invalid"],
        ["log", "ok"],
      ]).op,
      "receive",
    );
    assert.equal(
      walk(socketType, [
        ["receive", "ok"],
        ["decode", "ok"],
        ["validate", "invalid"],
        ["log", "ok"],
      ]).op,
      "receive",
    );
    assert.deepEqual(walk(socketType, [["receive", "shutdown"]]), {
      op: "stop",
      exitCode: 0,
    });
  }
  const validated = [
    ["receive", "ok"],
    ["decode", "ok"],
    ["validate", "ok"],
  ];
  assert.deepEqual(walk("SUB", validated), {
    op: "log",
    event: "MESSAGE_RECEIVED",
    from: "message",
  });
  assert.equal(walk("SUB", [...validated, ["log", "ok"]]).op, "receive");
  assert.deepEqual(walk("PULL", validated), {
    op: "process",
    from: "message",
    to: "processed",
  });
  assert.deepEqual(walk("PULL", [...validated, ["process", "ok"]]), {
    op: "log",
    event: "TASK_PROCESSED",
    from: "processed",
  });
  assert.equal(
    walk("PULL", [...validated, ["process", "ok"], ["log", "ok"]]).op,
    "receive",
  );
});

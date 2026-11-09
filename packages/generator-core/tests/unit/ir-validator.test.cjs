/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const { getCapabilities } = require("@zmqt-ini/generator-core");
const { planProject } = require("../../dist/planning/build");
const { validatePlan } = require("../../dist/planning/validate");

const capabilities = {
  irVersions: ["1.0"],
  operations: [
    "build",
    "encode",
    "decode",
    "validate",
    "send",
    "receive",
    "process",
    "wait",
    "log",
    "stop",
  ],
  socketTypes: ["REQ", "REP", "PUB", "SUB", "PUSH", "PULL"],
  socketOptions: Object.keys(getCapabilities().socketOptionRanges),
};

function plan(pattern = "req-rep", bindRole = "rep") {
  const result = planProject({
    schemaVersion: "1.0",
    project: { name: "ir-test", language: "python" },
    messaging: {
      pattern,
      bindRole,
      transport: "tcp",
      bindHost: "::",
      connectHost: "::1",
      port: 5555,
    },
    socketOptions: {
      sendHwm: 1,
      receiveHwm: 1,
      sendTimeoutMs: 1,
      receiveTimeoutMs: 1,
      lingerMs: 100,
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return result.value;
}

function node(value, role, id) {
  return value.applications
    .find((app) => app.role === role)
    .behavior.nodes.find((item) => item.id === id);
}

function rejects(value, code, path, supported = capabilities) {
  const diagnostics = validatePlan(value, supported);
  assert.ok(
    diagnostics.some(
      (item) =>
        item.severity === "error" &&
        item.code === code &&
        (path === undefined || item.path === path),
    ),
    JSON.stringify(diagnostics),
  );
  assert.deepEqual(validatePlan(value, supported), diagnostics);
}

test("rejects unsupported IR, behavior versions, sockets, options and operations", () => {
  rejects(
    { ...plan(), irVersion: "2.0" },
    "IR_UNSUPPORTED_VERSION",
    "/irVersion",
  );
  rejects(plan(), "IR_UNSUPPORTED_VERSION", "/irVersion", {
    ...capabilities,
    irVersions: [],
  });

  const version = plan();
  version.applications[0].behavior.version = 2;
  rejects(
    version,
    "IR_UNSUPPORTED_BEHAVIOR_VERSION",
    "/applications/0/behavior/version",
  );
  rejects(plan(), "IR_UNSUPPORTED_SOCKET", "/applications/0/socketType", {
    ...capabilities,
    socketTypes: ["REP"],
  });
  rejects(plan(), "IR_UNSUPPORTED_SOCKET_OPTION", undefined, {
    ...capabilities,
    socketOptions: [],
  });
  rejects(
    plan(),
    "IR_UNSUPPORTED_OPERATION",
    "/applications/0/behavior/nodes/0/operation/op",
    {
      ...capabilities,
      operations: capabilities.operations.filter((op) => op !== "build"),
    },
  );

  const operation = plan();
  node(operation, "req", "build-request").operation.op = "raw";
  rejects(
    operation,
    "IR_UNSUPPORTED_OPERATION",
    "/applications/0/behavior/nodes/0/operation/op",
  );
});

test("rejects invalid entries, duplicated nodes, dangling transitions and unreachable nodes", () => {
  const absentEntry = plan();
  absentEntry.applications[0].behavior.entry = "missing";
  rejects(absentEntry, "IR_MISSING_ENTRY", "/applications/0/behavior/entry");

  const duplicate = plan();
  duplicate.applications[0].behavior.nodes.push(
    node(duplicate, "req", "complete"),
  );
  rejects(duplicate, "IR_DUPLICATE_NODE");

  const missingTarget = plan();
  node(missingTarget, "req", "send").transitions.ok = "missing";
  rejects(missingTarget, "IR_MISSING_TARGET");

  const unreachable = plan();
  unreachable.applications[0].behavior.nodes.push({
    id: "orphan",
    operation: { op: "stop", exitCode: 0 },
    transitions: {},
  });
  rejects(unreachable, "IR_UNREACHABLE_NODE");
});

test("requires all operation outcomes and a terminal stop", () => {
  const missing = plan();
  delete node(missing, "req", "receive").transitions.shutdown;
  rejects(missing, "IR_INVALID_OUTCOMES");

  const extra = plan();
  node(extra, "req", "decode").transitions.error = "fail";
  rejects(extra, "IR_INVALID_OUTCOMES");

  const nonTerminal = plan();
  node(nonTerminal, "req", "complete").transitions.ok = "fail";
  rejects(nonTerminal, "IR_INVALID_OUTCOMES");
});

test("checks wait durations, exit codes and the task processor's socket", () => {
  const wait = plan("pub-sub", "pub");
  node(wait, "pub", "wait").operation.milliseconds = -1;
  rejects(
    wait,
    "IR_INVALID_OPERAND",
    "/applications/0/behavior/nodes/3/operation/milliseconds",
  );

  const stop = plan();
  node(stop, "req", "complete").operation.exitCode = 2;
  rejects(stop, "IR_INVALID_OPERAND");

  const process = plan("pub-sub", "pub");
  node(process, "sub", "log").operation = {
    op: "process",
    from: "message",
    to: "processed",
  };
  rejects(process, "IR_SOCKET_OPERATION");
});

test("checks variable kinds and assignments on every incoming edge", () => {
  const unassigned = plan();
  node(unassigned, "req", "send").operation.from = "undefined-name";
  rejects(
    unassigned,
    "IR_UNASSIGNED_VARIABLE",
    "/applications/0/behavior/nodes/2/operation",
  );

  const wrongKind = plan();
  node(wrongKind, "req", "send").operation.from = "request";
  rejects(
    wrongKind,
    "IR_VARIABLE_TYPE",
    "/applications/0/behavior/nodes/2/operation",
  );

  const skippedWrite = plan();
  node(skippedWrite, "rep", "recover-id").transitions.invalid = "build-error";
  rejects(skippedWrite, "IR_UNASSIGNED_VARIABLE");

  const merge = plan();
  node(merge, "rep", "build-error").operation.to = "other-reply";
  rejects(merge, "IR_UNASSIGNED_VARIABLE");

  const wrongMessageType = plan("pub-sub", "pub");
  node(wrongMessageType, "pub", "build").operation.messageType = "task";
  rejects(wrongMessageType, "IR_MESSAGE_TYPE");
});

test("enforces socket directions, REQ ordering and REP reply state", () => {
  const reversed = plan();
  reversed.applications[0].behavior.entry = "receive";
  rejects(
    reversed,
    "IR_INVALID_EXCHANGE_ORDER",
    "/applications/0/behavior/nodes/3/operation/op",
  );

  const reqRetry = plan();
  node(reqRetry, "req", "send").transitions.timeout = "send";
  rejects(
    reqRetry,
    "IR_INVALID_EXCHANGE_ORDER",
    "/applications/0/behavior/nodes/2/operation/op",
  );

  const repWithoutReply = plan();
  node(repWithoutReply, "rep", "decode").transitions.invalid = "receive";
  rejects(
    repWithoutReply,
    "IR_INVALID_EXCHANGE_ORDER",
    "/applications/1/behavior/nodes/0/operation/op",
  );

  const repAfterFailedSend = plan();
  node(repAfterFailedSend, "rep", "send").transitions.timeout = "receive";
  rejects(
    repAfterFailedSend,
    "IR_INVALID_EXCHANGE_ORDER",
    "/applications/1/behavior/nodes/0/operation/op",
  );

  const wrongDirection = plan("pub-sub", "pub");
  node(wrongDirection, "pub", "send").operation = {
    op: "receive",
    to: "incoming",
  };
  rejects(wrongDirection, "IR_SOCKET_OPERATION");
});

test("requires cooperative cycles and terminal shutdown routes", () => {
  const cycle = plan("pub-sub", "pub");
  node(cycle, "pub", "encode").transitions.ok = "build";
  rejects(cycle, "IR_UNMANAGED_CYCLE");
  rejects(cycle, "IR_NO_STOP_PATH");

  const branchCycle = plan("pub-sub", "pub");
  node(branchCycle, "sub", "decode").transitions.invalid = "decode";
  rejects(branchCycle, "IR_UNMANAGED_CYCLE");
  assert.equal(
    validatePlan(branchCycle, capabilities).some(
      (item) => item.code === "IR_NO_STOP_PATH",
    ),
    false,
  );

  const badShutdown = plan("pub-sub", "pub");
  node(badShutdown, "sub", "receive").transitions.shutdown = "receive";
  rejects(
    badShutdown,
    "IR_INVALID_STOP_PATH",
    "/applications/1/behavior/nodes/0/transitions/shutdown",
  );
});

test("requires topology consistency, applicable options and unconditional cleanup", () => {
  const wrongEndpoint = plan();
  wrongEndpoint.applications[0].endpoint = {
    ...wrongEndpoint.applications[0].endpoint,
    mode: "bind",
  };
  rejects(wrongEndpoint, "IR_APPLICATION_TOPOLOGY_MISMATCH", "/applications/0");

  const wrongUri = plan();
  wrongUri.topology.roles[0].endpoint.uri = "tcp://::1:5555";
  rejects(wrongUri, "IR_INVALID_ENDPOINT", "/topology/roles/0/endpoint");

  const unspecifiedConnect = plan();
  Object.assign(unspecifiedConnect.topology.roles[0].endpoint, {
    host: "::",
    uri: "tcp://[::]:5555",
  });
  rejects(
    unspecifiedConnect,
    "IR_INVALID_ENDPOINT",
    "/topology/roles/0/endpoint",
  );

  const inactiveOption = plan("pub-sub", "pub");
  inactiveOption.applications[0].options.receiveHwm = 1;
  rejects(inactiveOption, "IR_INACTIVE_SOCKET_OPTION");

  const startup = plan("pub-sub", "sub");
  const sub = startup.applications[1];
  const subscribeIndex = sub.lifecycle.startup.findIndex(
    (step) => step.op === "apply-subscription",
  );
  sub.lifecycle.startup.splice(subscribeIndex, 1);
  rejects(startup, "IR_INVALID_STARTUP", "/applications/1/lifecycle/startup");

  const cleanup = plan();
  const [linger, socket, context, stop] =
    cleanup.applications[0].lifecycle.cleanup;
  cleanup.applications[0].lifecycle.cleanup = [linger, context, socket, stop];
  rejects(cleanup, "IR_INVALID_CLEANUP", "/applications/0/lifecycle/cleanup");

  const shutdown = plan();
  shutdown.applications[0].lifecycle.shutdown.waiting = "blocking";
  rejects(
    shutdown,
    "IR_INVALID_SHUTDOWN",
    "/applications/0/lifecycle/shutdown",
  );
});

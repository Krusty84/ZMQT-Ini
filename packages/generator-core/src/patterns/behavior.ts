/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import type {
  BehaviorNode,
  BehaviorOperation,
  BehaviorPlan,
} from "../planning/ir";
import type { SocketType } from "./registry";

function node(
  id: string,
  operation: BehaviorOperation,
  transitions: BehaviorNode["transitions"],
): BehaviorNode {
  return { id, operation, transitions };
}

function failure(
  event:
    | "SEND_TIMEOUT"
    | "RECEIVE_TIMEOUT"
    | "PROTOCOL_ERROR"
    | "TRANSPORT_ERROR",
): BehaviorNode {
  return node(event, { op: "log", event }, { ok: "fail" });
}

function plan(nodes: readonly BehaviorNode[]): BehaviorPlan {
  return {
    version: 1,
    entry: nodes[0].id,
    nodes: [
      ...nodes,
      node("complete", { op: "stop", exitCode: 0 }, {}),
      node("fail", { op: "stop", exitCode: 1 }, {}),
    ],
  };
}

function request(): BehaviorPlan {
  return plan([
    node(
      "build-request",
      {
        op: "build",
        messageType: "request",
        id: { kind: "sequence" },
        payload: { kind: "example", includeTestRunId: false },
        to: "request",
      },
      { ok: "encode" },
    ),
    node(
      "encode",
      { op: "encode", from: "request", to: "outgoing" },
      { ok: "send" },
    ),
    node(
      "send",
      { op: "send", from: "outgoing" },
      {
        ok: "receive",
        timeout: "SEND_TIMEOUT",
        error: "TRANSPORT_ERROR",
        shutdown: "complete",
      },
    ),
    node(
      "receive",
      { op: "receive", to: "incoming" },
      {
        ok: "decode",
        timeout: "RECEIVE_TIMEOUT",
        error: "TRANSPORT_ERROR",
        shutdown: "complete",
      },
    ),
    node(
      "decode",
      { op: "decode", from: "incoming", to: "decoded" },
      { ok: "validate-response", invalid: "PROTOCOL_ERROR" },
    ),
    node(
      "validate-response",
      {
        op: "validate",
        check: "message",
        from: "decoded",
        to: "response",
        messageTypes: ["response"],
        matchesIdOf: "request",
      },
      { ok: "log-response", invalid: "validate-error" },
    ),
    node(
      "validate-error",
      {
        op: "validate",
        check: "message",
        from: "decoded",
        to: "response",
        messageTypes: ["error"],
        matchesIdOf: "request",
      },
      { ok: "PROTOCOL_ERROR", invalid: "PROTOCOL_ERROR" },
    ),
    node(
      "log-response",
      { op: "log", event: "RESPONSE_RECEIVED", from: "response" },
      { ok: "complete" },
    ),
    failure("SEND_TIMEOUT"),
    failure("RECEIVE_TIMEOUT"),
    failure("PROTOCOL_ERROR"),
    failure("TRANSPORT_ERROR"),
  ]);
}

function reply(): BehaviorPlan {
  return plan([
    node(
      "receive",
      { op: "receive", to: "incoming" },
      {
        ok: "decode",
        timeout: "receive",
        error: "TRANSPORT_ERROR",
        shutdown: "complete",
      },
    ),
    node(
      "decode",
      { op: "decode", from: "incoming", to: "decoded" },
      { ok: "validate-request", invalid: "PROTOCOL_ERROR" },
    ),
    node(
      "validate-request",
      {
        op: "validate",
        check: "message",
        from: "decoded",
        to: "request",
        messageTypes: ["request"],
      },
      { ok: "build-response", invalid: "log-invalid-request" },
    ),
    node(
      "build-response",
      {
        op: "build",
        messageType: "response",
        id: { kind: "message", from: "request" },
        payload: { kind: "message", from: "request" },
        to: "reply",
      },
      { ok: "encode" },
    ),
    node(
      "log-invalid-request",
      { op: "log", event: "PROTOCOL_ERROR" },
      { ok: "recover-id" },
    ),
    node(
      "recover-id",
      { op: "validate", check: "id", from: "decoded", to: "requestId" },
      { ok: "build-error", invalid: "fail" },
    ),
    node(
      "build-error",
      {
        op: "build",
        messageType: "error",
        id: { kind: "id", from: "requestId" },
        payload: { kind: "literal", value: { code: "INVALID_MESSAGE" } },
        to: "reply",
      },
      { ok: "encode" },
    ),
    node(
      "encode",
      { op: "encode", from: "reply", to: "outgoing" },
      { ok: "send" },
    ),
    node(
      "send",
      { op: "send", from: "outgoing" },
      {
        ok: "receive",
        timeout: "SEND_TIMEOUT",
        error: "TRANSPORT_ERROR",
        shutdown: "complete",
      },
    ),
    failure("SEND_TIMEOUT"),
    failure("PROTOCOL_ERROR"),
    failure("TRANSPORT_ERROR"),
  ]);
}

function sendStream(messageType: "event" | "task"): BehaviorPlan {
  const periodic = messageType === "event";
  return plan([
    node(
      "build",
      {
        op: "build",
        messageType,
        id: { kind: "sequence" },
        payload: { kind: "example", includeTestRunId: periodic },
        to: "message",
      },
      { ok: "encode" },
    ),
    node(
      "encode",
      { op: "encode", from: "message", to: "outgoing" },
      { ok: "send" },
    ),
    node(
      "send",
      { op: "send", from: "outgoing" },
      {
        ok: periodic ? "wait" : "build",
        timeout: "SEND_TIMEOUT",
        error: "TRANSPORT_ERROR",
        shutdown: "complete",
      },
    ),
    ...(periodic
      ? [
          node(
            "wait",
            { op: "wait", milliseconds: 200 },
            { ok: "build", shutdown: "complete" },
          ),
        ]
      : []),
    failure("SEND_TIMEOUT"),
    failure("TRANSPORT_ERROR"),
  ]);
}

function receiveStream(messageType: "event" | "task"): BehaviorPlan {
  const subscriber = messageType === "event";
  return plan([
    node(
      "receive",
      { op: "receive", to: "incoming" },
      {
        ok: "decode",
        timeout: "receive",
        error: "TRANSPORT_ERROR",
        shutdown: "complete",
      },
    ),
    node(
      "decode",
      { op: "decode", from: "incoming", to: "decoded" },
      { ok: "validate", invalid: "log-invalid" },
    ),
    node(
      "validate",
      {
        op: "validate",
        check: "message",
        from: "decoded",
        to: "message",
        messageTypes: [messageType],
      },
      {
        ok: subscriber ? "log" : "process",
        invalid: "log-invalid",
      },
    ),
    ...(subscriber
      ? []
      : [
          node(
            "process",
            { op: "process", from: "message", to: "processed" },
            { ok: "log" },
          ),
        ]),
    node(
      "log",
      subscriber
        ? { op: "log", event: "MESSAGE_RECEIVED", from: "message" }
        : { op: "log", event: "TASK_PROCESSED", from: "processed" },
      { ok: "receive" },
    ),
    node(
      "log-invalid",
      { op: "log", event: "PROTOCOL_ERROR" },
      { ok: "receive" },
    ),
    failure("TRANSPORT_ERROR"),
  ]);
}

export function buildBehavior(socketType: SocketType): BehaviorPlan {
  switch (socketType) {
    case "REQ":
      return request();
    case "REP":
      return reply();
    case "PUB":
      return sendStream("event");
    case "SUB":
      return receiveStream("event");
    case "PUSH":
      return sendStream("task");
    case "PULL":
      return receiveStream("task");
  }
}

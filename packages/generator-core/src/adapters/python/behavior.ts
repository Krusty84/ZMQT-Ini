/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import type {
  ApplicationPlan,
  BehaviorNode,
  BehaviorOperation,
  JsonValue,
} from "../../planning/ir";

type Build = Extract<BehaviorOperation, { op: "build" }>;
type Transitions = BehaviorNode["transitions"];

function pythonLiteral(value: JsonValue): string {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (Array.isArray(value)) return `[${value.map(pythonLiteral).join(", ")}]`;
  if (typeof value === "object") {
    const fields = Object.entries(value).map(
      ([key, item]) => `${JSON.stringify(key)}: ${pythonLiteral(item)}`,
    );
    return `{${fields.join(", ")}}`;
  }
  return JSON.stringify(value);
}

function variable(name: string): string {
  return `values[${JSON.stringify(name)}]`;
}

function renderId(id: Build["id"]): string {
  switch (id.kind) {
    case "sequence":
      return "runtime.next_id()";
    case "message":
      return `${variable(id.from)}["id"]`;
    case "id":
      return variable(id.from);
  }
}

function renderPayload(payload: Build["payload"]): string {
  switch (payload.kind) {
    case "example":
      return `runtime.example_payload(${pythonLiteral(payload.includeTestRunId)})`;
    case "literal":
      return pythonLiteral(payload.value);
    case "message":
      return `${variable(payload.from)}["payload"]`;
  }
}

function renderBranch(
  condition: string,
  assignment: string,
  transitions: Transitions,
): string[] {
  return [
    `if ${condition}:`,
    `    ${assignment}`,
    `    state = ${JSON.stringify(transitions.ok)}`,
    "else:",
    `    state = ${JSON.stringify(transitions.invalid)}`,
  ];
}

function renderOutcome(transitions: Transitions): string[] {
  return [
    "state = {",
    ...Object.entries(transitions).map(
      ([outcome, next]) =>
        `    ${JSON.stringify(outcome)}: ${JSON.stringify(next)},`,
    ),
    "}[outcome]",
  ];
}

function renderNode({ operation, transitions }: BehaviorNode): string[] {
  const next = `state = ${JSON.stringify(transitions.ok)}`;
  switch (operation.op) {
    case "build":
      return [
        `${variable(operation.to)} = {`,
        `    "id": ${renderId(operation.id)},`,
        `    "type": ${JSON.stringify(operation.messageType)},`,
        `    "payload": ${renderPayload(operation.payload)},`,
        "}",
        next,
      ];
    case "encode":
      return [
        `frame = encode(${variable(operation.from)})`,
        "if frame is INVALID:",
        '    runtime.log("PROTOCOL_ERROR")',
        "    return 1",
        `${variable(operation.to)} = frame`,
        next,
      ];
    case "decode":
      return [
        `decoded = decode(${variable(operation.from)})`,
        ...renderBranch(
          "decoded is not INVALID",
          `${variable(operation.to)} = decoded`,
          transitions,
        ),
      ];
    case "validate": {
      const source = variable(operation.from);
      const target = variable(operation.to);
      if (operation.check === "id") {
        return [
          `candidate_id = extract_id(${source})`,
          ...renderBranch(
            "candidate_id is not None",
            `${target} = candidate_id`,
            transitions,
          ),
        ];
      }
      const matches =
        operation.matchesIdOf === undefined
          ? ""
          : `, ${variable(operation.matchesIdOf)}["id"]`;
      const condition = `validate_message(${source}, ${pythonLiteral(operation.messageTypes)}${matches})`;
      return renderBranch(condition, `${target} = ${source}`, transitions);
    }
    case "send":
      return [
        `outcome = runtime.send(${variable(operation.from)})`,
        ...renderOutcome(transitions),
      ];
    case "receive":
      return [
        "outcome, frame = runtime.receive()",
        'if outcome == "ok":',
        `    ${variable(operation.to)} = frame`,
        ...renderOutcome(transitions),
      ];
    case "process":
      return [
        `${variable(operation.to)} = process_task(${variable(operation.from)})`,
        next,
      ];
    case "wait":
      return [
        `outcome = runtime.wait(${operation.milliseconds})`,
        ...renderOutcome(transitions),
      ];
    case "log": {
      const data = "from" in operation ? `, ${variable(operation.from)}` : "";
      return [`runtime.log(${JSON.stringify(operation.event)}${data})`, next];
    }
    case "stop":
      return [`return ${operation.exitCode}`];
  }
}

export function renderPythonApplication(application: ApplicationPlan): string {
  const { behavior, socketType, endpoint, options, lifecycle } = application;
  const subscription = lifecycle.startup.find(
    (step) => step.op === "apply-subscription",
  );
  const cases = behavior.nodes.flatMap((node) => [
    `            case ${JSON.stringify(node.id)}:`,
    ...renderNode(node).map((line) => `                ${line}`),
  ]);

  return [
    "#!/usr/bin/env python3",
    "from message_codec import INVALID, decode, encode, extract_id, validate_message, process_task",
    "from zmqt_runtime import run",
    "",
    "",
    "def behavior(runtime):",
    "    values = {}",
    `    state = ${JSON.stringify(behavior.entry)}`,
    "    while True:",
    "        match state:",
    ...cases,
    "",
    "",
    'if __name__ == "__main__":',
    "    raise SystemExit(run(",
    `        ${JSON.stringify(socketType)},`,
    `        ${JSON.stringify(endpoint.mode)},`,
    `        ${pythonLiteral(Object.keys(options))},`,
    `        ${pythonLiteral(subscription?.prefix ?? null)},`,
    "        behavior,",
    "    ))",
    "",
  ].join("\n");
}

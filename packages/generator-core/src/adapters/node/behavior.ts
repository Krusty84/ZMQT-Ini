/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import type {
  ApplicationPlan,
  BehaviorNode,
  BehaviorOperation,
} from "../../planning/ir";
import { roleComments } from "../../templates/shared/role-comments";
import { runtimeSocketOptionNames } from "../../topology/compiler";

type Build = Extract<BehaviorOperation, { op: "build" }>;
type Transitions = BehaviorNode["transitions"];

function variable(name: string): string {
  return `values[${JSON.stringify(name)}]`;
}

function renderId(id: Build["id"]): string {
  switch (id.kind) {
    case "sequence":
      return "runtime.nextId()";
    case "message":
      return `${variable(id.from)}.id`;
    case "id":
      return variable(id.from);
  }
}

function renderPayload(payload: Build["payload"]): string {
  switch (payload.kind) {
    case "example":
      return `runtime.examplePayload(${payload.includeTestRunId})`;
    case "literal":
      return `JSON.parse(${JSON.stringify(JSON.stringify(payload.value))})`;
    case "message":
      return `${variable(payload.from)}.payload`;
  }
}

function renderBranch(
  condition: string,
  assignment: string,
  transitions: Transitions,
): string[] {
  return [
    `if (${condition}) {`,
    `  ${assignment}`,
    `  state = ${JSON.stringify(transitions.ok)};`,
    "} else {",
    `  state = ${JSON.stringify(transitions.invalid)};`,
    "}",
  ];
}

function renderOutcome(transitions: Transitions): string[] {
  return [
    "state = {",
    ...Object.entries(transitions).map(
      ([outcome, target]) => `  ${outcome}: ${JSON.stringify(target)},`,
    ),
    "}[outcome];",
  ];
}

function renderNode({ operation, transitions }: BehaviorNode): string[] {
  const next = `state = ${JSON.stringify(transitions.ok)};`;
  switch (operation.op) {
    case "build":
      return [
        `${variable(operation.to)} = {`,
        `  id: ${renderId(operation.id)},`,
        `  type: ${JSON.stringify(operation.messageType)},`,
        `  payload: ${renderPayload(operation.payload)},`,
        "};",
        next,
      ];
    case "encode":
      return [
        `const frame = encode(${variable(operation.from)});`,
        "if (frame === INVALID) {",
        '  runtime.log("PROTOCOL_ERROR");',
        "  return 1;",
        "}",
        `${variable(operation.to)} = frame;`,
        next,
      ];
    case "decode":
      return [
        `const decoded = decode(${variable(operation.from)});`,
        ...renderBranch(
          "decoded !== INVALID",
          `${variable(operation.to)} = decoded;`,
          transitions,
        ),
      ];
    case "validate": {
      const source = variable(operation.from);
      const target = variable(operation.to);
      if (operation.check === "id") {
        return [
          `const candidateId = extractId(${source});`,
          ...renderBranch(
            "candidateId !== null",
            `${target} = candidateId;`,
            transitions,
          ),
        ];
      }
      const matches =
        operation.matchesIdOf === undefined
          ? ""
          : `, ${variable(operation.matchesIdOf)}.id`;
      const condition = `validateMessage(${source}, ${JSON.stringify(operation.messageTypes)}${matches})`;
      return renderBranch(condition, `${target} = ${source};`, transitions);
    }
    case "send":
      return [
        `const outcome = await runtime.send(${variable(operation.from)});`,
        ...renderOutcome(transitions),
      ];
    case "receive":
      return [
        "const [outcome, frame] = await runtime.receive();",
        'if (outcome === "ok") {',
        `  ${variable(operation.to)} = frame;`,
        "}",
        ...renderOutcome(transitions),
      ];
    case "process":
      return [
        `${variable(operation.to)} = processTask(${variable(operation.from)});`,
        next,
      ];
    case "wait":
      return [
        `const outcome = await runtime.wait(${operation.milliseconds});`,
        ...renderOutcome(transitions),
      ];
    case "log": {
      const data = "from" in operation ? `, ${variable(operation.from)}` : "";
      return [`runtime.log(${JSON.stringify(operation.event)}${data});`, next];
    }
    case "stop":
      return [`return ${operation.exitCode};`];
  }
}

export function renderNodeApplication(application: ApplicationPlan): string {
  const { behavior, socketType, endpoint, lifecycle } = application;
  const subscription = lifecycle.startup.find(
    (step) => step.op === "apply-subscription",
  );
  const comments = roleComments[socketType];
  const cases = behavior.nodes.flatMap((node) => [
    `      case ${JSON.stringify(node.id)}: {`,
    ...(comments[node.id] ?? []).map((line) => `        // ${line}`),
    ...renderNode(node).map((line) => `        ${line}`),
    ...(node.operation.op === "stop" ? [] : ["        break;"]),
    "      }",
  ]);

  return [
    "#!/usr/bin/env node",
    'import { INVALID, decode, encode, extractId, validateMessage, processTask } from "./message_codec.mjs";',
    'import { run } from "./zmqt_runtime.mjs";',
    "",
    "async function behavior(runtime) {",
    "  const values = Object.create(null);",
    `  let state = ${JSON.stringify(behavior.entry)};`,
    "  while (true) {",
    "    switch (state) {",
    ...cases,
    "    }",
    "  }",
    "}",
    "",
    "// Importing this file starts the role and sets process.exitCode when it finishes.",
    "// Move the run call into your application's startup code when you embed the role.",
    "process.exitCode = await run(",
    `  ${JSON.stringify(socketType)},`,
    `  ${JSON.stringify(endpoint.mode)},`,
    `  ${JSON.stringify(runtimeSocketOptionNames(application))},`,
    `  ${JSON.stringify(subscription?.prefix ?? null)},`,
    "  behavior,",
    ");",
    "",
  ].join("\n");
}

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

function slot(name: string): string {
  return `values.get(${JSON.stringify(name)})`;
}

function assign(name: string, expression: string): string {
  return `values.put(${JSON.stringify(name)}, ${expression});`;
}

function jsonValue(name: string): string {
  return `((JsonNode) ${slot(name)})`;
}

function messageId(name: string): string {
  return `${jsonValue(name)}.get("id").asString()`;
}

function renderId(id: Build["id"]): string {
  switch (id.kind) {
    case "sequence":
      return "runtime.nextId()";
    case "message":
      return messageId(id.from);
    case "id":
      return `(String) ${slot(id.from)}`;
  }
}

function renderPayload(payload: Build["payload"]): string {
  switch (payload.kind) {
    case "example":
      return `runtime.examplePayload(${payload.includeTestRunId})`;
    case "literal":
      return `MessageCodec.decodeText(${JSON.stringify(JSON.stringify(payload.value))})`;
    case "message":
      return `${jsonValue(payload.from)}.get("payload")`;
  }
}

function renderBranch(
  condition: string,
  assignment: string,
  transitions: Transitions,
): string[] {
  return [
    `if (${condition}) {`,
    `    ${assignment}`,
    `    state = ${JSON.stringify(transitions.ok)};`,
    "} else {",
    `    state = ${JSON.stringify(transitions.invalid)};`,
    "}",
  ];
}

function renderOutcome(expression: string, transitions: Transitions): string[] {
  return [
    `state = switch (${expression}) {`,
    ...Object.entries(transitions).map(
      ([outcome, next]) =>
        `    case ${JSON.stringify(outcome)} -> ${JSON.stringify(next)};`,
    ),
    '    default -> throw new IllegalStateException("Unexpected outcome");',
    "};",
  ];
}

function renderNode({ operation, transitions }: BehaviorNode): string[] {
  const next = `state = ${JSON.stringify(transitions.ok)};`;
  switch (operation.op) {
    case "build": {
      const message = `MessageCodec.message(${renderId(operation.id)}, ${JSON.stringify(operation.messageType)}, ${renderPayload(operation.payload)})`;
      return [assign(operation.to, message), next];
    }
    case "encode":
      return [
        `byte[] frame = MessageCodec.encode(${jsonValue(operation.from)});`,
        "if (frame == null) {",
        '    runtime.log("PROTOCOL_ERROR", null);',
        "    return 1;",
        "}",
        assign(operation.to, "frame"),
        next,
      ];
    case "decode":
      return [
        `JsonNode decoded = MessageCodec.decode((byte[]) ${slot(operation.from)});`,
        ...renderBranch(
          "decoded != null",
          assign(operation.to, "decoded"),
          transitions,
        ),
      ];
    case "validate": {
      const value = jsonValue(operation.from);
      if (operation.check === "id") {
        return [
          `String id = MessageCodec.extractId(${value});`,
          ...renderBranch(
            "id != null",
            assign(operation.to, "id"),
            transitions,
          ),
        ];
      }
      const types = operation.messageTypes
        .map((type) => JSON.stringify(type))
        .join(", ");
      const expectedId =
        operation.matchesIdOf === undefined
          ? "null"
          : messageId(operation.matchesIdOf);
      return renderBranch(
        `MessageCodec.validateMessage(${value}, List.of(${types}), ${expectedId})`,
        assign(operation.to, value),
        transitions,
      );
    }
    case "send":
      return renderOutcome(
        `runtime.send((byte[]) ${slot(operation.from)})`,
        transitions,
      );
    case "receive":
      return [
        "ZmqtRuntime.Received received = runtime.receive();",
        `if (received.outcome().equals("ok")) ${assign(operation.to, "received.frame()")}`,
        ...renderOutcome("received.outcome()", transitions),
      ];
    case "process":
      return [
        assign(
          operation.to,
          `MessageCodec.processTask(${jsonValue(operation.from)})`,
        ),
        next,
      ];
    case "wait":
      return renderOutcome(
        `runtime.waitFor(${operation.milliseconds})`,
        transitions,
      );
    case "log": {
      const data = "from" in operation ? jsonValue(operation.from) : "null";
      return [
        `runtime.log(${JSON.stringify(operation.event)}, ${data});`,
        next,
      ];
    }
    case "stop":
      return [`return ${operation.exitCode};`];
  }
}

export function renderJavaApplication(application: ApplicationPlan): string {
  const { behavior, endpoint, lifecycle, socketType } = application;
  const className = `App${socketType}`;
  const subscription = lifecycle.startup.find(
    (step) => step.op === "apply-subscription",
  );
  const optionsList = runtimeSocketOptionNames(application)
    .map((option) => JSON.stringify(option))
    .join(", ");
  const comments = roleComments[socketType];
  return [
    "import java.util.HashMap;",
    "import java.util.List;",
    "import java.util.Map;",
    "import org.zeromq.SocketType;",
    "import tools.jackson.databind.JsonNode;",
    "",
    `public final class ${className} {`,
    "    private static int behavior(ZmqtRuntime runtime) {",
    "        Map<String, Object> values = new HashMap<>();",
    `        String state = ${JSON.stringify(behavior.entry)};`,
    "        while (true) {",
    "            switch (state) {",
    ...behavior.nodes.flatMap((node) => [
      `                case ${JSON.stringify(node.id)} -> {`,
      ...(comments[node.id] ?? []).map((line) => `                    // ${line}`),
      ...renderNode(node).map((line) => `                    ${line}`),
      "                }",
    ]),
    '                default -> throw new IllegalStateException("Unknown state");',
    "            }",
    "        }",
    "    }",
    "",
    "    public static void main(String[] args) {",
    "        // Keep System.exit in the standalone entry point.",
    `        System.exit(ZmqtRuntime.run(args, SocketType.${socketType}, ${JSON.stringify(endpoint.mode)},`,
    `            List.of(${optionsList}), ${JSON.stringify(subscription?.prefix ?? null)}, ${className}::behavior));`,
    "    }",
    "}",
    "",
  ].join("\n");
}

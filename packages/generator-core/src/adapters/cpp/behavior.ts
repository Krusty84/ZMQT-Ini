/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import type {
  ApplicationPlan,
  BehaviorNode,
  BehaviorOperation,
} from "../../planning/ir";

type Build = Extract<BehaviorOperation, { op: "build" }>;
type Transitions = BehaviorNode["transitions"];

function string(value: string): string {
  return JSON.stringify(value);
}

function value(name: string): string {
  return `values.at(${string(name)})`;
}

function frame(name: string): string {
  return `frames.at(${string(name)})`;
}

function renderId(id: Build["id"]): string {
  switch (id.kind) {
    case "sequence":
      return "runtime.next_id()";
    case "message":
      return `${value(id.from)}.at("id")`;
    case "id":
      return value(id.from);
  }
}

function renderPayload(payload: Build["payload"]): string {
  switch (payload.kind) {
    case "example":
      return `runtime.example_payload(${payload.includeTestRunId})`;
    case "literal":
      return `Json::parse(${string(JSON.stringify(payload.value))})`;
    case "message":
      return `${value(payload.from)}.at("payload")`;
  }
}

function renderBranch(
  condition: string,
  assignment: string,
  transitions: Transitions,
): string[] {
  return [
    `if (${condition}) {`,
    `    ${assignment};`,
    `    state = ${string(transitions.ok!)};`,
    "} else {",
    `    state = ${string(transitions.invalid!)};`,
    "}",
  ];
}

function renderOutcome(transitions: Transitions): string[] {
  return [
    "switch (outcome) {",
    ...Object.entries(transitions).map(
      ([outcome, target]) =>
        `case Outcome::${outcome}: state = ${string(target)}; break;`,
    ),
    'default: throw std::logic_error("Invalid operation outcome");',
    "}",
  ];
}

function renderNode({ operation, transitions }: BehaviorNode): string[] {
  const next = () => `state = ${string(transitions.ok!)};`;
  switch (operation.op) {
    case "build":
      return [
        `values[${string(operation.to)}] = Json{`,
        `    {"id", ${renderId(operation.id)}},`,
        `    {"type", ${string(operation.messageType)}},`,
        `    {"payload", ${renderPayload(operation.payload)}},`,
        "};",
        next(),
      ];
    case "encode":
      return [
        `auto encoded = encode(${value(operation.from)});`,
        'if (!encoded) { runtime.log("PROTOCOL_ERROR"); return 1; }',
        `frames[${string(operation.to)}] = std::move(encoded);`,
        next(),
      ];
    case "decode":
      return [
        `auto decoded = decode(${frame(operation.from)});`,
        ...renderBranch(
          "decoded",
          `values[${string(operation.to)}] = std::move(*decoded)`,
          transitions,
        ),
      ];
    case "validate": {
      const source = value(operation.from);
      const target = `values[${string(operation.to)}]`;
      if (operation.check === "id") {
        return [
          `auto candidate_id = extract_id(${source});`,
          ...renderBranch(
            "candidate_id",
            `${target} = std::move(*candidate_id)`,
            transitions,
          ),
        ];
      }
      const types = `{${operation.messageTypes.map(string).join(", ")}}`;
      const match =
        operation.matchesIdOf === undefined
          ? ""
          : `, ${value(operation.matchesIdOf)}.at("id").get<std::string>()`;
      return renderBranch(
        `validate_message(${source}, ${types}${match})`,
        `${target} = ${source}`,
        transitions,
      );
    }
    case "send":
      return [
        `const auto outcome = runtime.send(${frame(operation.from)});`,
        ...renderOutcome(transitions),
      ];
    case "receive":
      return [
        "auto [outcome, received] = runtime.receive();",
        `if (outcome == Outcome::ok) frames[${string(operation.to)}] = std::move(received);`,
        ...renderOutcome(transitions),
      ];
    case "process":
      return [
        `values[${string(operation.to)}] = process_task(${value(operation.from)});`,
        next(),
      ];
    case "wait":
      return [
        `const auto outcome = runtime.wait(${operation.milliseconds});`,
        ...renderOutcome(transitions),
      ];
    case "log": {
      const data = "from" in operation ? `, ${value(operation.from)}` : "";
      return [`runtime.log(${string(operation.event)}${data});`, next()];
    }
    case "stop":
      return [`return ${operation.exitCode};`];
  }
}

export function renderCppApplication(application: ApplicationPlan): string {
  const { behavior, socketType, endpoint, options, lifecycle } = application;
  const subscription = lifecycle.startup.find(
    (step) => step.op === "apply-subscription",
  );
  const cases = behavior.nodes.flatMap((node) => [
    `        if (state == ${string(node.id)}) {`,
    ...renderNode(node).map((line) => `            ${line}`),
    ...(node.operation.op === "stop" ? [] : ["            continue;"]),
    "        }",
  ]);

  return [
    '#include "zmqt_runtime.hpp"',
    "",
    "#include <map>",
    "#include <stdexcept>",
    "#include <utility>",
    "",
    "using namespace zmqt;",
    "",
    "namespace {",
    "",
    "int behavior(Runtime& runtime) {",
    "    std::map<std::string, Json> values;",
    "    std::map<std::string, Frame> frames;",
    `    std::string_view state = ${string(behavior.entry)};`,
    "    for (;;) {",
    ...cases,
    '        throw std::logic_error("Invalid behavior state");',
    "    }",
    "}",
    "",
    "} // namespace",
    "",
    "int main(int argc, char* argv[]) {",
    `    return run(argc, argv, zmq::socket_type::${socketType.toLowerCase()}, ${endpoint.mode === "bind"},`,
    `               {${Object.keys(options).map(string).join(", ")}}, ${subscription ? string(subscription.prefix) : "std::nullopt"}, behavior);`,
    "}",
    "",
  ].join("\n");
}
